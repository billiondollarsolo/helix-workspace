import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  PostgresAgentCredentialStore,
  PostgresAuthorizationCodeStore,
} from "./postgres-store.js";
import { hashApiKey } from "./credentials.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const queue = [...responses];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$"), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  const sql = Object.assign(tag, {
    array: <T extends readonly unknown[]>(value: T) => value,
    unsafe: (text: string) => text,
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

describe("PostgresAgentCredentialStore", () => {
  it("resolves an api_key credential with its policy fields", async () => {
    const recording = createRecordingSql([
      [
        {
          id: "cred-1",
          credential_type: "api_key",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["mail.read"],
          client_id: null,
          secret_hash: null,
          api_key_hash: hashApiKey("helix_ak_test"),
          cert_fingerprint: null,
          label: "CI key",
          ip_allowlist: ["10.0.0.0/8"],
          allowed_hours: { startHour: 9, endHour: 17 },
          confirmation_override: "always",
          rate_limit_overrides: { requestsPerMinute: 5 },
          expires_at: null,
          revoked_at: null,
        },
      ],
    ]);
    const store = new PostgresAgentCredentialStore(recording.sql);
    const credential = await store.findByApiKeyHash(hashApiKey("helix_ak_test"));

    expect(credential).not.toBeNull();
    expect(credential?.credentialType).toBe("api_key");
    expect(credential?.policy.ipAllowlist).toEqual(["10.0.0.0/8"]);
    expect(credential?.policy.allowedHours).toEqual({ startHour: 9, endHour: 17 });
    expect(credential?.policy.confirmationOverride).toBe("always");
    expect(credential?.policy.rateLimitOverrides).toEqual({ requestsPerMinute: 5 });
    expect(recording.calls[0]?.text).toContain("credential_type = 'api_key'");
    expect(recording.calls[0]?.values).toContain(hashApiKey("helix_ak_test"));
  });

  it("resolves an mtls_cert credential by fingerprint", async () => {
    const recording = createRecordingSql([
      [
        {
          id: "cred-2",
          credential_type: "mtls_cert",
          actor_id: "actor-2",
          org_id: "org-1",
          scopes: ["chat.read"],
          client_id: null,
          secret_hash: null,
          api_key_hash: null,
          cert_fingerprint: "aabbcc",
          label: null,
          ip_allowlist: null,
          allowed_hours: null,
          confirmation_override: null,
          rate_limit_overrides: {},
          expires_at: null,
          revoked_at: null,
        },
      ],
    ]);
    const store = new PostgresAgentCredentialStore(recording.sql);
    const credential = await store.findByCertFingerprint("aabbcc");

    expect(credential?.credentialType).toBe("mtls_cert");
    expect(credential?.certFingerprint).toBe("aabbcc");
    expect(credential?.policy.ipAllowlist).toEqual([]);
    expect(credential?.policy.confirmationOverride).toBe("inherit");
    expect(recording.calls[0]?.text).toContain("credential_type = 'mtls_cert'");
  });

  it("returns null when no credential matches", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresAgentCredentialStore(recording.sql);
    await expect(store.findByApiKeyHash("missing")).resolves.toBeNull();
  });
});

describe("PostgresAuthorizationCodeStore", () => {
  it("inserts an authorization code by its hash", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresAuthorizationCodeStore(recording.sql);
    const issuedAt = new Date("2026-05-21T10:00:00.000Z");
    await store.saveCode({
      codeHash: "code-hash",
      clientId: "client-1",
      actorId: "actor-1",
      orgId: "org-1",
      redirectUri: "https://app.example.com/cb",
      scopes: ["mail.read"],
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      state: "state-1",
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 60_000),
      consumedAt: null,
    });
    expect(recording.calls[0]?.text).toContain("insert into oauth_authorization_codes");
    expect(recording.calls[0]?.values).toContain("code-hash");
  });

  it("consumes a code in a single statement and returns the row", async () => {
    const issuedAt = new Date("2026-05-21T10:00:00.000Z");
    const expiresAt = new Date(issuedAt.getTime() + 60_000);
    const consumedAt = new Date("2026-05-21T10:00:30.000Z");
    const recording = createRecordingSql([
      [
        {
          code_hash: "code-hash",
          client_id: "client-1",
          actor_id: "actor-1",
          org_id: "org-1",
          redirect_uri: "https://app.example.com/cb",
          scopes: ["mail.read"],
          code_challenge: "challenge",
          code_challenge_method: "S256",
          state: "state-1",
          issued_at: issuedAt,
          expires_at: expiresAt,
          consumed_at: consumedAt,
        },
      ],
    ]);
    const store = new PostgresAuthorizationCodeStore(recording.sql);
    const record = await store.consumeCode("code-hash", consumedAt);

    expect(record).not.toBeNull();
    expect(record?.actorId).toBe("actor-1");
    expect(recording.calls[0]?.text).toContain("update oauth_authorization_codes");
    expect(recording.calls[0]?.text).toContain("consumed_at is null");
  });

  it("returns null when the code was already consumed or expired", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresAuthorizationCodeStore(recording.sql);
    await expect(store.consumeCode("code-hash", new Date())).resolves.toBeNull();
  });
});
