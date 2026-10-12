import { verifyPassword } from "better-auth/crypto";
import { verifyLatestAuditHashChain } from "../../platform/audit/verifier.js";
import {
  createPostgresSearchReindexSources,
  SearchReconciliationWorker,
  SearchReindexService,
  type SearchEngine,
  type SearchReindexType,
} from "../../platform/search/index.js";
import type { Person } from "./company.js";
import { mapLimit } from "./concurrency.js";
import { DemoSeedError, type DemoRuntime } from "./runtime.js";

export interface DemoValidation {
  readonly counts: Readonly<Record<string, number>>;
  readonly objectsChecked: number;
  readonly driveContentChecked: number;
  readonly indexed: Readonly<Record<SearchReindexType, number>> | null;
  readonly reconciledDocuments: number | null;
  readonly auditRecords: number;
  readonly loginsChecked: number;
}

const COUNTS = {
  people: `select count(*) from actors where org_id = $1 and type = 'user'`,
  groups: `select count(*) from admin_groups where org_id = $1`,
  driveFiles: `select count(*) from objects where org_id = $1 and kind = 'file'`,
  driveFolders: `select count(*) from drive_folders where org_id = $1`,
  driveVersions: `select count(*) from drive_versions where org_id = $1`,
  driveComments: `select count(*) from drive_comments where org_id = $1`,
  mailMessages: `select count(*) from messages where org_id = $1 and kind = 'mail'`,
  mailboxThreads: `select count(*) from mail_thread_state where org_id = $1`,
  mailAttachments: `select count(*) from objects where org_id = $1 and kind = 'mail_attachment'`,
  chatMessages: `select count(*) from messages where org_id = $1 and kind = 'chat'`,
  calendarEvents: `select count(*) from cal_events where org_id = $1`,
  meetRooms: `select count(*) from meet_rooms where org_id = $1`,
  contacts: `select count(*) from carddav_contacts where org_id = $1`,
  assistantConversations: `select count(*) from assistant_conversations where org_id = $1`,
  webhookDeliveries: `select count(*) from webhook_deliveries where org_id = $1`,
  auditEvents: `select count(*) from activity where org_id = $1`,
} as const;

/** Floors a healthy seed always clears; a phase that silently wrote nothing fails here. */
function minimums(runtime: DemoRuntime): Partial<Record<keyof typeof COUNTS, number>> {
  const { preset } = runtime;
  return {
    people: preset.headcount,
    groups: 10,
    driveFiles: preset.headcount * Math.max(1, preset.driveFilesPerPerson - 1),
    driveVersions: preset.headcount,
    mailMessages: preset.headcount * (preset.mailThreadsPerPerson + preset.inboundPerPerson),
    mailAttachments: 20,
    chatMessages: preset.chatMessagesPerSpace * 4,
    calendarEvents: preset.headcount,
    meetRooms: preset.pastMeetings,
    contacts: preset.headcount,
    assistantConversations: 2,
    webhookDeliveries: 1,
    auditEvents: preset.headcount,
  };
}

async function countRows(runtime: DemoRuntime): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const floors = minimums(runtime);
  const short: string[] = [];
  await runtime.tenant(async (tx) => {
    for (const [name, query] of Object.entries(COUNTS)) {
      const rows = await tx.unsafe<{ count: string }[]>(query, [runtime.orgId]);
      const count = Number(rows[0]?.count ?? 0);
      counts[name] = count;
      const floor = floors[name as keyof typeof COUNTS];
      if (floor !== undefined && count < floor)
        short.push(`${name}: ${String(count)} < ${String(floor)}`);
    }
  });
  if (short.length > 0)
    throw new DemoSeedError(
      `Seeded content is short of the ${runtime.size} preset: ${short.join(", ")}`,
    );
  return counts;
}

/** Every stored byte the database points at is in the tenant's object store at its recorded size. */
async function checkObjects(runtime: DemoRuntime): Promise<number> {
  const storage = await runtime.storageResolver({ orgId: runtime.orgId, refresh: true });
  if (storage?.client.headObject === undefined)
    throw new DemoSeedError("Tenant storage cannot be inspected.");
  const client = storage.client;
  const rows = await runtime.tenant(
    (tx) => tx<
      {
        readonly key: string;
        readonly size: string;
        readonly kind: string;
        readonly state: string | null;
      }[]
    >`
      select storage_key as key, byte_size::text as size, kind::text as kind,
        coalesce(metadata->>'status', metadata->>'ingestState') as state
      from objects where org_id = ${runtime.orgId} and deleted_at is null
      union all
      select version.storage_key, version.byte_size::text, 'version', 'ready'
      from drive_versions version join objects object on object.id = version.object_id
      where version.org_id = ${runtime.orgId} and object.deleted_at is null
    `,
  );
  const problems: string[] = [];
  await mapLimit(rows, 16, async (row) => {
    if (row.kind === "file" && row.state !== "ready")
      problems.push(`${row.key}: scan state ${String(row.state)}`);
    if (row.kind === "mail_attachment" && row.state !== "clean")
      problems.push(`${row.key}: ingest state ${String(row.state)}`);
    const head = await client.headObject?.(row.key);
    if (head === null || head === undefined)
      problems.push(`${row.key}: missing from tenant storage`);
    else if (head.byteSize !== null && head.byteSize !== Number(row.size))
      problems.push(`${row.key}: ${String(head.byteSize)} bytes, expected ${row.size}`);
  });
  if (problems.length > 0) {
    throw new DemoSeedError(
      `${String(problems.length)} stored objects are not readable through tenant storage:\n  ${problems.slice(0, 10).join("\n  ")}`,
    );
  }
  return rows.length;
}

