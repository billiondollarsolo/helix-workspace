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

  it("declares the durable Drive upload state and leased scan queue", async () => {
    const sql = await readFile(
      new URL("./migrations/0076_drive_upload_state.sql", import.meta.url),
      "utf8",
    );
    const rollback = await readFile(
      new URL("./migrations/rollbacks/0076_drive_upload_state.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create type drive_upload_state");
    expect(sql).toContain("add column if not exists upload_state");
    expect(sql).toContain("create table if not exists drive_scan_jobs");
    expect(sql).toContain("lease_expires_at timestamptz");
    expect(sql).toContain("constraint drive_scan_jobs_version_unique unique (version_id)");
    expect(sql).toContain("message_attachments_require_active_object");
    expect(sql).toContain("upload_state = 'active'");
    expect(rollback).toContain("refusing 0076 rollback");
    expect(rollback).toContain("where deleted_at is null");
    expect(rollback).toContain("drop table if exists drive_scan_jobs");
  });

  it("installs tenant RLS policies for all public tables with org_id", async () => {
    const sql = await readFile(
      new URL("./migrations/0033_tenant_rls_foundation.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create or replace function helix_current_org_id()");
    expect(sql).toContain("current_setting('helix.org_id', true)");
    expect(sql).toContain("join pg_attribute");
    expect(sql).toContain("a.attname = 'org_id'");
    expect(sql).toContain("alter table %s enable row level security");
    expect(sql).toContain("create policy helix_tenant_isolation");
    expect(sql).toContain("with check (org_id = helix_current_org_id())");
    expect(sql).not.toContain("force row level security");
  });

  it("adds the provisioning org lifecycle status", async () => {
    const sql = await readFile(
      new URL("./migrations/0034_org_provisioning_status.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("alter type org_status add value if not exists 'provisioning'");
  });

  it("declares durable tenant provisioning workflow state", async () => {
    const sql = await readFile(
      new URL("./migrations/0035_tenant_provisioning_state.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create table if not exists tenant_provisioning_state");
    expect(sql).toContain("org_id uuid primary key references orgs(id) on delete cascade");
    expect(sql).toContain("requested_owner_email text not null");
    expect(sql).toContain("completed_steps text[] not null default '{}'");
    expect(sql).toContain("tenant_provisioning_state_status_idx");
  });

  it("declares durable signup email verification state", async () => {
    const sql = await readFile(
      new URL("./migrations/0036_signup_email_verifications.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create table if not exists signup_email_verifications");
    expect(sql).toContain("org_id uuid primary key references orgs(id) on delete cascade");
    expect(sql).toContain("password_hash text not null");
    expect(sql).toContain("token_hash text not null unique");
    expect(sql).toContain("consumed_at timestamptz");
    expect(sql).toContain("signup_email_verifications_token_hash_idx");
  });

  it("declares metering events, rollups, and tenant isolation", async () => {
    const sql = await readFile(
      new URL("./migrations/0037_metering_events_rollups.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create table if not exists metering_events");
    expect(sql).toContain("org_id uuid not null references orgs(id) on delete cascade");
    expect(sql).toContain("quantity numeric not null");
    expect(sql).toContain("metering_events_org_time_idx");
    expect(sql).toContain("where rolled_up_at is null");
    expect(sql).toContain("create table if not exists metering_rollups");
    expect(sql).toContain("primary key (org_id, period_start, metric_key)");
    expect(sql).toContain("alter table metering_events enable row level security");
    expect(sql).toContain("alter table metering_rollups enable row level security");
    expect(sql).toContain("with check (org_id = helix_current_org_id())");
  });

  it("declares durable signup onboarding invite tokens", async () => {
    const sql = await readFile(
      new URL("./migrations/0038_signup_onboarding_invites.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create table if not exists signup_onboarding_invites");
    expect(sql).toContain("org_id uuid not null references orgs(id) on delete cascade");
    expect(sql).toContain("invited_by_actor_id uuid not null references actors(id)");
    expect(sql).toContain("token_hash text not null unique");
    expect(sql).toContain("accepted_by_actor_id uuid references actors(id)");
    expect(sql).toContain("signup_onboarding_invites_token_hash_idx");
  });

  it("installs tenant config audit triggers on org config JSONB changes", async () => {
    const sql = await readFile(
      new URL("./migrations/0039_tenant_config_audit_triggers.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create or replace function orgs_tenant_config_audit()");
    expect(sql).toContain("current_setting('helix.tenant_config_changed_by', true)");
    expect(sql).toContain("current_setting('helix.tenant_config_reason', true)");
    expect(sql).toContain("clock_timestamp()");
    expect(sql).toContain("TG_OP = 'INSERT'");
    expect(sql).toContain("NEW.byo_config is distinct from OLD.byo_config");
    expect(sql).toContain("NEW.feature_flags is distinct from OLD.feature_flags");
    expect(sql).toContain("NEW.quotas is distinct from OLD.quotas");
    expect(sql).toContain("NEW.branding is distinct from OLD.branding");
    expect(sql).toContain("drop trigger if exists orgs_tenant_config_audit_insert on orgs");
    expect(sql).toContain("after insert on orgs");
    expect(sql).toContain("after update of byo_config, feature_flags, quotas, branding on orgs");
  });

  it("declares durable Sheets OT operation log storage with tenant isolation", async () => {
    const sql = await readFile(
      new URL("./migrations/0048_sheets_op_log.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create table if not exists sheet_op_log");
    expect(sql).toContain("org_id uuid not null references orgs(id) on delete cascade");
    expect(sql).toContain("sheet_id uuid not null references sheets(id) on delete cascade");
    expect(sql).toContain("base_revision integer not null");
    expect(sql).toContain("create unique index if not exists sheet_op_log_sheet_revision_idx");
    expect(sql).toContain("create unique index if not exists sheet_op_log_sheet_operation_idx");
    expect(sql).toContain("alter table sheet_op_log enable row level security");
    expect(sql).toContain("create policy helix_tenant_isolation on sheet_op_log");
  });

  it("declares durable Slides operation log storage with tenant isolation", async () => {
    const sql = await readFile(
      new URL("./migrations/0049_slides_op_log.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create table if not exists slides_op_log");
    expect(sql).toContain("org_id uuid not null references orgs(id) on delete cascade");
    expect(sql).toContain("deck_id uuid not null references slide_decks(id) on delete cascade");
    expect(sql).toContain("base_revision integer not null");
    expect(sql).toContain("create unique index if not exists slides_op_log_deck_revision_idx");
    expect(sql).toContain("create unique index if not exists slides_op_log_deck_operation_idx");
    expect(sql).toContain("alter table slides_op_log enable row level security");
    expect(sql).toContain("create policy helix_tenant_isolation on slides_op_log");
  });
});
