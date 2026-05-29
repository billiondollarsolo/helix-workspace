import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import {
  listTenantStorageMigrationObjects,
  type TenantStorageMigrationObject,
} from "../storage/migration.js";
import type { OrgRecord } from "./orgs.js";

export const tenantExportManifestVersion = 1;

export interface TenantExportTableCount {
  readonly table: string;
  readonly rowCount: number;
}

export interface TenantExportAuditSummary {
  readonly rowCount: number;
  readonly firstEntryAt: string | null;
  readonly lastEntryAt: string | null;
}

export interface TenantExportManifest {
  readonly version: 1;
  readonly generatedAt: string;
  readonly org: {
    readonly id: string;
    readonly slug: string;
    readonly displayName: string;
    readonly status: string;
    readonly tier: string;
    readonly planId: string;
    readonly region: string;
  };
  readonly configSnapshot: {
    readonly byoConfig: JsonObject;
    readonly featureFlags: JsonObject;
    readonly quotas: JsonObject;
    readonly branding: JsonObject;
  };
  readonly objectInventory: {
    readonly includeBytesAvailable: boolean;
    readonly objectCount: number;
    readonly totalKnownBytes: number;
    readonly objects: readonly TenantStorageMigrationObject[];
  };
  readonly postgres: {
    readonly rowCounts: readonly TenantExportTableCount[];
  };
  readonly auditLog: TenantExportAuditSummary;
}

export interface TenantExportArchive {
  readonly filename: string;
  readonly contentType: "application/x-tar";
  readonly byteSize: number;
  readonly bytes: Buffer;
}

export interface BuildTenantExportManifestInput {
  readonly org: OrgRecord;
  readonly objects: readonly TenantStorageMigrationObject[];
  readonly rowCounts: readonly TenantExportTableCount[];
  readonly auditSummary: TenantExportAuditSummary;
  readonly generatedAt?: Date | undefined;
}

export type TenantExportManifestPlanner = (
  org: OrgRecord,
) => Promise<TenantExportManifest> | TenantExportManifest;

interface TenantExportTableCountRow {
  readonly table_name: string;
  readonly row_count: number;
}

interface TenantExportAuditSummaryRow {
  readonly row_count: number;
  readonly first_entry_at: Date | null;
  readonly last_entry_at: Date | null;
}

export function createPostgresTenantExportManifestPlanner(
  sql: postgres.Sql,
): TenantExportManifestPlanner {
  return async (org) =>
    buildTenantExportManifest({
      org,
      objects: await listTenantStorageMigrationObjects(sql, org.id),
      rowCounts: await countTenantExportRows(sql, org.id),
      auditSummary: await summarizeTenantExportAudit(sql, org.id),
    });
}

export function buildTenantExportManifest(
  input: BuildTenantExportManifestInput,
): TenantExportManifest {
  const totalKnownBytes = input.objects.reduce(
    (total, object) => total + (object.byteSize ?? 0),
    0,
  );
  return {
    version: tenantExportManifestVersion,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    org: {
      id: input.org.id,
      slug: input.org.slug,
      displayName: input.org.displayName,
      status: input.org.status,
      tier: input.org.tier,
      planId: input.org.planId,
      region: input.org.region,
    },
    configSnapshot: {
      byoConfig: input.org.byoConfig,
      featureFlags: input.org.featureFlags,
      quotas: input.org.quotas,
      branding: input.org.branding,
    },
    objectInventory: {
      includeBytesAvailable: input.objects.length > 0,
      objectCount: input.objects.length,
      totalKnownBytes,
      objects: input.objects,
    },
    postgres: {
      rowCounts: input.rowCounts,
    },
    auditLog: input.auditSummary,
  };
}

