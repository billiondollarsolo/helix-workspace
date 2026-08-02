import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  actorFromRequestWithAccessTokenAndSession,
  bearerTokenFromRequest,
  credentialPolicyOf,
  resolveCredentialAuthenticatedPrincipal,
  toolInvocationPrincipalFromRequest,
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

  it("falls back to access_token query params for websocket clients", () => {
    expect(bearerTokenFromRequest(requestWith({}, { access_token: "query-token" }))).toBe(
      "query-token",
    );
  });

  it("prefers Authorization headers over access_token query params", () => {
    expect(
      bearerTokenFromRequest(
        requestWith({ authorization: "Bearer header-token" }, { access_token: "query-token" }),
      ),
    ).toBe("header-token");
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

  it("uses first-party session auth before trusted header fallback", async () => {
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
});

describe("resolveCredentialAuthenticatedPrincipal", () => {
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
      async findByClientId(clientId) {
        return records.find((r) => r.clientId === clientId) ?? null;
      },
    };
  }

  it("returns null when no API key or certificate is presented", async () => {
    const result = await resolveCredentialAuthenticatedPrincipal(
      requestWith({}, {}),
      storeWith([]),
    );
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
    const result = await resolveCredentialAuthenticatedPrincipal(
      requestWith({ authorization: `Bearer ${apiKey}` }, {}),
      store,
    );
    expect(result?.ok).toBe(true);
    if (result?.ok === true) {
      expect(result.principal.actor).toMatchObject({ id: "agent-7", type: "agent" });
      expect(result.principal.credentialId).toBe("cred-1");
      expect(credentialPolicyOf(result.principal.actor)?.confirmationOverride).toBe("always");
      expect(JSON.stringify(result.principal)).not.toContain("confirmationOverride");
      expect(JSON.stringify(result.principal)).not.toContain("cred-1");
    }
  });

  it("authenticates an API key from the x-api-key header", async () => {
    const { apiKey, apiKeyHash } = createApiKeyMaterial();
    const result = await resolveCredentialAuthenticatedPrincipal(
      requestWith({ "x-api-key": apiKey }, {}),
      storeWith([agentCredential({ apiKeyHash })]),
    );
    expect(result?.ok).toBe(true);
  });

  it("rejects an unknown API key", async () => {
    const { apiKey } = createApiKeyMaterial();
    const result = await resolveCredentialAuthenticatedPrincipal(
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
    const result = await resolveCredentialAuthenticatedPrincipal(request, store);
    expect(result).toMatchObject({ ok: false, statusCode: 403, code: "ip_not_allowed" });
  });

  it("rejects an expired agent API key at principal resolution", async () => {
    const { apiKey, apiKeyHash } = createApiKeyMaterial();
    const result = await resolveCredentialAuthenticatedPrincipal(
      requestWith({ authorization: `Bearer ${apiKey}` }, {}),
      storeWith([
        agentCredential({
          apiKeyHash,
          expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        }),
      ]),
    );
    expect(result).toMatchObject({ ok: false, statusCode: 403, code: "credential_expired" });
  });

  it("rejects an API key request outside the credential allowed-hours window", async () => {
    const { apiKey, apiKeyHash } = createApiKeyMaterial();
    // days: [99] never matches 0–6, so wall-clock principal resolution always denies.
    const denied = await resolveCredentialAuthenticatedPrincipal(
      requestWith({ authorization: `Bearer ${apiKey}` }, {}),
      storeWith([
        agentCredential({
          apiKeyHash,
          policy: {
            ...EMPTY_CREDENTIAL_POLICY,
            allowedHours: {
              startHour: 0,
              endHour: 23,
              timeZone: "UTC",
              days: [99],
            },
          },
        }),
      ]),
    );
    expect(denied).toMatchObject({ ok: false, statusCode: 403, code: "outside_allowed_hours" });
  });

  it("authenticates an mTLS certificate fingerprint", async () => {
    const store = storeWith([
      agentCredential({ credentialType: "mtls_cert", certFingerprint: "aabbcc" }),
    ]);
    const result = await resolveCredentialAuthenticatedPrincipal(
      requestWith({ "x-helix-client-cert-fingerprint": "AA:BB:CC" }, {}),
      store,
    );
    expect(result?.ok).toBe(true);
  });

  it("rejects an unregistered client certificate", async () => {
    const result = await resolveCredentialAuthenticatedPrincipal(
      requestWith({ "x-helix-client-cert-fingerprint": "deadbeef" }, {}),
      storeWith([]),
    );
    expect(result).toMatchObject({ ok: false, statusCode: 401, code: "invalid_certificate" });
  });

  it.each(["agent", "user", "service_account"] as const)(
    "re-evaluates an OAuth credential after access-token issuance for %s actors",
    async (actorType) => {
      const credential = agentCredential({
        credentialType: "oauth_client",
        clientId: "client-1",
        policy: {
          ...EMPTY_CREDENTIAL_POLICY,
          confirmationOverride: "always",
          rateLimitOverrides: { requestsPerMinute: 1 },
        },
      });
      let active = true;
      const store = storeWith([credential]);
      const credentialStore: AgentCredentialStore = {
        ...store,
        async findByClientId(clientId) {
          return active && clientId === "client-1" ? credential : null;
        },
      };
      const tokenStore = {
        async saveToken() {},
        async findToken() {
          return {
            token: "token-1",
            clientId: "client-1",
            actorId: "agent-7",
            orgId: "org-1",
            actorType,
            scopes: ["mail.read"],
            issuedAt: new Date("2026-07-28T00:00:00.000Z"),
            expiresAt: new Date("2026-07-28T01:00:00.000Z"),
          };
        },
      };
      const request = requestWith({ authorization: "Bearer token-1" }, {});

      const resolved = await toolInvocationPrincipalFromRequest(
        request,
        tokenStore,
        undefined,
        credentialStore,
      );
      expect(resolved).toMatchObject({
        ok: true,
        principal: {
          credentialId: "cred-1",
          credentialPolicy: {
            confirmationOverride: "always",
            rateLimitOverrides: { requestsPerMinute: 1 },
          },
        },
      });

      active = false;
      await expect(
        toolInvocationPrincipalFromRequest(request, tokenStore, undefined, credentialStore),
      ).resolves.toMatchObject({
        ok: false,
        statusCode: 403,
        code: "credential_revoked",
      });
    },
  );
});

function requestWith(
  headers: Record<string, string>,
  query: Record<string, unknown>,
): FastifyRequest {
  return { headers, query } as FastifyRequest;
}
