import type postgres from "postgres";
import { calendarRecordToIndexDocument } from "../calendar/search/indexer.js";
import { PostgresCalendarStore } from "../calendar/store.js";
import { chatRecordToIndexDocument } from "../chat/search/indexer.js";
import { PostgresChatStore } from "../chat/store.js";
import { docsRecordToIndexDocument } from "../docs/search/indexer.js";
import { PostgresDocsStore } from "../docs/store.js";
import { driveRecordToIndexDocument } from "../drive/search/indexer.js";
import { PostgresDriveStore } from "../drive/store.js";
import { mailRecordToIndexDocument } from "../mail/search/indexer.js";
import { PostgresMailStore } from "../mail/store.js";
import type { IndexDocument, SearchEngine } from "./types.js";

export const searchReindexTypes = ["mail", "chat", "docs", "drive", "calendar"] as const;
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

export interface SearchReindexSource {
  readonly type: SearchReindexType;
  collect(input: { readonly orgId?: string | undefined }): Promise<readonly IndexDocument[]>;
  collectBatches?(input: {
    readonly orgId?: string | undefined;
    readonly batchSize: number;
  }): AsyncIterable<readonly IndexDocument[]>;
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
      for await (const documents of collectSourceBatches(source, { orgId: input.orgId, batchSize })) {
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
    const staleIds: string[] = [];
    for (const type of input.types) {
      const currentIds = input.currentIdsByType[type];
      const indexedIds = await this.collectIndexedIds({ type, orgId: input.orgId });
      for (const indexedId of indexedIds) {
        if (!currentIds.has(indexedId)) {
          staleIds.push(indexedId);
        }
      }
    }

    for (const batch of chunks(staleIds, input.batchSize)) {
      await this.options.engine.delete(batch);
    }
    return staleIds.length;
  }

  private async collectIndexedIds(input: {
    readonly type: SearchReindexType;
    readonly orgId?: string | undefined;
  }): Promise<readonly string[]> {
    const ids: string[] = [];
    const pageSize = 1000;
    let offset = 0;
    for (;;) {
      const response = await this.options.engine.search({
        query: "",
        types: [input.type],
        limit: pageSize,
        offset,
        ...(input.orgId === undefined ? {} : { filter: `attributes.orgId = ${JSON.stringify(input.orgId)}` }),
        attributesToRetrieve: ["id", "type", "attributes"],
      });
      ids.push(...response.hits.map((hit) => hit.id));
      if (response.hits.length < pageSize) {
        break;
      }
      offset += pageSize;
    }
    return ids;
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
  const docs = new PostgresDocsStore(sql);
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
      load: (id) => mail.getMailSearchRecord(id),
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
      type: "docs",
      tableName: "docs_documents",
      predicate: "deleted_at is null",
      load: (id) => docs.getDocsSearchRecord(id),
      map: docsRecordToIndexDocument,
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

interface PostgresSourceOptions<Record> {
  readonly sql: postgres.Sql;
  readonly pageSize: number;
  readonly type: SearchReindexType;
  readonly tableName: "messages" | "docs_documents" | "objects" | "cal_events";
  readonly predicate: string;
  readonly load: (id: string) => Promise<Record | null>;
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
  };
}

async function* collectPostgresDocumentBatches<Record>(
  options: PostgresSourceOptions<Record> & { readonly orgId?: string | undefined },
): AsyncIterable<readonly IndexDocument[]> {
  let offset = 0;
  for (;;) {
    const ids = await collectIds({
      sql: options.sql,
      tableName: options.tableName,
      predicate: options.predicate,
      orgId: options.orgId,
      limit: options.pageSize,
      offset,
    });
    if (ids.length === 0) {
      return;
    }

    const documents = await collectDocuments(ids, options.load, options.map);
    if (documents.length > 0) {
      yield documents;
    }
    if (ids.length < options.pageSize) {
      return;
    }
    offset += options.pageSize;
  }
}

async function collectDocuments<Record>(
  ids: readonly string[],
  load: (id: string) => Promise<Record | null>,
  map: (record: Record) => IndexDocument,
): Promise<readonly IndexDocument[]> {
  const documents: IndexDocument[] = [];
  for (const id of ids) {
    const record = await load(id);
    if (record !== null) {
      documents.push(map(record));
    }
  }
  return documents;
}

async function collectIds(input: {
  readonly sql: postgres.Sql;
  readonly tableName: "messages" | "docs_documents" | "objects" | "cal_events";
  readonly predicate: string;
  readonly orgId: string | undefined;
  readonly limit: number;
  readonly offset: number;
}): Promise<readonly string[]> {
  const rows = (await input.sql.unsafe(
    `select id from ${input.tableName} where ${input.predicate} and ($1::uuid is null or org_id = $1::uuid) order by updated_at asc, id asc limit $2 offset $3`,
    [input.orgId ?? null, input.limit, input.offset],
  )) as unknown as readonly { readonly id: string }[];
  return rows.map((row) => row.id);
}

async function* collectSourceBatches(
  source: SearchReindexSource,
  input: { readonly orgId?: string | undefined; readonly batchSize: number },
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

function normalizeTypes(types: readonly SearchReindexType[] | undefined): readonly SearchReindexType[] {
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
    docs: 0,
    drive: 0,
    calendar: 0,
  };
}

function emptyIdSets(): Record<SearchReindexType, Set<string>> {
  return {
    mail: new Set<string>(),
    chat: new Set<string>(),
    docs: new Set<string>(),
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
