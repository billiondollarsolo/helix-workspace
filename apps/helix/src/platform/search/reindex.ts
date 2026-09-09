import type postgres from "postgres";
import { calendarRecordToIndexDocument } from "../calendar/search/indexer.js";
import { PostgresCalendarStore } from "../calendar/index.js";
import { chatRecordToIndexDocument } from "../chat/search/indexer.js";
import { PostgresChatStore } from "../chat/index.js";
import { driveRecordToIndexDocument } from "../drive/search/indexer.js";
import { PostgresDriveStore } from "../drive/index.js";
import { mailRecordToIndexDocument } from "../mail/search/indexer.js";
import { PostgresMailStore } from "../mail/index.js";
import { withTenantIoSagaPostgresContext } from "../tenancy/postgres-roles.js";
import type { IndexDocument, SearchEngine } from "./types.js";
export const searchReindexTypes = ["mail", "chat", "drive", "calendar"] as const;
export type SearchReindexType = (typeof searchReindexTypes)[number];
export interface SearchReindexRequest {
  readonly types?: readonly SearchReindexType[] | undefined;
  readonly orgId?: string | undefined;
  readonly batchSize?: number | undefined;
  readonly pruneStale?: boolean | undefined;
}
export interface SearchReindexResult {
  readonly status: "completed";
  readonly engineId: string;
  readonly types: readonly SearchReindexType[];
  readonly totalDocuments: number;
  readonly deletedDocuments: number;
  readonly counts: Record<SearchReindexType, number>;
  readonly batchSize: number;
}
export interface SearchReindexRunner {
  reindex(input?: SearchReindexRequest): Promise<SearchReindexResult>;
}
export interface SearchReconciliationWorkerOptions {
  readonly service: SearchReindexRunner;
  readonly intervalMs?: number;
  readonly onResult?: (result: SearchReindexResult) => void;
  readonly onError?: (error: unknown) => void;
}
/** Repairs missed Drive projections from the authoritative database. */
export class SearchReconciliationWorker {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<SearchReindexResult> | undefined;
  constructor(private readonly options: SearchReconciliationWorkerOptions) {}
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(
      () => void this.run().catch(() => undefined),
      this.options.intervalMs ?? 300000,
    );
    void this.run().catch(() => undefined);
  }
  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
  reconcileOnce(): Promise<SearchReindexResult> {
    return this.run();
  }
  private run(): Promise<SearchReindexResult> {
    if (this.active !== undefined) return this.active;
    this.active = this.options.service
      .reindex({ types: ["drive"], pruneStale: true })
      .then((result) => {
        this.options.onResult?.(result);
        return result;
      })
      .catch((error: unknown) => {
        this.options.onError?.(error);
        throw error;
      })
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
}
export interface SearchReindexSource {
  readonly type: SearchReindexType;
  collect(input: { readonly orgId?: string | undefined }): Promise<readonly IndexDocument[]>;
  collectBatches?(input: {
    readonly orgId?: string | undefined;
    readonly batchSize: number;
  }): AsyncIterable<readonly IndexDocument[]>;
  collectPage?(input: {
    readonly orgId?: string | undefined;
    readonly batchSize: number;
    readonly cursor?: SearchReindexCursor | undefined;
  }): Promise<SearchReindexPage>;
}
export interface SearchReindexCursor {
  readonly updatedAt: string;
  readonly id: string;
}
export interface SearchReindexPage {
  readonly documents: readonly IndexDocument[];
  readonly cursor?: SearchReindexCursor | undefined;
  readonly done: boolean;
}
export interface SearchReindexServiceOptions {
  readonly engine: SearchEngine;
  readonly sources: readonly SearchReindexSource[];
  readonly batchSize?: number | undefined;
}
export class SearchReindexService implements SearchReindexRunner {
  constructor(private readonly options: SearchReindexServiceOptions) {}
  async reindex(input: SearchReindexRequest = {}): Promise<SearchReindexResult> {
    const batchSize = normalizeBatchSize(input.batchSize ?? this.options.batchSize);
    const requestedTypes = normalizeTypes(input.types);
    const sources = this.options.sources.filter((source) => requestedTypes.includes(source.type));
    const counts = emptyCounts();
    const currentIdsByType = emptyIdSets();
    let totalDocuments = 0;
    for (const source of sources) {
      for await (const documents of collectSourceBatches(source, {
        orgId: input.orgId,
        batchSize,
      })) {
        counts[source.type] += documents.length;
        totalDocuments += documents.length;
        for (const document of documents) {
          currentIdsByType[source.type].add(document.id);
        }
        for (const batch of chunks(documents, batchSize)) {
          await this.options.engine.upsert(batch);
        }
      }
    }
    const deletedDocuments =
      input.pruneStale === false
        ? 0
        : await this.pruneStaleDocuments({
            types: requestedTypes,
            orgId: input.orgId,
            currentIdsByType,
            batchSize,
          });
    return {
      status: "completed",
      engineId: this.options.engine.id,
      types: requestedTypes,
      totalDocuments,
      deletedDocuments,
      counts,
      batchSize,
    };
  }
  private async pruneStaleDocuments(input: {
    readonly types: readonly SearchReindexType[];
    readonly orgId?: string | undefined;
    readonly currentIdsByType: Record<SearchReindexType, Set<string>>;
    readonly batchSize: number;
  }): Promise<number> {
    const staleIdsByOrg = new Map<string | undefined, string[]>();
    for (const type of input.types) {
      const currentIds = input.currentIdsByType[type];
      const indexedDocuments = await this.collectIndexedDocuments({ type, orgId: input.orgId });
      for (const indexedDocument of indexedDocuments) {
        if (!currentIds.has(indexedDocument.id)) {
          const orgId = input.orgId ?? indexedDocument.orgId;
          const staleIds = staleIdsByOrg.get(orgId) ?? [];
          staleIds.push(indexedDocument.id);
          staleIdsByOrg.set(orgId, staleIds);
        }
      }
    }
    let deletedDocuments = 0;
    for (const [orgId, staleIds] of staleIdsByOrg) {
      deletedDocuments += staleIds.length;
      for (const batch of chunks(staleIds, input.batchSize)) {
        await this.options.engine.delete(batch, orgId);
      }
    }
    return deletedDocuments;
  }
  private async collectIndexedDocuments(input: {
    readonly type: SearchReindexType;
    readonly orgId?: string | undefined;
  }): Promise<
    readonly {
      readonly id: string;
      readonly orgId?: string;
    }[]
  > {
    const documents: {
      readonly id: string;
      readonly orgId?: string;
    }[] = [];
    const pageSize = 1000;
    let offset = 0;
    for (;;) {
      const response = await this.options.engine.search({
        query: "",
        types: [input.type],
        limit: pageSize,
        offset,
        ...(input.orgId === undefined
          ? {}
          : { filter: `attributes.orgId = ${JSON.stringify(input.orgId)}` }),
        attributesToRetrieve: ["id", "type", "attributes"],
      });
      documents.push(
        ...response.hits.map((hit) => {
          const orgId = hit.attributes?.orgId;
          return {
            id: hit.id,
            ...(typeof orgId === "string" ? { orgId } : {}),
          };
        }),
      );
      if (response.hits.length < pageSize) {
        break;
      }
      offset += pageSize;
    }
    return documents;
  }
}
export interface PostgresSearchReindexSourcesOptions {
  readonly pageSize?: number | undefined;
}
export function createPostgresSearchReindexSources(
  sql: postgres.Sql,
  options: PostgresSearchReindexSourcesOptions = {},
): readonly SearchReindexSource[] {
  const mail = new PostgresMailStore(sql);
  const chat = new PostgresChatStore(sql);
  const drive = new PostgresDriveStore(sql);
  const calendar = new PostgresCalendarStore(sql);
  const pageSize = normalizeBatchSize(options.pageSize);
  return [
    postgresSource({
      sql,
      pageSize,
      type: "mail",
      tableName: "messages",
      predicate: "kind = 'mail' and deleted_at is null",
      load: (id, orgId) => mail.getMailSearchRecordsForIndexing({ messageId: id, orgId }),
      map: mailRecordToIndexDocument,
    }),
    postgresSource({
      sql,
      pageSize,
      type: "chat",
      tableName: "messages",
      predicate: "kind = 'chat' and deleted_at is null",
      load: (id) => chat.getChatSearchRecord(id),
      map: chatRecordToIndexDocument,
    }),
    postgresSource({
      sql,
      pageSize,
      type: "drive",
      tableName: "objects",
      predicate: "kind = 'file' and deleted_at is null",
      load: (id) => drive.getDriveSearchRecord(id),
      map: driveRecordToIndexDocument,
    }),
    postgresSource({
      sql,
      pageSize,
      type: "calendar",
      tableName: "cal_events",
      predicate: "deleted_at is null and status <> 'cancelled'",
      load: (id) => calendar.getCalendarSearchRecord(id),
      map: calendarRecordToIndexDocument,
    }),
  ];
}
type ReindexTableName = "messages" | "objects" | "cal_events";
interface PostgresSourceOptions<Record> {
  readonly sql: postgres.Sql;
  readonly pageSize: number;
  readonly type: SearchReindexType;
  readonly tableName: ReindexTableName;
  readonly predicate: string;
  readonly load: (id: string, orgId?: string) => Promise<Record | readonly Record[] | null>;
  readonly map: (record: Record) => IndexDocument;
}
function postgresSource<Record>(options: PostgresSourceOptions<Record>): SearchReindexSource {
  return {
    type: options.type,
    collect: async ({ orgId }) => {
      const documents: IndexDocument[] = [];
      for await (const batch of collectPostgresDocumentBatches({ ...options, orgId })) {
        documents.push(...batch);
      }
      return documents;
    },
    collectBatches: ({ orgId, batchSize }) =>
      collectPostgresDocumentBatches({
        ...options,
        orgId,
        pageSize: batchSize,
      }),
    collectPage: async ({ orgId, batchSize, cursor }) => {
      if (orgId === undefined) {
        const rows = await collectDurableIdPage(options.sql, options.type, batchSize, cursor);
        const documents: IndexDocument[] = [];
        const rowsByOrg = new Map<string, (typeof rows)[number][]>();
        for (const row of rows) {
          const orgRows = rowsByOrg.get(row.orgId) ?? [];
          orgRows.push(row);
          rowsByOrg.set(row.orgId, orgRows);
        }
        for (const [rowOrgId, orgRows] of rowsByOrg) {
          await withTenantIoSagaPostgresContext(
            options.sql,
            { orgId: rowOrgId, serviceContext: true },
            async () => {
              documents.push(
                ...(await collectDocuments(
                  orgRows.map((row) => row.id),
                  (id) => options.load(id, rowOrgId),
                  options.map,
                )),
              );
            },
          );
        }
        const last = rows.at(-1);
        return {
          documents,
          done: rows.length < batchSize,
          ...(last === undefined
            ? {}
            : { cursor: { id: last.id, updatedAt: last.updatedAt.toISOString() } }),
        };
      }
      const rows = await collectIdPage({
        sql: options.sql,
        tableName: options.tableName,
        predicate: options.predicate,
        orgId,
        limit: batchSize,
        cursor:
          cursor === undefined
            ? undefined
            : { id: cursor.id, updatedAt: new Date(cursor.updatedAt) },
      });
      const documents = await collectDocuments(
        rows.map((row) => row.id),
        (id) => options.load(id, orgId),
        options.map,
      );
      const last = rows.at(-1);
      return {
        documents,
        done: rows.length < batchSize,
        ...(last === undefined
          ? {}
          : { cursor: { id: last.id, updatedAt: last.updatedAt.toISOString() } }),
      };
    },
  };
}
async function collectDurableIdPage(
  sql: postgres.Sql,
  type: SearchReindexType,
  limit: number,
  cursor: SearchReindexCursor | undefined,
): Promise<
  readonly {
    readonly id: string;
    readonly orgId: string;
    readonly updatedAt: Date;
  }[]