export function buildTenantExportArchive(manifest: TenantExportManifest): TenantExportArchive {
  const generatedStamp = archiveTimestamp(manifest.generatedAt);
  const files: readonly TenantExportArchiveFile[] = [
    {
      path: "manifest.json",
      body: stableJson({
        version: manifest.version,
        generatedAt: manifest.generatedAt,
        org: manifest.org,
        objectInventory: {
          includeBytesAvailable: manifest.objectInventory.includeBytesAvailable,
          objectCount: manifest.objectInventory.objectCount,
          totalKnownBytes: manifest.objectInventory.totalKnownBytes,
        },
        postgres: manifest.postgres,
        auditLog: manifest.auditLog,
      }),
    },
    {
      path: "config-snapshot.json",
      body: stableJson(manifest.configSnapshot),
    },
    {
      path: "objects/inventory.json",
      body: stableJson(manifest.objectInventory),
    },
    {
      path: "postgres/schema.sql",
      body: [
        "-- Helix tenant export v1 metadata archive.",
        "-- Apply the matching Helix migration set before importing future data chunks.",
        "",
      ].join("\n"),
    },
    {
      path: "postgres/data/row-counts.json",
      body: stableJson(manifest.postgres.rowCounts),
    },
    {
      path: "audit-log/summary.json",
      body: stableJson(manifest.auditLog),
    },
    {
      path: "secrets-public.json",
      body: stableJson({
        oidcIssuerUrls: [],
        scimEndpoint: null,
        credentialsIncluded: false,
      }),
    },
    {
      path: "README.md",
      body: exportReadme(manifest),
    },
  ];
  const bytes = buildTarArchive(files, Math.floor(Date.parse(manifest.generatedAt) / 1000));
  return {
    filename: `helix-export-${manifest.org.slug}-${generatedStamp}.tar`,
    contentType: "application/x-tar",
    byteSize: bytes.byteLength,
    bytes,
  };
}

