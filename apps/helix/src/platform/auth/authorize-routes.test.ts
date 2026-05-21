import { createHash, randomBytes } from "node:crypto";
import fastify, { type FastifyInstance } from "fastify";
import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import {
  AuthorizationCodeService,
  InMemoryAuthorizationCodeStore,
} from "./authorization-code.js";
import { InMemoryOAuthClientStore, OAuthTokenService, hashSecret } from "./oauth.js";
import { registerOAuthRoutes, type OAuthAuthorizeActorResolver } from "./routes.js";

function pkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const testActor: Actor = {
  id: "actor-1",
  orgId: "org-1",
  type: "user",
  displayName: "Test User",
};

async function buildApp(options: {
  readonly clientSecretHash?: string;
  readonly actorResolver?: OAuthAuthorizeActorResolver;
  readonly consentPagePath?: string;
}): Promise<{
  readonly app: FastifyInstance;
  readonly codeStore: InMemoryAuthorizationCodeStore;
}> {
  const clientStore = new InMemoryOAuthClientStore();
  await clientStore.createClient({
    clientId: "client-1",
    clientSecretHash: options.clientSecretHash ?? "",
    actorId: "actor-1",
    orgId: "org-1",
    scopes: ["mail.read", "chat.read"],
  });
  const codeStore = new InMemoryAuthorizationCodeStore();
  const authorizationCodeService = new AuthorizationCodeService({ codeStore });
  const tokenService = new OAuthTokenService({
    clientStore,
    tokenStore: clientStore,
    authorizationCodeService,
    tokenTtlSeconds: 120,
  });
  const app = fastify();
  await registerOAuthRoutes(app, {
    tokenService,
    authorizationCodeService,
    ...(options.actorResolver === undefined ? {} : { actorResolver: options.actorResolver }),
    ...(options.consentPagePath === undefined ? {} : { consentPagePath: options.consentPagePath }),
  });
  return { app, codeStore };
}

const resolverFor = (actor: Actor | null): OAuthAuthorizeActorResolver => ({
  resolve: async () => actor,
});

const authorizeQuery = (challenge: string): Record<string, string> => ({
  response_type: "code",
  client_id: "client-1",
  redirect_uri: "https://app.example.com/callback",
  code_challenge: challenge,
  code_challenge_method: "S256",
  scope: "mail.read chat.read",
  state: "state-123",
});

describe("GET /oauth/authorize", () => {
  it("renders the built-in consent screen for an authenticated user", async () => {
    const { challenge } = pkcePair();
    const { app } = await buildApp({ actorResolver: resolverFor(testActor) });
    const response = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: authorizeQuery(challenge),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Authorize access");
    expect(response.body).toContain("mail.read");
  });

  it("redirects to a custom consent page when configured", async () => {
    const { challenge } = pkcePair();
    const { app } = await buildApp({
      actorResolver: resolverFor(testActor),
      consentPagePath: "/oauth/consent",
    });
    const response = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: authorizeQuery(challenge),
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("/oauth/consent?");
    expect(response.headers.location).toContain("code_challenge=");
  });

  it("requires a logged-in user", async () => {
    const { challenge } = pkcePair();
    const { app } = await buildApp({ actorResolver: resolverFor(null) });
    const response = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: authorizeQuery(challenge),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an invalid code_challenge", async () => {
    const { app } = await buildApp({ actorResolver: resolverFor(testActor) });
    const response = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: { ...authorizeQuery("short"), code_challenge: "short" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ readonly error: string }>().error).toBe("invalid_request");
  });
});

describe("POST /oauth/authorize + authorization_code grant", () => {
  it("completes the full PKCE happy path for a public client", async () => {
    const { verifier, challenge } = pkcePair();
    const { app } = await buildApp({ actorResolver: resolverFor(testActor) });

    const approve = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ ...authorizeQuery(challenge), decision: "approve" }).toString(),
    });
    expect(approve.statusCode).toBe(302);
    const redirect = new URL(approve.headers.location as string);
    expect(redirect.searchParams.get("state")).toBe("state-123");
    const code = redirect.searchParams.get("code");
    expect(code).not.toBeNull();

    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "client-1",
        code: code as string,
        redirect_uri: "https://app.example.com/callback",
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.statusCode).toBe(200);
    expect(token.json()).toMatchObject({
      token_type: "Bearer",
      expires_in: 120,
      scope: "mail.read chat.read",
    });
  });

  it("rejects token exchange with a tampered code_verifier", async () => {
    const { challenge } = pkcePair();
    const { app } = await buildApp({ actorResolver: resolverFor(testActor) });
    const approve = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ ...authorizeQuery(challenge), decision: "approve" }).toString(),
    });
    const code = new URL(approve.headers.location as string).searchParams.get("code") as string;

    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "client-1",
        code,
        redirect_uri: "https://app.example.com/callback",
        code_verifier: randomBytes(48).toString("base64url"),
      }).toString(),
    });
    expect(token.statusCode).toBe(400);
    expect(token.json<{ readonly error: string }>().error).toBe("invalid_grant");
  });

  it("rejects reusing an authorization code", async () => {
    const { verifier, challenge } = pkcePair();
    const { app } = await buildApp({ actorResolver: resolverFor(testActor) });
    const approve = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ ...authorizeQuery(challenge), decision: "approve" }).toString(),
    });
    const code = new URL(approve.headers.location as string).searchParams.get("code") as string;
    const exchange = () =>
      app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "client-1",
          code,
          redirect_uri: "https://app.example.com/callback",
          code_verifier: verifier,
        }).toString(),
      });
    expect((await exchange()).statusCode).toBe(200);
    expect((await exchange()).statusCode).toBe(400);
  });

  it("requires the client secret for a confidential client", async () => {
    const { verifier, challenge } = pkcePair();
    const { app } = await buildApp({
      actorResolver: resolverFor(testActor),
      clientSecretHash: await hashSecret("client-secret"),
    });
    const approve = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ ...authorizeQuery(challenge), decision: "approve" }).toString(),
    });
    const code = new URL(approve.headers.location as string).searchParams.get("code") as string;

    const withoutSecret = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "client-1",
        code,
        redirect_uri: "https://app.example.com/callback",
        code_verifier: verifier,
      }).toString(),
    });
    expect(withoutSecret.statusCode).toBe(401);

    const withSecret = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from("client-1:client-secret").toString("base64")}`,
      },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://app.example.com/callback",
        code_verifier: verifier,
      }).toString(),
    });
    expect(withSecret.statusCode).toBe(200);
  });

  it("redirects with access_denied when the user denies consent", async () => {
    const { challenge } = pkcePair();
    const { app } = await buildApp({ actorResolver: resolverFor(testActor) });
    const response = await app.inject({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ ...authorizeQuery(challenge), decision: "deny" }).toString(),
    });
    expect(response.statusCode).toBe(302);
    const redirect = new URL(response.headers.location as string);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("state-123");
  });
});