> {
  const rows = await sql<
    {
      id: string;
      org_id: string;
      updated_at: Date;
    }[]
  >`
    select * from helix_search_reindex_id_page(
      ${type}, ${cursor?.updatedAt ?? null}, ${cursor?.id ?? null}, ${limit}
    )
  `;
  return rows.map((row) => ({ id: row.id, orgId: row.org_id, updatedAt: row.updated_at }));
}
async function* collectPostgresDocumentBatches<Record>(
  options: PostgresSourceOptions<Record> & {
    readonly orgId?: string | undefined;
  },
): AsyncIterable<readonly IndexDocument[]> {
  let cursor:
    | {
        readonly updatedAt: Date;
        readonly id: string;
      }
    | undefined;
  for (;;) {
    const rows = await collectIdPage({
      sql: options.sql,
      tableName: options.tableName,
      predicate: options.predicate,
      orgId: options.orgId,
      limit: options.pageSize,
      cursor,
    });
    if (rows.length === 0) {
      return;
    }
    const ids = rows.map((row) => row.id);
    const documents = await collectDocuments(
      ids,
      (id) => options.load(id, options.orgId),
      options.map,
    );
    if (documents.length > 0) {
      yield documents;
    }
    if (ids.length < options.pageSize) {
      return;
    }
    const last = rows.at(-1);
    if (last === undefined) return;
    cursor = { id: last.id, updatedAt: last.updatedAt };
  }
}
async function collectDocuments<Record>(
  ids: readonly string[],
  load: (id: string) => Promise<Record | readonly Record[] | null>,
  map: (record: Record) => IndexDocument,
): Promise<readonly IndexDocument[]> {
  const documents: IndexDocument[] = [];
  for (const id of ids) {
    const loaded = await load(id);
    if (loaded !== null) {
      const records = Array.isArray(loaded) ? loaded : [loaded as Record];
      documents.push(...records.map(map));
    }
  }
  return documents;
}
async function collectIdPage(input: {
  readonly sql: postgres.Sql;
  readonly tableName: ReindexTableName;
  readonly predicate: string;
  readonly orgId: string | undefined;
  readonly limit: number;
  readonly cursor:
    | {
        readonly updatedAt: Date;
        readonly id: string;
      }
    | undefined;
}): Promise<
  readonly {
    readonly id: string;
    readonly updatedAt: Date;
  }[]
