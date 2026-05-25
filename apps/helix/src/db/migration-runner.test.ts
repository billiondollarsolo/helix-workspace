import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("platform foundation migration", () => {
  it("declares every Phase -1 platform table", async () => {
    const sql = await readFile(
      new URL("./migrations/0000_platform_foundation.sql", import.meta.url),
      "utf8",
    );

    for (const table of [
      "actors",
      "objects",
      "threads",
      "messages",
      "message_attachments",
      "permissions",
      "activity",
      "outbox",
      "ai_artifacts",
      "memory_items",
      "pending_actions",
      "app_passwords",
      "platform_config",
      "installed_plugins",
      "agent_credentials",
    ]) {
      expect(sql).toContain(`create table if not exists ${table}`);
    }
  });

  it("declares the persistent OAuth access-token table", async () => {
    const sql = await readFile(
      new URL("./migrations/0001_oauth_credentials_store.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create table if not exists oauth_access_tokens");
  });

  it("declares pending action trace and execution result columns", async () => {
    const foundationSql = await readFile(
      new URL("./migrations/0000_platform_foundation.sql", import.meta.url),
      "utf8",
    );
    const migrationSql = await readFile(
      new URL("./migrations/0012_pending_action_results.sql", import.meta.url),
      "utf8",
    );

    for (const column of ["trace_id text", "result jsonb", "error text"]) {
      expect(foundationSql).toContain(column);
      expect(migrationSql).toContain(column);
    }
  });

  it("declares outbound delivery metadata columns", async () => {
    const baseSql = await readFile(
      new URL("./migrations/0005_mail_plugin.sql", import.meta.url),
      "utf8",
    );
    const migrationSql = await readFile(
      new URL("./migrations/0016_mail_outbound_delivery_metadata.sql", import.meta.url),
      "utf8",
    );

    for (const sql of [baseSql, migrationSql]) {
      expect(sql).toContain("provider_message_id text");
      expect(sql).toContain("delivery_metadata jsonb not null default '{}'::jsonb");
      expect(sql).toContain("mail_outbound_provider_message_idx");
    }
  });

  it("declares the Phase 0 webhook foundation tables", async () => {
    const sql = await readFile(
      new URL("./migrations/0002_webhooks_foundation.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create type webhook_delivery_status");
    expect(sql).toContain("create type webhook_direction");
    for (const table of ["outbound_webhooks", "inbound_webhooks", "webhook_deliveries"]) {
      expect(sql).toContain(`create table if not exists ${table}`);
    }
  });

  it("declares the Phase 4 Drive plugin tables", async () => {
    const sql = await readFile(
      new URL("./migrations/0007_drive_plugin.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create table if not exists drive_folders");
    expect(sql).toContain("create table if not exists drive_versions");
    expect(sql).toContain("references objects(id)");
  });
  it("declares durable Slides operation log storage with tenant isolation", async () => {
    const sql = await readFile(
      new URL("./migrations/0049_slides_op_log.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create table if not exists slides_op_log");
    expect(sql).toContain("deck_id uuid not null references slide_decks(id) on delete cascade");
    expect(sql).toContain("operation_id text not null");
    expect(sql).toContain("create unique index if not exists slides_op_log_deck_revision_idx");
    expect(sql).toContain("create unique index if not exists slides_op_log_deck_operation_idx");
    expect(sql).toContain("alter table slides_op_log enable row level security");
    expect(sql).toContain("create policy helix_tenant_isolation on slides_op_log");
  });
});
