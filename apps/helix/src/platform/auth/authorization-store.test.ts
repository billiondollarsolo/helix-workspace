import { describe, expect, it } from "vitest";
import { createRecordingSql as sharedRecordingSql } from "../../test-support/recording-sql.js";
import {
  InMemoryOAuthAuthorizationStore,
  PostgresOAuthAuthorizationStore,
  type OAuthConsentNonce,
} from "./authorization-store.js";

const nonce: OAuthConsentNonce = {
  nonceHash: "nonce-hash",
  clientId: "client-1",
  actorId: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  expiresAt: new Date("2030-01-01T00:05:00.000Z"),
};

describe("OAuth authorization state", () => {
  it("enforces approval, one-time consent, and durable grant semantics in memory", async () => {
    const store = new InMemoryOAuthAuthorizationStore();
    expect(await store.isClientApproved(nonce.orgId, nonce.clientId)).toBe(false);
    store.approveClient(nonce.orgId, nonce.clientId);
    expect(await store.isClientApproved(nonce.orgId, nonce.clientId)).toBe(true);

    await store.saveConsentNonce(nonce);
    await expect(
      store.consumeConsentNonce(nonce, new Date("2030-01-01T00:01:00.000Z")),
    ).resolves.toBe(true);
    await expect(
      store.consumeConsentNonce(nonce, new Date("2030-01-01T00:01:01.000Z")),
    ).resolves.toBe(false);

    await store.recordGrant({ ...nonce, scopes: ["mail.read", "mail.read"] });
    expect(store.findGrant(nonce.orgId, nonce.actorId, nonce.clientId)).toMatchObject({
      scopes: ["mail.read"],
    });
  });

  it("uses tenant-scoped PostgreSQL approval, atomic nonce consumption, and grant upsert", async () => {
    const recording = recordingSql([
      [{ approved: true }],
      [],
      [{ nonce_hash: nonce.nonceHash }],
      [],
    ]);
    const store = new PostgresOAuthAuthorizationStore(recording.sql);

    await expect(store.isClientApproved(nonce.orgId, nonce.clientId)).resolves.toBe(true);
    await store.saveConsentNonce(nonce);
    await expect(
      store.consumeConsentNonce(nonce, new Date("2030-01-01T00:01:00.000Z")),
    ).resolves.toBe(true);
    await store.recordGrant({ ...nonce, scopes: ["mail.read"] });

    expect(recording.calls[0]).toContain("from admin_oauth_apps");
    expect(recording.calls[0]).toContain("status = 'approved'");
    expect(recording.calls[2]).toContain("consumed_at is null");
    expect(recording.calls[3]).toContain("on conflict (org_id, actor_id, client_id)");
  });
});
function recordingSql(responses: readonly unknown[]) {
  const recording = sharedRecordingSql(responses, "$");
  return {
    sql: recording.sql,
    get calls() {
      return recording.queries;
    },
    get values() {
      return recording.values;
    },
  };
}
