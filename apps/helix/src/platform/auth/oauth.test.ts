import fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  hashSecret,
  InMemoryOAuthClientStore,
  OAuthError,
  OAuthTokenService,
  parseScope,
  verifySecret,
  type OAuthTokenResponse,
} from "./oauth.js";
import { registerOAuthRoutes } from "./routes.js";

describe("OAuth client credentials", () => {
  it("deduplicates and validates requested scopes", () => {
    expect(parseScope("tools:read tools:read tools:write")).toEqual(["tools:read", "tools:write"]);
    expect(() => parseScope("tools:read bad scope")).not.toThrow();
    expect(() => parseScope("bad\nscope")).toThrow(OAuthError);
  });

  it("issues bearer tokens only for allowed scopes", async () => {
    const store = new InMemoryOAuthClientStore();
    await store.createClient({
      clientId: "client-1",
      clientSecretHash: await hashSecret("secret"),
      actorId: "actor-1",
      orgId: "org-1",
      scopes: ["tools:read", "tools:write"],
    });

    const service = new OAuthTokenService({
      clientStore: store,
      tokenStore: store,
      issuer: "urn:helix:test",
      tokenTtlSeconds: 60,
    });
    const response = await service.issueClientCredentialsToken({
      grantType: "client_credentials",
      clientId: "client-1",
      clientSecret: "secret",
      scope: "tools:read",
    });

    expect(response.token_type).toBe("Bearer");
    expect(response.expires_in).toBe(60);
    expect(response.scope).toBe("tools:read");
    await expect(store.findToken(response.access_token)).resolves.toMatchObject({
      actorId: "actor-1",
    });
  });

  it("serves /oauth/token with Basic client authentication and form encoding", async () => {
    const store = new InMemoryOAuthClientStore();
    await store.createClient({
      clientId: "client-1",
      clientSecretHash: await hashSecret("secret"),
      actorId: "actor-1",
      orgId: "org-1",
      scopes: ["tools:read"],
    });

    const app = fastify();
    await registerOAuthRoutes(app, {
      issuer: "https://helix.example.test",
      clientStore: store,
      tokenService: new OAuthTokenService({
        clientStore: store,
        tokenStore: store,
        issuer: "urn:helix:test",
        tokenTtlSeconds: 120,
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: {
        authorization: `Basic ${Buffer.from("client-1:secret").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "tools:read",
      }).toString(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      token_type: "Bearer",
      expires_in: 120,
      scope: "tools:read",
    });
  });
});

describe("client secret hashing (argon2id)", () => {
  it("hashes new secrets with argon2id and verifies them", async () => {
    const hash = await hashSecret("super-secret");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifySecret("super-secret", hash)).toBe(true);
    expect(await verifySecret("wrong-secret", hash)).toBe(false);
  });

  it("produces a distinct hash per call (random salt)", async () => {
    const first = await hashSecret("repeated");
    const second = await hashSecret("repeated");
    expect(first).not.toBe(second);
    expect(await verifySecret("repeated", first)).toBe(true);
    expect(await verifySecret("repeated", second)).toBe(true);
  });

  it("rejects every non-Argon2id hash format", async () => {
    expect(await verifySecret("x", "garbage")).toBe(false);
    expect(await verifySecret("x", "scrypt$salt$hash")).toBe(false);
    expect(await verifySecret("x", "$argon2i$v=19$m=19456,t=2,p=1$bad$bad")).toBe(false);
  });
});

describe("authorization-code tenant binding", () => {
  it("refuses a code whose subject belongs to another tenant", async () => {
    const store = new InMemoryOAuthClientStore();
    await store.createClient({
      clientId: "tenant-a-client",
      clientSecretHash: "",
      actorId: "client-owner",
      orgId: "tenant-a",
      scopes: ["mail.read"],
    });
    const service = new OAuthTokenService({
      clientStore: store,
      tokenStore: store,
      issuer: "urn:helix:test",
      authorizationCodeService: {
        redeemCode: async () => ({
          clientId: "tenant-a-client",
          actorId: "tenant-b-user",
          orgId: "tenant-b",
          scopes: ["mail.read"],
        }),
      },
    });

    await expect(
      service.issueAuthorizationCodeToken({
        grantType: "authorization_code",
        clientId: "tenant-a-client",
        code: "forged-code",
        redirectUri: "https://app.example.test/callback",
        codeVerifier: "a".repeat(43),
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("authorization-code refresh lifecycle", () => {
  async function seedClient(
    store: InMemoryOAuthClientStore,
    clientId: string,
    clientSecretHash = "",
  ): Promise<void> {
    await store.createClient({
      clientId,
      clientSecretHash,
      actorId: `${clientId}-owner`,
      orgId: "org-1",
      scopes: ["mail.read", "mail.write"],
    });
  }

  function serviceFor(store: InMemoryOAuthClientStore): OAuthTokenService {
    return new OAuthTokenService({
      clientStore: store,
      tokenStore: store,
      issuer: "urn:helix:test",
      authorizationCodeService: {
        redeemCode: async (input) => ({
          clientId: input.clientId,
          actorId: "user-1",
          orgId: "org-1",
          scopes: ["mail.read", "mail.write"],
        }),
      },
    });
  }

  async function issueAuthorizationTokens(
    service: OAuthTokenService,
    clientId: string,
    clientSecret?: string,
  ): Promise<OAuthTokenResponse> {
    return service.issueAuthorizationCodeToken({
      grantType: "authorization_code",
      clientId,
      ...(clientSecret === undefined ? {} : { clientSecret }),
      code: `code-for-${clientId}`,
      redirectUri: "https://app.example.test/callback",
      codeVerifier: "v".repeat(43),
    });
  }

  it("issues and rotates a refresh token while allowing scope reduction", async () => {
    const store = new InMemoryOAuthClientStore();
    await seedClient(store, "client-1");
    const service = serviceFor(store);
    const issued = await issueAuthorizationTokens(service, "client-1");
    const refreshToken = issued.refresh_token;
    if (refreshToken === undefined) {
      throw new Error("Authorization code exchange did not issue a refresh token.");
    }

    await expect(
      service.issueRefreshToken({
        grantType: "refresh_token",
        clientId: "client-1",
        refreshToken,
        scope: "mail.read admin.all",
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });

    const rotated = await service.issueRefreshToken({
      grantType: "refresh_token",
      clientId: "client-1",
      refreshToken,
      scope: "mail.read",
    });

    expect(rotated.refresh_token).toMatch(/^helix_rt_/u);
    expect(rotated.refresh_token).not.toBe(refreshToken);
    expect(rotated.scope).toBe("mail.read");
    await expect(
      service.introspectToken({ token: refreshToken, clientId: "client-1" }),
    ).resolves.toEqual({ active: false });
    await expect(
      service.introspectToken({ token: rotated.access_token, clientId: "client-1" }),
    ).resolves.toMatchObject({ active: true, scope: "mail.read" });
  });

  it("detects refresh replay and atomically revokes the whole token family", async () => {
    const store = new InMemoryOAuthClientStore();
    await seedClient(store, "client-1");
    const service = serviceFor(store);
    const issued = await issueAuthorizationTokens(service, "client-1");
    const firstRefresh = issued.refresh_token;
    if (firstRefresh === undefined) {
      throw new Error("Authorization code exchange did not issue a refresh token.");
    }
    const rotated = await service.issueRefreshToken({
      grantType: "refresh_token",
      clientId: "client-1",
      refreshToken: firstRefresh,
    });
    const secondRefresh = rotated.refresh_token;
    if (secondRefresh === undefined) {
      throw new Error("Refresh rotation did not issue a replacement token.");
    }

    await expect(
      service.issueRefreshToken({
        grantType: "refresh_token",
        clientId: "client-1",
        refreshToken: firstRefresh,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(
      service.introspectToken({ token: rotated.access_token, clientId: "client-1" }),
    ).resolves.toEqual({ active: false });
    await expect(
      service.introspectToken({ token: secondRefresh, clientId: "client-1" }),
    ).resolves.toEqual({ active: false });
  });

  it("does not disclose, revoke, or replay-detect another client's tokens", async () => {
    const store = new InMemoryOAuthClientStore();
    await seedClient(store, "client-a");
    await seedClient(store, "client-b");
    const service = serviceFor(store);
    const issued = await issueAuthorizationTokens(service, "client-a");
    const refreshToken = issued.refresh_token;
    if (refreshToken === undefined) {
      throw new Error("Authorization code exchange did not issue a refresh token.");
    }

    await expect(
      service.introspectToken({ token: issued.access_token, clientId: "client-b" }),
    ).resolves.toEqual({ active: false });
    await expect(
      service.introspectToken({ token: refreshToken, clientId: "client-b" }),
    ).resolves.toEqual({ active: false });
    await service.revokeToken({ token: issued.access_token, clientId: "client-b" });
    await service.revokeToken({
      token: refreshToken,
      clientId: "client-b",
      tokenTypeHint: "refresh_token",
    });
    await expect(
      service.issueRefreshToken({
        grantType: "refresh_token",
        clientId: "client-b",
        refreshToken,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(
      service.introspectToken({ token: issued.access_token, clientId: "client-a" }),
    ).resolves.toMatchObject({ active: true });
    await expect(
      service.introspectToken({ token: refreshToken, clientId: "client-a" }),
    ).resolves.toMatchObject({ active: true });
  });

  it("invalidates access and refresh tokens on client secret rotation and revocation", async () => {
    const store = new InMemoryOAuthClientStore();
    await seedClient(store, "client-1", await hashSecret("old-secret"));
    const service = serviceFor(store);
    const issued = await issueAuthorizationTokens(service, "client-1", "old-secret");
    const refreshToken = issued.refresh_token;
    if (refreshToken === undefined) {
      throw new Error("Authorization code exchange did not issue a refresh token.");
    }

    await store.rotateClientSecret("client-1", await hashSecret("new-secret"));
    await expect(store.findToken(issued.access_token)).resolves.toBeNull();
    await expect(
      service.issueRefreshToken({
        grantType: "refresh_token",
        clientId: "client-1",
        clientSecret: "new-secret",
        refreshToken,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    const fresh = await service.issueClientCredentialsToken({
      grantType: "client_credentials",
      clientId: "client-1",
      clientSecret: "new-secret",
    });
    await store.revokeClient("client-1", new Date());
    await expect(store.findToken(fresh.access_token)).resolves.toBeNull();
  });
});

describe("token revocation and introspection", () => {
  async function seededService(): Promise<{
    store: InMemoryOAuthClientStore;
    service: OAuthTokenService;
  }> {
    const store = new InMemoryOAuthClientStore();
    await store.createClient({
      clientId: "client-1",
      clientSecretHash: await hashSecret("secret"),
      actorId: "actor-1",
      orgId: "org-1",
      scopes: ["tools:read", "tools:write"],
    });
    return {
      store,
      service: new OAuthTokenService({
        clientStore: store,
        tokenStore: store,
        issuer: "urn:helix:test",
      }),
    };
  }

  it("revokes an access token so it no longer introspects as active", async () => {
    const { service } = await seededService();
    const issued = await service.issueClientCredentialsToken({
      grantType: "client_credentials",
      clientId: "client-1",
      clientSecret: "secret",
      scope: "tools:read",
    });

    const before = await service.introspectToken({
      token: issued.access_token,
      clientId: "client-1",
    });
    expect(before).toMatchObject({ active: true, scope: "tools:read", client_id: "client-1" });

    await service.revokeToken({ token: issued.access_token, clientId: "client-1" });
    const after = await service.introspectToken({
      token: issued.access_token,
      clientId: "client-1",
    });
    expect(after).toEqual({ active: false });
  });

  it("treats revocation of unknown tokens as a success (idempotent)", async () => {
    const { service } = await seededService();
    await expect(
      service.revokeToken({ token: "helix_at_nonexistent", clientId: "client-1" }),
    ).resolves.toBeUndefined();
  });

  it("introspects an unknown token as inactive", async () => {
    const { service } = await seededService();
    expect(
      await service.introspectToken({ token: "helix_at_unknown", clientId: "client-1" }),
    ).toEqual({ active: false });
    expect(await service.introspectToken({ token: "", clientId: "client-1" })).toEqual({
      active: false,
    });
  });

  it("serves /oauth/revoke and /oauth/introspect with client authentication", async () => {
    const { store, service } = await seededService();
    const app = fastify();
    await registerOAuthRoutes(app, {
      issuer: "https://helix.example.test",
      clientStore: store,
      tokenService: service,
    });

    const issued = await service.issueClientCredentialsToken({
      grantType: "client_credentials",
      clientId: "client-1",
      clientSecret: "secret",
      scope: "tools:write",
    });
    const basic = `Basic ${Buffer.from("client-1:secret").toString("base64")}`;

    const introspectActive = await app.inject({
      method: "POST",
      url: "/oauth/introspect",
      headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ token: issued.access_token }).toString(),
    });
    expect(introspectActive.statusCode).toBe(200);
    expect(introspectActive.json()).toMatchObject({
      active: true,
      client_id: "client-1",
      scope: "tools:write",
    });

    const revoke = await app.inject({
      method: "POST",
      url: "/oauth/revoke",
      headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ token: issued.access_token }).toString(),
    });
    expect(revoke.statusCode).toBe(200);

    const introspectRevoked = await app.inject({
      method: "POST",
      url: "/oauth/introspect",
      headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ token: issued.access_token }).toString(),
    });
    expect(introspectRevoked.json()).toEqual({ active: false });
  });

  it("lets a public client manage only its own tokens with client_id", async () => {
    const store = new InMemoryOAuthClientStore();
    await store.createClient({
      clientId: "public-client",
      clientSecretHash: "",
      actorId: "owner-1",
      orgId: "org-1",
      scopes: ["mail.read"],
    });
    const service = new OAuthTokenService({
      clientStore: store,
      tokenStore: store,
      issuer: "urn:helix:test",
      authorizationCodeService: {
        redeemCode: async () => ({
          clientId: "public-client",
          actorId: "user-1",
          orgId: "org-1",
          scopes: ["mail.read"],
        }),
      },
    });
    const issued = await issuePublicAuthorizationCode(service);
    const app = fastify();
    await registerOAuthRoutes(app, {
      issuer: "https://helix.example.test",
      clientStore: store,
      tokenService: service,
    });
    const form = (token: string) =>
      new URLSearchParams({ client_id: "public-client", token }).toString();

    const introspect = await app.inject({
      method: "POST",
      url: "/oauth/introspect",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form(issued.access_token),
    });
    expect(introspect.statusCode).toBe(200);
    expect(introspect.json()).toMatchObject({ active: true, client_id: "public-client" });

    const revoke = await app.inject({
      method: "POST",
      url: "/oauth/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form(issued.access_token),
    });
    expect(revoke.statusCode).toBe(200);
    await expect(
      service.introspectToken({ token: issued.access_token, clientId: "public-client" }),
    ).resolves.toEqual({ active: false });
  });

  it("rejects revoke/introspect without valid client authentication", async () => {
    const { store, service } = await seededService();
    const app = fastify();
    await registerOAuthRoutes(app, {
      issuer: "https://helix.example.test",
      clientStore: store,
      tokenService: service,
    });

    const noAuth = await app.inject({
      method: "POST",
      url: "/oauth/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ token: "anything" }).toString(),
    });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json()).toMatchObject({ error: "invalid_client" });

    const missingConfidentialSecret = await app.inject({
      method: "POST",
      url: "/oauth/introspect",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ client_id: "client-1", token: "anything" }).toString(),
    });
    expect(missingConfidentialSecret.statusCode).toBe(401);
    expect(missingConfidentialSecret.json()).toMatchObject({ error: "invalid_client" });

    const badSecret = await app.inject({
      method: "POST",
      url: "/oauth/introspect",
      headers: {
        authorization: `Basic ${Buffer.from("client-1:wrong").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ token: "anything" }).toString(),
    });
    expect(badSecret.statusCode).toBe(401);
    expect(badSecret.json()).toMatchObject({ error: "invalid_client" });
  });
});

function issuePublicAuthorizationCode(service: OAuthTokenService): Promise<OAuthTokenResponse> {
  return service.issueAuthorizationCodeToken({
    grantType: "authorization_code",
    clientId: "public-client",
    code: "public-code",
    redirectUri: "https://app.example.test/callback",
    codeVerifier: "v".repeat(43),
  });
}
