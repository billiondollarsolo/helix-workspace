import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("./0079_mail_provider_routing_events.sql", import.meta.url);
const rollbackUrl = new URL("./rollbacks/0079_mail_provider_routing_events.sql", import.meta.url);

describe("0079 mail provider routing and delivery events migration", () => {
  it("persists stable provider decisions and durable org-scoped event idempotency", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("provider_decided_at timestamptz");
    expect(sql).toContain("webhook_secret_ref text");
    expect(sql).toContain("create table if not exists mail_provider_delivery_events");
    expect(sql).toMatch(
      /mail_provider_delivery_events_idempotency_idx[\s\S]+org_id, provider_id, provider_event_id/u,
    );
    expect(sql).toContain("create table if not exists mail_suppressions");
    expect(sql).toMatch(
      /mail_suppressions_org_recipient_active_idx[\s\S]+org_id, normalized_recipient/u,
    );
  });

  it("enforces tenant matching and RLS for events and suppressions", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("mail_provider_event_outbound_same_org");
    expect(sql).toContain("mail_suppression_event_same_org");
    expect(sql).toContain("alter table mail_provider_delivery_events enable row level security");
    expect(sql).toContain("alter table mail_suppressions enable row level security");
    expect(sql).not.toContain("raw_payload");
  });

  it("ships a guarded rollback", async () => {
    const sql = await readFile(rollbackUrl, "utf8");
    expect(sql).toContain("refusing 0079 rollback");
    expect(sql).toContain("drop table if exists mail_suppressions");
    expect(sql).toContain("drop table if exists mail_provider_delivery_events");
  });
});
