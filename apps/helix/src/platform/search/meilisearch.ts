import { createHash } from "node:crypto";
import type { JsonObject } from "@helix/sdk-types";
import type {
  IndexDocument,
  SearchEngine,
  SearchHit,
  SearchRequest,
  SearchResponse,
} from "./types.js";

export interface MeilisearchAdapterOptions {
  readonly indexUid: string;
  readonly primaryKey?: string;
}

export interface MeilisearchClientLike {
  index(uid: string): MeilisearchIndexLike;
  createIndex?: (uid: string, options?: { readonly primaryKey?: string }) => Promise<unknown>;
}

export interface MeilisearchIndexLike {
  addDocuments(
    documents: readonly IndexDocument[],
    options?: { readonly primaryKey?: string },
  ): Promise<unknown>;
  deleteDocuments(ids: readonly string[]): Promise<unknown>;
  search(query: string, options?: MeilisearchSearchOptions): Promise<MeilisearchSearchResponse>;
  updateSettings?(settings: MeilisearchIndexSettings): Promise<unknown>;
}

export interface MeilisearchIndexSettings {
  readonly filterableAttributes?: readonly string[];
  readonly searchableAttributes?: readonly string[];
}

export interface MeilisearchSearchOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly filter?: string | readonly string[];
  readonly attributesToRetrieve?: readonly string[];
}

export interface MeilisearchSearchResponse {
  readonly hits: readonly MeilisearchHit[];
  readonly query?: string;
  readonly estimatedTotalHits?: number;
  readonly processingTimeMs?: number;
}

type MeilisearchHit = IndexDocument & {
  readonly _key?: string;
  readonly _rankingScore?: number;
  readonly _formatted?: JsonObject;
};

type StoredMeilisearchDocument = IndexDocument & {
  readonly _key: string;
};

export class MeilisearchSearchEngine implements SearchEngine {
  readonly id = "meilisearch";
  private readonly indexUid: string;
  private readonly primaryKey: string;

  constructor(
    private readonly client: MeilisearchClientLike,
    options: MeilisearchAdapterOptions,
  ) {
    this.indexUid = options.indexUid;
    this.primaryKey = options.primaryKey ?? "_key";
  }

  async ensureIndex(): Promise<void> {
    await this.client.createIndex?.(this.indexUid, { primaryKey: this.primaryKey });
    await this.indexHandle.updateSettings?.({
      filterableAttributes: ["type", "attributes.orgId"],
      searchableAttributes: ["title", "body"],
    });
  }

  index(document: IndexDocument): Promise<void> {
    return this.upsert([document]);
  }

  async upsert(documents: readonly IndexDocument[]): Promise<void> {
    if (documents.length === 0) {
      return;
    }

    await this.indexHandle.addDocuments(documents.map(toStoredDocument), {
      primaryKey: this.primaryKey,
    });
  }

  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.indexHandle.deleteDocuments(ids.map(documentKey));
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const response = await this.indexHandle.search(request.query, toMeilisearchOptions(request));

    return {
      hits: response.hits.map(toSearchHit),
      query: response.query ?? request.query,
      ...(response.estimatedTotalHits === undefined
        ? {}
        : { estimatedTotalHits: response.estimatedTotalHits }),
      ...(response.processingTimeMs === undefined
        ? {}
        : { processingTimeMs: response.processingTimeMs }),
    };
  }

  private get indexHandle(): MeilisearchIndexLike {
    return this.client.index(this.indexUid);
  }
}

function toMeilisearchOptions(request: SearchRequest): MeilisearchSearchOptions {
  const filter = buildFilter(request);

  return {
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.offset === undefined ? {} : { offset: request.offset }),
    ...(request.attributesToRetrieve === undefined
      ? {}
      : { attributesToRetrieve: request.attributesToRetrieve }),
    ...(filter === undefined ? {} : { filter }),
  };
}

function buildFilter(request: SearchRequest): string | readonly string[] | undefined {
  const typeFilter = buildTypeFilter(request.types);
  const requestFilter = request.filter;
  if (typeFilter === undefined) {
    return requestFilter;
  }
  if (requestFilter === undefined) {
    return typeFilter;
  }
  if (typeof requestFilter === "string") {
    return [typeFilter, requestFilter];
  }
  return [typeFilter, ...requestFilter];
}

function buildTypeFilter(types: readonly string[] | undefined): string | undefined {
  if (types === undefined || types.length === 0) {
    return undefined;
  }

  return `type IN [${types.map((type) => JSON.stringify(type)).join(", ")}]`;
}

function toSearchHit(hit: MeilisearchHit): SearchHit {
  const { _rankingScore, _formatted, _key: _ignoredKey, ...document } = hit;
  return {
    ...document,
    ...(_rankingScore === undefined ? {} : { score: _rankingScore }),
    ...(_formatted === undefined ? {} : { highlights: _formatted }),
  };
}

function toStoredDocument(document: IndexDocument): StoredMeilisearchDocument {
  return {
    ...document,
    _key: documentKey(document.id),
  };
}

function documentKey(id: string): string {
  return `h_${createHash("sha256").update(id).digest("hex")}`;
}
