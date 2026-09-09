import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  actorFromRequestWithAccessTokenAndSession,
  bearerTokenFromRequest,
  credentialPolicyOf,
  resolveCredentialAuthenticatedActor,
  untrustedIdentityHeader,
} from "./actor.js";
import {
  createApiKeyMaterial,
  type AgentCredentialRecord,
  type AgentCredentialStore,
  EMPTY_CREDENTIAL_POLICY,
} from "../platform/auth/credentials.js";

describe("bearerTokenFromRequest", () => {
  it("reads bearer tokens from Authorization headers", () => {
    expect(bearerTokenFromRequest(requestWith({ authorization: "Bearer header-token" }, {}))).toBe(
      "header-token",
    );
  });

  it("rejects bearer tokens in query params", () => {
    expect(
      bearerTokenFromRequest(requestWith({}, { access_token: "query-token" })),
    ).toBeUndefined();
  });

  it("uses Authorization headers even when a query token is present", () => {
    expect(
      bearerTokenFromRequest(
        requestWith({ authorization: "Bearer header-token" }, { access_token: "query-token" }),
      ),
    ).toBe("header-token");
  });
});

describe("untrustedIdentityHeader", () => {
  it("detects every former client-asserted authentication fact", () => {
    for (const name of [
      "x-helix-actor-id",
      "x-helix-actor-type",
      "x-helix-org-id",
      "x-helix-scopes",
      "x-helix-mfa-verified",
      "x-helix-client-cert-fingerprint",
    ]) {
      expect(untrustedIdentityHeader({ [name]: "forged" })).toBe(name);
    }
    expect(untrustedIdentityHeader({ authorization: "Bearer legitimate" })).toBeUndefined();
  });
});

describe("actorFromRequestWithAccessTokenAndSession", () => {
  it("uses bearer token auth before first-party session auth", async () => {
    const actor = await actorFromRequestWithAccessTokenAndSession(
      requestWith({ authorization: "Bearer token-1" }, {}),
      {
        async saveToken() {},
        async findToken() {
          return {
            token: "token-1",
            clientId: "client-1",
            actorId: "agent-1",
            orgId: "org-1",
            scopes: ["mail.read"],
            issuedAt: new Date("2026-05-20T00:00:00.000Z"),
            expiresAt: new Date("2026-05-20T01:00:00.000Z"),
            actorType: "agent",
          };
        },
      },
      {
        async resolve() {
          return {
            id: "user-1",
            orgId: "org-1",
            type: "user",
            displayName: "User",
          };
        },
      },
    );

    expect(actor).toMatchObject({ id: "agent-1", type: "agent", scopes: ["mail.read"] });
  });

  it("uses first-party session auth and ignores spoofed actor headers", async () => {
    const actor = await actorFromRequestWithAccessTokenAndSession(
      requestWith(
        {
          "x-helix-actor-id": "header-user",
          "x-helix-org-id": "header-org",
        },
        {},
      ),
      {
        async saveToken() {},
        async findToken() {
          return null;
        },
      },
      {
        async resolve() {
          return {
            id: "session-user",
            orgId: "session-org",
            type: "user",
            displayName: "Session User",
          };
        },
      },
    );

    expect(actor).toMatchObject({ id: "session-user", orgId: "session-org", type: "user" });
  });

  it("drops all authority when a stored access token contains an unknown permission", async () => {
    const actor = await actorFromRequestWithAccessTokenAndSession(
      requestWith({ authorization: "Bearer token-1" }, {}),
      {
        async saveToken() {},
        async findToken() {
          return {
            token: "token-1",
            clientId: "client-1",
            actorId: "agent-1",
            orgId: "org-1",
            scopes: ["mail.read", "invented.admin"],
            issuedAt: new Date("2026-05-20T00:00:00.000Z"),
            expiresAt: new Date("2026-05-20T01:00:00.000Z"),
          };
        },
      },
    );

    expect(actor.scopes).toEqual([]);
  });

  it("returns the unauthenticated actor when only identity headers are supplied", async () => {
    const actor = await actorFromRequestWithAccessTokenAndSession(
      requestWith(
        {
          "x-helix-actor-id": "attacker",
          "x-helix-actor-type": "service_account",
          "x-helix-org-id": "victim-org",
          "x-helix-scopes": "admin.* drive.delete",
        },
        {},
      ),
      {
        async saveToken() {},
        async findToken() {
          return null;
        },
      },
    );

    expect(actor).toMatchObject({ id: "anonymous", scopes: [] });
  });
});