export async function countTenantExportRows(
  sql: postgres.Sql,
  orgId: string,
): Promise<readonly TenantExportTableCount[]> {
  const rows = (await sql`
    select 'actors' as table_name, count(*)::integer as row_count from actors where org_id = ${orgId}
    union all select 'tenant_config_audit', count(*)::integer from tenant_config_audit where org_id = ${orgId}
    union all select 'tenant_provisioning_state', count(*)::integer from tenant_provisioning_state where org_id = ${orgId}
    union all select 'tenant_storage_migration_jobs', count(*)::integer from tenant_storage_migration_jobs where org_id = ${orgId}
    union all select 'signup_email_verifications', count(*)::integer from signup_email_verifications where org_id = ${orgId}
    union all select 'signup_onboarding_invites', count(*)::integer from signup_onboarding_invites where org_id = ${orgId}
    union all select 'metering_events', count(*)::integer from metering_events where org_id = ${orgId}
    union all select 'metering_rollups', count(*)::integer from metering_rollups where org_id = ${orgId}
    union all select 'objects', count(*)::integer from objects where org_id = ${orgId}
    union all select 'threads', count(*)::integer from threads where org_id = ${orgId}
    union all select 'messages', count(*)::integer from messages where org_id = ${orgId}
    union all select 'permissions', count(*)::integer from permissions where org_id = ${orgId}
    union all select 'activity', count(*)::integer from activity where org_id = ${orgId}
    union all select 'admin_org_units', count(*)::integer from admin_org_units where org_id = ${orgId}
    union all select 'admin_groups', count(*)::integer from admin_groups where org_id = ${orgId}
    union all select 'admin_group_members', count(*)::integer from admin_group_members where org_id = ${orgId}
    union all select 'admin_security_policies', count(*)::integer from admin_security_policies where org_id = ${orgId}
    union all select 'admin_oauth_apps', count(*)::integer from admin_oauth_apps where org_id = ${orgId}
    union all select 'admin_billing_accounts', count(*)::integer from admin_billing_accounts where org_id = ${orgId}
    union all select 'admin_billing_invoices', count(*)::integer from admin_billing_invoices where org_id = ${orgId}
    union all select 'admin_domains', count(*)::integer from admin_domains where org_id = ${orgId}
    union all select 'admin_dns_records', count(*)::integer from admin_dns_records where org_id = ${orgId}
    union all select 'ai_artifacts', count(*)::integer from ai_artifacts where org_id = ${orgId}
    union all select 'ai_cost_limits', count(*)::integer from ai_cost_limits where org_id = ${orgId}
    union all select 'memory_items', count(*)::integer from memory_items where org_id = ${orgId}
    union all select 'pending_actions', count(*)::integer from pending_actions where org_id = ${orgId}
    union all select 'assistant_conversations', count(*)::integer from assistant_conversations where org_id = ${orgId}
    union all select 'assistant_messages', count(*)::integer from assistant_messages where org_id = ${orgId}
    union all select 'assistant_memory_preferences', count(*)::integer from assistant_memory_preferences where org_id = ${orgId}
    union all select 'audit_immutable_postgres', count(*)::integer from audit_immutable_postgres where org_id = ${orgId}
    union all select 'oauth_access_tokens', count(*)::integer from oauth_access_tokens where org_id = ${orgId}
    union all select 'oauth_authorization_codes', count(*)::integer from oauth_authorization_codes where org_id = ${orgId}
    union all select 'outbound_webhooks', count(*)::integer from outbound_webhooks where org_id = ${orgId}
    union all select 'inbound_webhooks', count(*)::integer from inbound_webhooks where org_id = ${orgId}
    union all select 'webhook_deliveries', count(*)::integer from webhook_deliveries where org_id = ${orgId}
    union all select 'mail_filters', count(*)::integer from mail_filters where org_id = ${orgId}
    union all select 'mail_aliases', count(*)::integer from mail_aliases where org_id = ${orgId}
    union all select 'mail_vacation', count(*)::integer from mail_vacation where org_id = ${orgId}
    union all select 'mail_vacation_responses', count(*)::integer from mail_vacation_responses where org_id = ${orgId}
    union all select 'mail_thread_state', count(*)::integer from mail_thread_state where org_id = ${orgId}
    union all select 'mail_outbound_messages', count(*)::integer from mail_outbound_messages where org_id = ${orgId}
    union all select 'mail_outbound_providers', count(*)::integer from mail_outbound_providers where org_id = ${orgId}
    union all select 'mail_sending_domains', count(*)::integer from mail_sending_domains where org_id = ${orgId}
    union all select 'mail_dkim_keys', count(*)::integer from mail_dkim_keys where org_id = ${orgId}
    union all select 'mail_dmarc_reports', count(*)::integer from mail_dmarc_reports where org_id = ${orgId}
    union all select 'mail_dmarc_report_records', count(*)::integer from mail_dmarc_report_records where org_id = ${orgId}
    union all select 'mail_inbound_routing_rules', count(*)::integer from mail_inbound_routing_rules where org_id = ${orgId}
    union all select 'drive_folders', count(*)::integer from drive_folders where org_id = ${orgId}
    union all select 'drive_versions', count(*)::integer from drive_versions where org_id = ${orgId}
    union all select 'docs_documents', count(*)::integer from docs_documents where org_id = ${orgId}
    union all select 'docs_styles', count(*)::integer from docs_styles where org_id = ${orgId}
    union all select 'docs_themes', count(*)::integer from docs_themes where org_id = ${orgId}
    union all select 'docs_revisions', count(*)::integer from docs_revisions where org_id = ${orgId}
    union all select 'docs_updates', count(*)::integer from docs_updates where org_id = ${orgId}
    union all select 'docs_comments', count(*)::integer from docs_comments where org_id = ${orgId}
    union all select 'docs_suggestions', count(*)::integer from docs_suggestions where org_id = ${orgId}
    union all select 'sheets', count(*)::integer from sheets where org_id = ${orgId}
    union all select 'sheet_tabs', count(*)::integer from sheet_tabs where org_id = ${orgId}
    union all select 'sheet_cells', count(*)::integer from sheet_cells where org_id = ${orgId}
    union all select 'slide_decks', count(*)::integer from slide_decks where org_id = ${orgId}
    union all select 'slides', count(*)::integer from slides where org_id = ${orgId}
    union all select 'cal_calendars', count(*)::integer from cal_calendars where org_id = ${orgId}
    union all select 'cal_calendar_memberships', count(*)::integer from cal_calendar_memberships where org_id = ${orgId}
    union all select 'cal_events', count(*)::integer from cal_events where org_id = ${orgId}
    union all select 'cal_attendees', count(*)::integer from cal_attendees where org_id = ${orgId}
    union all select 'carddav_contacts', count(*)::integer from carddav_contacts where org_id = ${orgId}
    union all select 'meet_rooms', count(*)::integer from meet_rooms where org_id = ${orgId}
    union all select 'chat_room_settings', count(*)::integer from chat_room_settings where org_id = ${orgId}
    union all select 'chat_reactions', count(*)::integer from chat_reactions where org_id = ${orgId}
    union all select 'chat_pins', count(*)::integer from chat_pins where org_id = ${orgId}
    union all select 'chat_read_receipts', count(*)::integer from chat_read_receipts where org_id = ${orgId}
    union all select 'notifications', count(*)::integer from notifications where org_id = ${orgId}
    union all select 'resource_classifications', count(*)::integer from resource_classifications where org_id = ${orgId}
    union all select 'seed_corpus_assets', count(*)::integer from seed_corpus_assets where org_id = ${orgId}
    order by table_name
  `) as unknown as readonly TenantExportTableCountRow[];
  return rows.map((row) => ({ table: row.table_name, rowCount: row.row_count }));
}

