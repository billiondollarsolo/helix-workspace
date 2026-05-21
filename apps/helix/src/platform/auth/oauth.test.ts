import fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  InMemoryOAuthClientStore,
  OAuthError,
  OAuthTokenService,
  detectHashAlgorithm,
  hashSecret,
  hashSecretScrypt,
  parseScope,
  verifySecret,
  verifySecretWithRehash,
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

    const service = new OAuthTokenService({ clientStore: store, tokenStore: store, tokenTtlSeconds: 60 });
    const response = await service.issueClientCredentialsToken({
      grantType: "client_credentials",
      clientId: "client-1",
      clientSecret: "secret",
      scope: "tools:read",
    });

    expect(response.token_type).toBe("Bearer");
    expect(response.expires_in).toBe(60);
    expect(response.scope).toBe("tools:read");
    await expect(store.findToken(response.access_token)).resolves.toMatchObject({ actorId: "actor-1" });
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
      tokenService: new OAuthTokenService({ clientStore: store, tokenStore: store, tokenTtlSeconds: 120 }),
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
    expect(detectHashAlgorithm(hash)).toBe("argon2id");
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

  it("verifies legacy scrypt hashes for backward compatibility", async () => {
    const legacy = await hashSecretScrypt("legacy-secret");
    expect(legacy.startsWith("scrypt$")).toBe(true);
    expect(detectHashAlgorithm(legacy)).toBe("scrypt");
    expect(await verifySecret("legacy-secret", legacy)).toBe(true);
    expect(await verifySecret("nope", legacy)).toBe(false);
  });

  it("rejects malformed or unknown hash formats", async () => {
    expect(detectHashAlgorithm("garbage")).toBe("unknown");
    expect(await verifySecret("x", "garbage")).toBe(false);
    expect(await verifySecret("x", "scrypt$only-salt")).toBe(false);
  });

  it("re-hashes legacy scrypt secrets to argon2id on successful verification", async () => {
    const legacy = await hashSecretScrypt("migrate-me");
    const result = await verifySecretWithRehash("migrate-me", legacy);
    expect(result.valid).toBe(true);
    expect(result.rehashedSecretHash).not.toBeNull();
    expect(result.rehashedSecretHash?.startsWith("$argon2id$")).toBe(true);
    expect(await verifySecret("migrate-me", result.rehashedSecretHash ?? "")).toBe(true);
  });

  it("does not re-hash argon2id secrets and does not re-hash on failure", async () => {
    const current = await hashSecret("already-modern");
    const ok = await verifySecretWithRehash("already-modern", current);
    expect(ok.valid).toBe(true);
    expect(ok.rehashedSecretHash).toBeNull();

    const legacy = await hashSecretScrypt("legacy");
    const bad = await verifySecretWithRehash("wrong", legacy);
    expect(bad.valid).toBe(false);
    expect(bad.rehashedSecretHash).toBeNull();
  });

  it("transparently upgrades a scrypt-hashed client to argon2id on token issuance", async () => {
    const store = new InMemoryOAuthClientStore();
    await store.createClient({
      clientId: "legacy-client",
      clientSecretHash: await hashSecretScrypt("legacy-secret"),
      actorId: "actor-1",
      orgId: "org-1",
      scopes: ["tools:read"],
    });

    const service = new OAuthTokenService({ clientStore: store, tokenStore: store });
    await service.issueClientCredentialsToken({
      grantType: "client_credentials",
      clientId: "legacy-client",
      clientSecret: "legacy-secret",
    });

    const upgraded = await store.findClient("legacy-client");
    expect(upgraded?.clientSecretHash.startsWith("$argon2id$")).toBe(true);
    // The secret still verifies after the transparent upgrade.
    await expect(
      service.issueClientCredentialsToken({
        grantType: "client_credentials",
        clientId: "legacy-client",
        clientSecret: "legacy-secret",
      }),
    ).resolves.toMatchObject({ token_type: "Bearer" });
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
    return { store, service: new OAuthTokenService({ clientStore: store, tokenStore: store }) };
  }

  it("revokes an access token so it no longer introspects as active", async () => {
    const { service } = await seededService();
    const issued = await service.issueClientCredentialsToken({
      grantType: "client_credentials",
      clientId: "client-1",
      clientSecret: "secret",
      scope: "tools:read",
    });

    const before = await service.introspectToken(issued.access_token);
    expect(before).toMatchObject({ active: true, scope: "tools:read", client_id: "client-1" });

    await service.revokeToken(issued.access_token);
    const after = await service.introspectToken(issued.access_token);
    expect(after).toEqual({ active: false });
  });

  it("treats revocation of unknown tokens as a success (idempotent)", async () => {
    const { service } = await seededService();
    await expect(service.revokeToken("helix_at_nonexistent")).resolves.toBeUndefined();
  });

  it("introspects an unknown token as inactive", async () => {
    const { service } = await seededService();
    expect(await service.introspectToken("helix_at_unknown")).toEqual({ active: false });
    expect(await service.introspectToken("")).toEqual({ active: false });
  });

  it("serves /oauth/revoke and /oauth/introspect with client authentication", async () => {
    const { service } = await seededService();
    const app = fastify();
    await registerOAuthRoutes(app, { tokenService: service });

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

  it("rejects revoke/introspect without valid client authentication", async () => {
    const { service } = await seededService();
    const app = fastify();
    await registerOAuthRoutes(app, { tokenService: service });

    const noAuth = await app.inject({
      method: "POST",
      url: "/oauth/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ token: "anything" }).toString(),
    });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json()).toMatchObject({ error: "invalid_client" });

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
