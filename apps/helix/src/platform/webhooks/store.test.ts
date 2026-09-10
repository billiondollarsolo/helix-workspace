import { describe, expect, it } from "vitest";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import { TenantEnvelopeCipher } from "../secrets/envelope.js";
import { OutboundWebhookQuotaExceededError, PostgresWebhookStore } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const secrets = new TenantEnvelopeCipher("webhook-test-master-key-at-least-32-bytes");

describe("PostgresWebhookStore", () => {
  it("blocks outbound webhook creation when outbound_webhooks_limit is reached", async () => {
    const recording = createRecordingSql([quotaRow({ limit: 2, used: "2" })]);
    const store = new PostgresWebhookStore(recording.sql, secrets);

    await expect(store.createOutbound(createOutboundInput())).rejects.toThrow(
      OutboundWebhookQuotaExceededError,
    );

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("o.quotas ? 'outbound_webhooks_limit'");
    expect(recording.calls[0]?.text).toContain("p.quotas_default ? 'outbound_webhooks_limit'");
    expect(recording.calls[0]?.text).toContain("for update of o");
    expect(recording.calls[0]?.text).toContain("from outbound_webhooks wh");
    expect(recording.calls[0]?.text).toContain("wh.deleted_at is null");
    expect(recording.calls[0]?.text).not.toContain("insert into outbound_webhooks");
  });

  it("treats JSON null outbound_webhooks_limit as unlimited", async () => {
    const recording = createRecordingSql([
      quotaRow({ limit: null, used: "999" }),
      [outboundWebhookRow()],
    ]);
    const store = new PostgresWebhookStore(recording.sql, secrets);

    await expect(store.createOutbound(createOutboundInput())).resolves.toMatchObject({
      orgId,
      name: "Deployments",
      url: "https://example.com/webhook",
    });

    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[1]?.text).toContain("insert into outbound_webhooks");
  });

  it("allows creation below limit and resolves org override before plan default", async () => {
    const recording = createRecordingSql([
      quotaRow({ limit: 3, used: 2 }),
      [outboundWebhookRow({ id: "33333333-3333-4333-8333-333333333333" })],
    ]);
    const store = new PostgresWebhookStore(recording.sql, secrets);

    await expect(store.createOutbound(createOutboundInput())).resolves.toMatchObject({
      id: "33333333-3333-4333-8333-333333333333",
    });

    const quotaSql = recording.calls[0]?.text ?? "";
    expect(quotaSql.indexOf("o.quotas ? 'outbound_webhooks_limit'")).toBeGreaterThanOrEqual(0);
    expect(quotaSql.indexOf("p.quotas_default ? 'outbound_webhooks_limit'")).toBeGreaterThan(
      quotaSql.indexOf("o.quotas ? 'outbound_webhooks_limit'"),
    );
    expect(recording.calls[1]?.text).toContain("insert into outbound_webhooks");
  });

  it("persists a tenant-bound envelope instead of the webhook secret", async () => {
    const plaintext = "webhook-test-secret-at-least-32-bytes";
    const recording = createRecordingSql([
      quotaRow({ limit: null, used: 0 }),
      [outboundWebhookRow()],
    ]);
    const store = new PostgresWebhookStore(recording.sql, secrets);

    await store.createOutbound(createOutboundInput());

    const insertedValues = recording.calls[1]?.values ?? [];
    const ciphertext = insertedValues.find(
      (value): value is string => typeof value === "string" && value.startsWith("helix$1$"),
    );
    expect(insertedValues).not.toContain(plaintext);
    expect(ciphertext).toBeDefined();
    expect(secrets.open(orgId, "webhook", ciphertext ?? "")).toBe(plaintext);
  });

  it("rejects credentials hidden in webhook headers or metadata", async () => {
    const recording = createRecordingSql([]);
    const store = new PostgresWebhookStore(recording.sql, secrets);

    await expect(
      store.createOutbound({
        ...createOutboundInput(),
        headers: { authorization: "Bearer directly-usable-secret" },
      }),
    ).rejects.toThrow("encrypted webhook secret");
    await expect(
      store.createOutbound({
        ...createOutboundInput(),
        metadata: { nested: { accessKeyId: "directly-usable-key" } },
      }),
    ).rejects.toThrow("plaintext credential fields");
    expect(recording.calls).toEqual([]);
  });
});

function createOutboundInput() {
  return {
    orgId,
    name: "Deployments",
    url: "https://example.com/webhook",
    eventSubjects: ["deploy.created"],
    secret: "webhook-test-secret-at-least-32-bytes",
    headers: { "x-source": "helix" },
    enabled: true,
    metadata: { source: "test" },
    createdByActorId: actorId,
  };
}

function quotaRow(input: {
  readonly limit: number | null;
  readonly used: string | number;
}): readonly Record<string, unknown>[] {
  return [
    {
      outbound_webhooks_limit: input.limit,
      active_outbound_webhook_count: input.used,
    },
  ];
}

function outboundWebhookRow(input: { readonly id?: string } = {}): Record<string, unknown> {
  return {
    id: input.id ?? "33333333-3333-4333-8333-333333333333",
    org_id: orgId,
    name: "Deployments",
    url: "https://example.com/webhook",
    event_subjects: ["deploy.created"],
    secret_ciphertext: secrets.seal(orgId, "webhook", "webhook-test-secret-at-least-32-bytes"),
    headers: { "x-source": "helix" },
    enabled: true,
    metadata: { source: "test" },
    created_by_actor_id: actorId,
    created_at: new Date("2026-05-24T12:00:00.000Z"),
    updated_at: new Date("2026-05-24T12:00:00.000Z"),
  };
}