export async function summarizeTenantExportAudit(
  sql: postgres.Sql,
  orgId: string,
): Promise<TenantExportAuditSummary> {
  const rows = (await sql`
    select
      count(*)::integer as row_count,
      min(created_at) as first_entry_at,
      max(created_at) as last_entry_at
    from activity
    where org_id = ${orgId}
  `) as unknown as readonly TenantExportAuditSummaryRow[];
  const row = rows[0];
  return {
    rowCount: row?.row_count ?? 0,
    firstEntryAt: row?.first_entry_at?.toISOString() ?? null,
    lastEntryAt: row?.last_entry_at?.toISOString() ?? null,
  };
}

interface TenantExportArchiveFile {
  readonly path: string;
  readonly body: string;
}

function exportReadme(manifest: TenantExportManifest): string {
  return [
    `# Helix Tenant Export: ${manifest.org.slug}`,
    "",
    `Generated: ${manifest.generatedAt}`,
    `Export manifest version: ${String(manifest.version)}`,
    `Tenant status: ${manifest.org.status}`,
    "",
    "This bounded v1 archive contains the tenant export manifest, tenant config snapshot,",
    "logical object inventory, org-scoped table row counts, and audit-log summary.",
    "",
    "It intentionally does not include object bytes, PostgreSQL row-data chunks, private",
    "credentials, token hashes, webhook payloads, document/mail bodies, or encrypted",
    "customer secrets. Those remain part of the full portability export roadmap.",
    "",
  ].join("\n");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function archiveTimestamp(value: string): string {
  const date = new Date(value);
  const iso = Number.isNaN(date.getTime()) ? value : date.toISOString();
  return iso
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "")
    .replace(/[^\dTZ]/gu, "");
}

function buildTarArchive(files: readonly TenantExportArchiveFile[], mtimeSeconds: number): Buffer {
  return Buffer.concat([
    ...files.flatMap((file) => tarEntry(file, mtimeSeconds)),
    Buffer.alloc(1024),
  ]);
}

function tarEntry(file: TenantExportArchiveFile, mtimeSeconds: number): readonly Buffer[] {
  const body = Buffer.from(file.body, "utf8");
  const header = tarHeader({
    path: file.path,
    size: body.byteLength,
    mtimeSeconds,
  });
  const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512);
  return [header, body, padding];
}

function tarHeader(input: {
  readonly path: string;
  readonly size: number;
  readonly mtimeSeconds: number;
}): Buffer {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, input.path);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, input.size);
  writeTarOctal(header, 136, 12, input.mtimeSeconds);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  writeTarString(header, 265, 32, "helix");
  writeTarString(header, 297, 32, "helix");
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function writeTarString(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) {
    throw new Error(`Tar path is too long for ustar header: ${value}`);
  }
  bytes.copy(buffer, offset, 0, bytes.byteLength);
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(
    `${Math.trunc(value)
      .toString(8)
      .padStart(length - 1, "0")}\0`,
    offset,
    length,
  );
}
