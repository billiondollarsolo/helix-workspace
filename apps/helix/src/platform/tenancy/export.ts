import type postgres from "postgres";
import type { JsonObject, StorageObject } from "@helix/sdk-types";
import {
  listTenantStorageMigrationObjects,
  type TenantStorageMigrationObject,
} from "../storage/migration.js";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
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
    readonly bytesIncluded: boolean;
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

export interface TenantExportArchiveStream {
  readonly filename: string;
  readonly contentType: "application/x-tar";
  readonly byteSize: number;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface TenantExportSelfFetchObject {
  readonly storageKey: string;
  readonly byteSize?: number | undefined;
  readonly sha256?: string | undefined;
  readonly url: string;
  readonly expiresAt: string;
}

export interface TenantExportSelfFetchManifest {
  readonly version: 1;
  readonly generatedAt: string;
  readonly org: {
    readonly id: string;
    readonly slug: string;
  };
  readonly delivery: "self-fetch";
  readonly expiresAt: string;
  readonly expiresSeconds: number;
  readonly objects: readonly TenantExportSelfFetchObject[];
}

export type TenantExportObjectByteDelivery = "archive" | "self-fetch";

export interface BuildTenantExportManifestInput {
  readonly org: OrgRecord;
  readonly objects: readonly TenantStorageMigrationObject[];
  readonly rowCounts: readonly TenantExportTableCount[];
  readonly auditSummary: TenantExportAuditSummary;
  readonly generatedAt?: Date | undefined;
  readonly bytesIncluded?: boolean | undefined;
}

export interface BuildTenantExportArchiveOptions {
  readonly includeObjectBytes?: boolean | undefined;
  readonly objectByteDelivery?: TenantExportObjectByteDelivery | undefined;
  readonly presignedUrlExpiresSeconds?: number | undefined;
  readonly storageResolver?: TenantStorageResolver | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface BuildTenantExportSelfFetchManifestOptions {
  readonly presignedUrlExpiresSeconds?: number | undefined;
  readonly storageResolver?: TenantStorageResolver | undefined;
  readonly now?: (() => Date) | undefined;
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
      bytesIncluded: input.bytesIncluded === true,
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

export async function buildTenantExportArchive(
  manifest: TenantExportManifest,
  options: BuildTenantExportArchiveOptions = {},
): Promise<TenantExportArchive> {
  const files = await tenantExportArchiveFiles(manifest, options);
  const bytes = buildTarArchive(
    await Promise.all(
      files.map(async (file) => ({
        path: file.path,
        body: await archiveFileBodyBytes(file.body),
      })),
    ),
    Math.floor(Date.parse(manifest.generatedAt) / 1000),
  );
  return {
    filename: `helix-export-${manifest.org.slug}-${archiveTimestamp(manifest.generatedAt)}.tar`,
    contentType: "application/x-tar",
    byteSize: bytes.byteLength,
    bytes,
  };
}

export async function streamTenantExportArchive(
  manifest: TenantExportManifest,
  options: BuildTenantExportArchiveOptions = {},
): Promise<TenantExportArchiveStream> {
  const files = await tenantExportArchiveFiles(manifest, options);
  return {
    filename: `helix-export-${manifest.org.slug}-${archiveTimestamp(manifest.generatedAt)}.tar`,
    contentType: "application/x-tar",
    byteSize: tarArchiveByteSize(files),
    body: streamTarArchive(files, Math.floor(Date.parse(manifest.generatedAt) / 1000)),
  };
}

async function tenantExportArchiveFiles(
  manifest: TenantExportManifest,
  options: BuildTenantExportArchiveOptions,
): Promise<readonly TenantExportArchiveFile[]> {
  const objectByteDelivery = options.objectByteDelivery ?? "archive";
  const metadataManifest =
    options.includeObjectBytes === true && objectByteDelivery === "archive"
      ? {
          ...manifest,
          objectInventory: { ...manifest.objectInventory, bytesIncluded: true },
        }
      : manifest;
  const files: TenantExportArchiveFile[] = [
    {
      path: "manifest.json",
      body: stableJson({
        version: metadataManifest.version,
        generatedAt: metadataManifest.generatedAt,
        org: metadataManifest.org,
        objectInventory: {
          bytesIncluded: metadataManifest.objectInventory.bytesIncluded,
          objectCount: metadataManifest.objectInventory.objectCount,
          totalKnownBytes: metadataManifest.objectInventory.totalKnownBytes,
        },
        postgres: metadataManifest.postgres,
        auditLog: metadataManifest.auditLog,
      }),
    },
    {
      path: "config-snapshot.json",
      body: stableJson(metadataManifest.configSnapshot),
    },
    {
      path: "objects/inventory.json",
      body: stableJson(metadataManifest.objectInventory),
    },
    {
      path: "postgres/schema.sql",
      body: textBytes(
        [
          "-- Helix tenant export v1 metadata archive.",
          "-- Apply the matching Helix migration set before importing future data chunks.",
          "",
        ].join("\n"),
      ),
    },
    {
      path: "postgres/data/row-counts.json",
      body: stableJson(metadataManifest.postgres.rowCounts),
    },
    {
      path: "audit-log/summary.json",
      body: stableJson(metadataManifest.auditLog),
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
      body: textBytes(exportReadme(metadataManifest)),
    },
  ];

  if (options.includeObjectBytes === true) {
    if (objectByteDelivery === "self-fetch") {
      files.push({
        path: "objects/self-fetch-manifest.json",
        body: stableJson(await buildTenantExportSelfFetchManifest(metadataManifest, options)),
      });
    } else {
      files.push(...(await objectByteArchiveFiles(metadataManifest, options.storageResolver)));
    }
  }

  return files;
}

export async function countTenantExportRows(
  sql: postgres.Sql,
  orgId: string,
): Promise<readonly TenantExportTableCount[]> {
  const rows = (await sql`
    select 'actors' as table_name, count(*)::integer as row_count from actors where org_id = ${orgId}
    union all select 'objects', count(*)::integer from objects where org_id = ${orgId}
    union all select 'threads', count(*)::integer from threads where org_id = ${orgId}
    union all select 'messages', count(*)::integer from messages where org_id = ${orgId}
    union all select 'message_attachments', count(*)::integer from message_attachments where org_id = ${orgId}
    union all select 'permissions', count(*)::integer from permissions where org_id = ${orgId}
    union all select 'activity', count(*)::integer from activity where org_id = ${orgId}
    union all select 'tenant_config_audit', count(*)::integer from tenant_config_audit where org_id = ${orgId}
    union all select 'tenant_storage_migration_jobs', count(*)::integer from tenant_storage_migration_jobs where org_id = ${orgId}
    union all select 'ai_artifacts', count(*)::integer from ai_artifacts where org_id = ${orgId}
    union all select 'memory_items', count(*)::integer from memory_items where org_id = ${orgId}
    union all select 'pending_actions', count(*)::integer from pending_actions where org_id = ${orgId}
    union all select 'assistant_conversations', count(*)::integer from assistant_conversations where org_id = ${orgId}
    union all select 'assistant_messages', count(*)::integer from assistant_messages where org_id = ${orgId}
    union all select 'assistant_memory_preferences', count(*)::integer from assistant_memory_preferences where org_id = ${orgId}
    union all select 'app_passwords', count(*)::integer from app_passwords where org_id = ${orgId}
    union all select 'agent_credentials', count(*)::integer from agent_credentials where org_id = ${orgId}
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
    union all select 'drive_pdf_form_states', count(*)::integer from drive_pdf_form_states where org_id = ${orgId}
    union all select 'docs_documents', count(*)::integer from docs_documents where org_id = ${orgId}
    union all select 'docs_updates', count(*)::integer from docs_updates where org_id = ${orgId}
    union all select 'docs_comments', count(*)::integer from docs_comments where org_id = ${orgId}
    union all select 'docs_suggestions', count(*)::integer from docs_suggestions where org_id = ${orgId}
    union all select 'sheets', count(*)::integer from sheets where org_id = ${orgId}
    union all select 'sheet_tabs', count(*)::integer from sheet_tabs where org_id = ${orgId}
    union all select 'sheet_cells', count(*)::integer from sheet_cells where org_id = ${orgId}
    union all select 'sheet_op_log', count(*)::integer from sheet_op_log where org_id = ${orgId}
    union all select 'slide_decks', count(*)::integer from slide_decks where org_id = ${orgId}
    union all select 'slides', count(*)::integer from slides where org_id = ${orgId}
    union all select 'slides_op_log', count(*)::integer from slides_op_log where org_id = ${orgId}
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
  readonly body: AsyncIterable<Uint8Array> | Uint8Array;
  readonly byteSize?: number | undefined;
}

interface MaterializedTenantExportArchiveFile {
  readonly path: string;
  readonly body: Uint8Array;
}

async function objectByteArchiveFiles(
  manifest: TenantExportManifest,
  resolver: TenantStorageResolver | undefined,
): Promise<readonly TenantExportArchiveFile[]> {
  if (resolver === undefined) {
    throw new Error("Tenant storage resolver is required to include export object bytes.");
  }
  const storage = await resolver({ orgId: manifest.org.id });
  if (storage === undefined) {
    throw new Error("Tenant storage resolver did not resolve storage for tenant export.");
  }
  const files: TenantExportArchiveFile[] = [];
  for (const object of manifest.objectInventory.objects) {
    const stored = await storage.client.get(object.storageKey);
    if (stored === null) {
      throw new Error(`Tenant export object bytes are unavailable: ${object.storageKey}`);
    }
    const bodySize =
      stored.body instanceof Uint8Array
        ? stored.body.byteLength
        : object.byteSize === undefined
          ? undefined
          : object.byteSize;
    files.push({
      path: objectArchivePath(object.storageKey),
      body: bodySize === undefined ? await storageObjectBodyBytes(stored.body) : stored.body,
      ...(bodySize === undefined ? {} : { byteSize: bodySize }),
    });
  }
  return files;
}

export async function buildTenantExportSelfFetchManifest(
  manifest: TenantExportManifest,
  options: BuildTenantExportSelfFetchManifestOptions,
): Promise<TenantExportSelfFetchManifest> {
  if (options.storageResolver === undefined) {
    throw new Error("Tenant storage resolver is required to presign export object bytes.");
  }
  const storage = await options.storageResolver({ orgId: manifest.org.id });
  if (storage === undefined) {
    throw new Error("Tenant storage resolver did not resolve storage for tenant export.");
  }
  if (storage.client.presignGetUrl === undefined) {
    throw new Error("Tenant export storage does not support presigned object fetch.");
  }
  const expiresSeconds = validatePresignedUrlExpiresSeconds(
    options.presignedUrlExpiresSeconds ?? 3600,
  );
  const now = options.now ?? (() => new Date());
  const expiresAt = new Date(now().getTime() + expiresSeconds * 1000).toISOString();
  const objects: TenantExportSelfFetchObject[] = [];
  for (const object of manifest.objectInventory.objects) {
    objects.push({
      storageKey: object.storageKey,
      ...(object.byteSize === undefined ? {} : { byteSize: object.byteSize }),
      ...(object.sha256 === undefined ? {} : { sha256: object.sha256 }),
      url: await storage.client.presignGetUrl(object.storageKey, { expiresSeconds }),
      expiresAt,
    });
  }
  return {
    version: tenantExportManifestVersion,
    generatedAt: manifest.generatedAt,
    org: {
      id: manifest.org.id,
      slug: manifest.org.slug,
    },
    delivery: "self-fetch",
    expiresAt,
    expiresSeconds,
    objects,
  };
}

async function storageObjectBodyBytes(body: StorageObject["body"]): Promise<Uint8Array> {
  return archiveFileBodyBytes(body);
}

async function archiveFileBodyBytes(
  body: AsyncIterable<Uint8Array> | Uint8Array,
): Promise<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  return body;
}

function objectArchivePath(storageKey: string): string {
  const normalized = storageKey.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..") ||
    hasControlCharacter(normalized)
  ) {
    throw new Error(`Unsafe tenant export object storage key: ${storageKey}`);
  }
  return `objects/${normalized}`;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function exportReadme(manifest: TenantExportManifest): string {
  const byteLine = manifest.objectInventory.bytesIncluded
    ? "This archive includes object-store bytes under objects/."
    : "It intentionally does not include object bytes unless objects/self-fetch-manifest.json is present.";
  return [
    `# Helix Tenant Export: ${manifest.org.slug}`,
    "",
    `Generated: ${manifest.generatedAt}`,
    `Export manifest version: ${String(manifest.version)}`,
    `Tenant status: ${manifest.org.status}`,
    "",
    "This bounded v1 archive contains the tenant export manifest, tenant config snapshot,",
    "logical object inventory, org-scoped table row counts, and audit-log summary.",
    byteLine,
    "",
    "It intentionally does not include PostgreSQL row-data chunks, private credentials, token hashes,",
    "webhook payloads, document/mail bodies, or encrypted customer secrets. Those remain part of the",
    "full portability export roadmap.",
    "",
  ].join("\n");
}

function stableJson(value: unknown): Uint8Array {
  return textBytes(`${JSON.stringify(value, null, 2)}\n`);
}

function textBytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function archiveTimestamp(value: string): string {
  const date = new Date(value);
  const iso = Number.isNaN(date.getTime()) ? value : date.toISOString();
  return iso
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "")
    .replace(/[^\dTZ]/gu, "");
}

function validatePresignedUrlExpiresSeconds(expiresSeconds: number): number {
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 604_800) {
    throw new Error("Tenant export presigned URL expiry must be between 1 and 604800 seconds.");
  }
  return expiresSeconds;
}

function buildTarArchive(
  files: readonly MaterializedTenantExportArchiveFile[],
  mtimeSeconds: number,
): Buffer {
  return Buffer.concat([
    ...files.flatMap((file) => tarEntry({ ...file, body: Buffer.from(file.body) }, mtimeSeconds)),
    Buffer.alloc(1024),
  ]);
}

async function* streamTarArchive(
  files: readonly TenantExportArchiveFile[],
  mtimeSeconds: number,
): AsyncIterable<Uint8Array> {
  for (const file of files) {
    const size = archiveFileSize(file);
    yield tarHeader({ path: file.path, size, mtimeSeconds });
    let emitted = 0;
    for await (const chunk of bodyChunks(file.body)) {
      emitted += chunk.byteLength;
      yield chunk;
    }
    if (emitted !== size) {
      throw new Error(
        `Tenant export stream size mismatch for ${file.path}: expected ${String(size)}, emitted ${String(
          emitted,
        )}`,
      );
    }
    yield Buffer.alloc((512 - (size % 512)) % 512);
  }
  yield Buffer.alloc(1024);
}

function tarArchiveByteSize(files: readonly TenantExportArchiveFile[]): number {
  return (
    files.reduce((total, file) => {
      const size = archiveFileSize(file);
      return total + 512 + size + ((512 - (size % 512)) % 512);
    }, 0) + 1024
  );
}

function archiveFileSize(file: TenantExportArchiveFile): number {
  const size =
    file.byteSize ?? (file.body instanceof Uint8Array ? file.body.byteLength : undefined);
  if (size === undefined) {
    throw new Error(`Tenant export stream cannot determine tar entry size: ${file.path}`);
  }
  return size;
}

async function* bodyChunks(
  body: AsyncIterable<Uint8Array> | Uint8Array,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    for await (const chunk of body) {
      yield chunk;
    }
    return;
  }
  yield body;
}

function tarEntry(
  file: TenantExportArchiveFile & { readonly body: Uint8Array },
  mtimeSeconds: number,
): readonly Buffer[] {
  const body = Buffer.from(file.body);
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