> {
  const rows = await input.sql.unsafe<
    {
      readonly id: string;
      readonly updated_at: Date;
    }[]
  >(
    `select id, updated_at from ${input.tableName} where ${input.predicate} and ($1::uuid is null or org_id = $1::uuid) and ($3::timestamptz is null or (updated_at, id) > ($3::timestamptz, $4::uuid)) order by updated_at asc, id asc limit $2`,
    [input.orgId ?? null, input.limit, input.cursor?.updatedAt ?? null, input.cursor?.id ?? null],
  );
  return rows.map((row) => ({ id: row.id, updatedAt: row.updated_at }));
}
async function* collectSourceBatches(
  source: SearchReindexSource,
  input: {
    readonly orgId?: string | undefined;
    readonly batchSize: number;
  },
): AsyncIterable<readonly IndexDocument[]> {
  if (source.collectBatches !== undefined) {
    yield* source.collectBatches(input);
    return;
  }
  const documents = await source.collect({ orgId: input.orgId });
  for (const batch of chunks(documents, input.batchSize)) {
    yield batch;
  }
}
function normalizeTypes(
  types: readonly SearchReindexType[] | undefined,
): readonly SearchReindexType[] {
  if (types === undefined || types.length === 0) {
    return searchReindexTypes;
  }
  return searchReindexTypes.filter((type) => types.includes(type));
}
function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return 100;
  }
  return Math.min(Math.floor(value), 1000);
}
function emptyCounts(): Record<SearchReindexType, number> {
  return {
    mail: 0,
    chat: 0,

    drive: 0,
    calendar: 0,
  };
}
function emptyIdSets(): Record<SearchReindexType, Set<string>> {
  return {
    mail: new Set<string>(),
    chat: new Set<string>(),

    drive: new Set<string>(),
    calendar: new Set<string>(),
  };
}
function chunks<T>(values: readonly T[], size: number): readonly T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}