/** Loads each Drive file with its contents, the way semantic search and reconciliation do. */
async function checkDriveContent(runtime: DemoRuntime): Promise<number> {
  const ids = await runtime.tenant(
    (tx) =>
      tx<
        { readonly id: string }[]
      >`select id from objects where org_id = ${runtime.orgId} and kind = 'file' and deleted_at is null`,
  );
  const failures: string[] = [];
  await mapLimit(ids, 8, async ({ id }) => {
    try {
      const record = await runtime.drive.getDriveSearchRecord(id, true);
      if (record === null) failures.push(`${id}: no search record`);
    } catch (error) {
      failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (failures.length > 0) {
    throw new DemoSeedError(
      `Drive search records failed to load:\n  ${failures.slice(0, 10).join("\n  ")}`,
    );
  }
  return ids.length;
}

/**
 * Runs one pass of the API's Drive maintenance worker (scan retries, blob
 * reference GC, usage reconciliation; trash only leaves the counter there),
 * then requires a second reconciliation to find nothing left to correct.
 */
async function checkStorageAccounting(runtime: DemoRuntime): Promise<void> {
  const pass = await runtime.rawDrive.runVirusScanRetryBatch({ limit: 100, leaseMs: 60_000 });
  if (pass.failed > 0)
    throw new DemoSeedError(`${String(pass.failed)} Drive maintenance jobs failed.`);
  const rows = await runtime.tenant(
    (tx) =>
      tx<
        { readonly correction_bytes: string }[]
      >`select correction_bytes::text from helix_reconcile_storage_usage(${runtime.orgId})`,
  );
  const correction = Number(rows[0]?.correction_bytes ?? 0);
  if (correction !== 0)
    throw new DemoSeedError(`Storage usage counter drifted by ${String(correction)} bytes.`);
}

const REINDEXED: readonly SearchReindexType[] = ["mail", "chat", "drive", "calendar"];

/**
 * A full reindex of the tenant in its tenant context, as the API's in-place
 * reindex job runs it, then the API's cross-tenant Drive reconciliation pass.
 * After a full seed every type must project documents: an empty projection
 * means the runtime role could not read its sources.
 */
async function checkSearch(runtime: DemoRuntime, engine: SearchEngine, full: boolean) {
  const service = new SearchReindexService({
    engine,
    sources: createPostgresSearchReindexSources(runtime.sql),
  });
  const result = await runtime.tenant(() =>
    service.reindex({ orgId: runtime.orgId, types: REINDEXED, pruneStale: true }),
  );
  const empty = REINDEXED.filter((type) => result.counts[type] === 0);
  if (full && empty.length > 0) {
    throw new DemoSeedError(`Search reindex projected no ${empty.join(", ")} documents.`);
  }
  const reconciliation = await new SearchReconciliationWorker({ service }).reconcileOnce();
  return { counts: result.counts, reconciled: reconciliation.totalDocuments };
}

async function checkLogins(runtime: DemoRuntime, people: readonly Person[]): Promise<number> {
  const sample = people.filter((person) => person.login !== null || person.index === 2);
  for (const person of sample) {
    const rows = await runtime.tenant(
      (tx) => tx<{ readonly password: string | null }[]>`
        select account.password from "user" join account on account."userId" = "user".id
        where lower("user".email) = lower(${person.email}) and account."providerId" = 'credential'
      `,
    );
    const hash = rows[0]?.password;
    if (hash == null || !(await verifyPassword({ hash, password: person.password }))) {
      throw new DemoSeedError(
        `Sign-in for ${person.email} does not accept the documented password.`,
      );
    }
  }
  return sample.length;
}

export async function validateDemo(
  runtime: DemoRuntime,
  people: readonly Person[],
  options: { readonly full: boolean; readonly search: SearchEngine | undefined },
): Promise<DemoValidation> {
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    const result = await run();
    runtime.log("validate", `${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return result;
  };
  const engine = options.search;
  const counts = options.full ? await step("content counts", () => countRows(runtime)) : {};
  const objectsChecked = await step("stored objects", () => checkObjects(runtime));
  const driveContentChecked = await step("Drive contents", () => checkDriveContent(runtime));
  await step("storage accounting", () => checkStorageAccounting(runtime));
  const search =
    engine === undefined
      ? null
      : await step("search reindex and reconciliation", () =>
          checkSearch(runtime, engine, options.full),
        );
  const audit = await step("audit chain", () =>
    verifyLatestAuditHashChain(runtime.audit, { orgId: runtime.orgId }),
  );
  if (!audit.valid) {
    throw new DemoSeedError(
      `Audit hash chain is broken: ${JSON.stringify(audit.issues.slice(0, 3))}`,
    );
  }
  const loginsChecked = await checkLogins(runtime, people);
  return {
    counts,
    objectsChecked,
    driveContentChecked,
    indexed: search?.counts ?? null,
    reconciledDocuments: search?.reconciled ?? null,
    auditRecords: audit.checkedRecordCount,
    loginsChecked,
  };
}