describe("resolveCredentialAuthenticatedActor", () => {
  function agentCredential(overrides: Partial<AgentCredentialRecord>): AgentCredentialRecord {
    return {
      id: "cred-1",
      credentialType: "api_key",
      actorId: "agent-7",
      orgId: "org-1",
      scopes: ["mail.read"],
      clientId: null,
      secretHash: null,
      apiKeyHash: null,
      certFingerprint: null,
      label: null,
      policy: EMPTY_CREDENTIAL_POLICY,
      expiresAt: null,
      revokedAt: null,
      ...overrides,
    };
  }

  function storeWith(records: readonly AgentCredentialRecord[]): AgentCredentialStore {
    return {
      async findByApiKeyHash(hash) {
        return records.find((r) => r.apiKeyHash === hash) ?? null;
      },
      async findByCertFingerprint(fingerprint) {
        return records.find((r) => r.certFingerprint === fingerprint) ?? null;
      },
    };
  }

  it("returns null when no API key or certificate is presented", async () => {
    const result = await resolveCredentialAuthenticatedActor(requestWith({}, {}), storeWith([]));
    expect(result).toBeNull();
  });

  it("authenticates an API key from the Authorization header and attaches its policy", async () => {
    const { apiKey, apiKeyHash } = createApiKeyMaterial();
    const store = storeWith([
      agentCredential({
        apiKeyHash,
        policy: { ...EMPTY_CREDENTIAL_POLICY, confirmationOverride: "always" },
      }),
    ]);
    const result = await resolveCredentialAuthenticatedActor(
      requestWith({ authorization: `Bearer ${apiKey}` }, {}),
      store,
    );
    expect(result?.ok).toBe(true);
    if (result?.ok === true) {
      expect(result.actor).toMatchObject({ id: "agent-7", type: "agent" });
      expect(credentialPolicyOf(result.actor)?.confirmationOverride).toBe("always");
    }
  });

  it("authenticates an API key from the x-api-key header", async () => {
    const { apiKey, apiKeyHash } = createApiKeyMaterial();
    const result = await resolveCredentialAuthenticatedActor(
      requestWith({ "x-api-key": apiKey }, {}),
      storeWith([agentCredential({ apiKeyHash })]),
    );
    expect(result?.ok).toBe(true);
  });

  it("drops all authority when an API key record contains an unknown permission", async () => {
    const { apiKey, apiKeyHash } = createApiKeyMaterial();
    const result = await resolveCredentialAuthenticatedActor(
      requestWith({ "x-api-key": apiKey }, {}),
      storeWith([agentCredential({ apiKeyHash, scopes: ["mail.read", "invented.admin"] })]),
    );
    expect(result).toMatchObject({ ok: true, actor: { scopes: [] } });
  });

  it("rejects an unknown API key", async () => {
    const { apiKey } = createApiKeyMaterial();
    const result = await resolveCredentialAuthenticatedActor(
      requestWith({ authorization: `Bearer ${apiKey}` }, {}),
      storeWith([]),
    );
    expect(result).toMatchObject({ ok: false, statusCode: 401 });
  });

  it("rejects an API key request from an IP outside the credential allowlist", async () => {
    const { apiKey, apiKeyHash } = createApiKeyMaterial();
    const store = storeWith([
      agentCredential({
        apiKeyHash,
        policy: { ...EMPTY_CREDENTIAL_POLICY, ipAllowlist: ["10.0.0.0/8"] },
      }),
    ]);
    const request = {
      headers: { authorization: `Bearer ${apiKey}` },
      query: {},
      ip: "8.8.8.8",
    } as FastifyRequest;
    const result = await resolveCredentialAuthenticatedActor(request, store);
    expect(result).toMatchObject({ ok: false, statusCode: 403, code: "ip_not_allowed" });
  });

  it("authenticates the fingerprint of a verified TLS peer certificate", async () => {
    const certificate = Buffer.from("registered peer certificate");
    const fingerprint = createHash("sha256").update(certificate).digest("hex");
    const store = storeWith([
      agentCredential({ credentialType: "mtls_cert", certFingerprint: fingerprint }),
    ]);
    const result = await resolveCredentialAuthenticatedActor(
      requestWithPeerCertificate(certificate),
      store,
    );
    expect(result?.ok).toBe(true);
  });

  it("rejects a public fingerprint header without a verified TLS peer", async () => {
    const result = await resolveCredentialAuthenticatedActor(
      requestWith({ "x-helix-client-cert-fingerprint": "deadbeef" }, {}),
      storeWith([agentCredential({ credentialType: "mtls_cert", certFingerprint: "deadbeef" })]),
    );
    expect(result).toMatchObject({ ok: false, statusCode: 401, code: "invalid_certificate" });
  });

  it("rejects an unregistered verified peer certificate", async () => {
    const result = await resolveCredentialAuthenticatedActor(
      requestWithPeerCertificate(Buffer.from("unknown peer certificate")),
      storeWith([]),
    );
    expect(result).toMatchObject({ ok: false, statusCode: 401, code: "invalid_certificate" });
  });
});

function requestWith(
  headers: Record<string, string>,
  query: Record<string, unknown>,
): FastifyRequest {
  return { headers, query, raw: { socket: new Socket() } } as unknown as FastifyRequest;
}

function requestWithPeerCertificate(raw: Buffer): FastifyRequest {
  const socket = new TLSSocket(new Socket());
  Object.defineProperty(socket, "authorized", { value: true });
  vi.spyOn(socket, "getPeerCertificate").mockReturnValue({
    raw,
  } as ReturnType<TLSSocket["getPeerCertificate"]>);
  return {
    headers: {},
    query: {},
    raw: { socket },
  } as unknown as FastifyRequest;
}
