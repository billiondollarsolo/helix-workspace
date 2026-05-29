import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { OutboundWebhookQuotaExceededError, PostgresWebhookStore } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";

describe("PostgresWebhookStore", () => {
  it("blocks outbound webhook creation when outbound_webhooks_limit is reached", async () => {
    const recording = createRecordingSql([quotaRow({ limit: 2, used: "2" })]);
    const store = new PostgresWebhookStore(recording.sql);

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
    const store = new PostgresWebhookStore(recording.sql);

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
    const store = new PostgresWebhookStore(recording.sql);

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
});

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(responses: readonly unknown[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  let callIndex = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return Promise.resolve(responses[callIndex++] ?? []);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    begin: async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      callback(sql as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

function createOutboundInput() {
  return {
    orgId,
    name: "Deployments",
    url: "https://example.com/webhook",
    eventSubjects: ["deploy.created"],
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

function outboundWebhookRow(
  input: { readonly id?: string } = {},
): Record<string, unknown> {
  return {
    id: input.id ?? "33333333-3333-4333-8333-333333333333",
    org_id: orgId,
    name: "Deployments",
    url: "https://example.com/webhook",
    event_subjects: ["deploy.created"],
    secret_ref: "inline:test",
    headers: { "x-source": "helix" },
    enabled: true,
    metadata: { source: "test" },
    created_by_actor_id: actorId,
    created_at: new Date("2026-05-24T12:00:00.000Z"),
    updated_at: new Date("2026-05-24T12:00:00.000Z"),
  };
}
