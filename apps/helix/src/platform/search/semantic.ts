import { isJsonRecord as isJsonObject } from "@helix/sdk-types";
import type { JsonObject } from "@helix/sdk-types";
import type { VectorItem, VectorStore, VectorVisibility } from "../ai/vector/index.js";
import { toJsonObject } from "../util/json.js";
import { chunkDocument, documentText } from "./chunks.js";
import type {
  IndexDocument,
  SearchEngine,
  SearchHit,
  SearchRequest,
  SearchResponse,
} from "./types.js";

interface SearchEmbeddingProvider {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface SemanticSearchEngineOptions {
  readonly keyword: SearchEngine;
  readonly embeddings: SearchEmbeddingProvider;
  readonly vectorStore: VectorStore;
  readonly collection?: string;
  readonly vectorLimit?: number;
  readonly allowDocument?: (document: IndexDocument) => boolean | Promise<boolean>;
  readonly allowQuery?: (request: SearchRequest) => boolean | Promise<boolean>;
  readonly embeddingText?: (text: string) => string;
  readonly chunking?: { readonly size: number; readonly overlap: number };
  readonly onChunkedDocument?: () => void;
}

interface SemanticMetadata extends JsonObject {
  readonly document: JsonObject;
  readonly type: string;
  readonly orgId?: string;
}

export class SemanticSearchEngine implements SearchEngine {
  readonly id: string;
  readonly #collection: string;
  readonly #vectorLimit: number;

  constructor(private readonly options: SemanticSearchEngineOptions) {
    this.id = `${options.keyword.id}+semantic`;
    this.#collection = options.collection ?? "helix_search";
    this.#vectorLimit = options.vectorLimit ?? 50;
    if (options.chunking !== undefined && options.vectorStore.deleteByDocumentIds === undefined)
      throw new TypeError("Chunk retrieval requires source-document deletion support.");
  }

  async index(document: IndexDocument): Promise<void> {
    await this.upsert([document]);
  }

  async upsert(documents: readonly IndexDocument[]): Promise<void> {
    await this.options.keyword.upsert(documents);
    const allowed: IndexDocument[] = [];
    for (const document of documents) {
      if ((await this.options.allowDocument?.(document)) ?? true) allowed.push(document);
      else {
        const orgId = stringAttribute(document.attributes, "orgId");
        if (orgId !== undefined) await this.deleteVectors(orgId, [document.id]);
      }
    }
    const byOrg = await this.vectorItemsByOrg(allowed);
    // All embeddings must succeed before replacing any old passages. Failed writes remain
    // retryable in the durable index queue; authoritative hydration rejects stale versions.
    for (const document of allowed) {
      const orgId = stringAttribute(document.attributes, "orgId");
      if (orgId !== undefined && this.options.chunking !== undefined)
        await this.deleteVectors(orgId, [document.id]);
    }
    for (const [orgId, items] of byOrg) {
      const firstVector = items[0]?.vector;
      if (firstVector === undefined) {
        continue;
      }
      // Each tenant gets its own row in vector_collections (org_id, name) and
      // its own slice of vector_items (org_id, collection_name, id). Two
      // tenants reusing the same collection name no longer collide and
      // cannot read each other's embeddings.
      await this.options.vectorStore.createCollection(
        orgId,
        this.#collection,
        firstVector.length,
        "cosine",
      );
      await this.options.vectorStore.upsert(orgId, this.#collection, items);
    }
  }

  async delete(ids: readonly string[], orgId?: string): Promise<void> {
    await this.options.keyword.delete(ids, orgId);
    if (orgId !== undefined && ids.length > 0) {
      await this.deleteVectors(orgId, ids);
    }
  }

  private deleteVectors(orgId: string, ids: readonly string[]) {
    const store = this.options.vectorStore;
    return store.deleteByDocumentIds === undefined
      ? store.delete(orgId, this.#collection, ids)
      : store.deleteByDocumentIds(orgId, this.#collection, ids);
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const limit = request.limit ?? 10;
    const offset = request.offset ?? 0;
    const keywordResponse = await this.options.keyword.search({
      ...request,
      limit: limit + offset,
      offset: 0,
    });
    const keywordHits = keywordResponse.hits.filter((hit) => hitMatchesRequest(hit, request));
    const filteredKeywordResponse =
      keywordHits.length === keywordResponse.hits.length
        ? keywordResponse
        : { ...keywordResponse, hits: keywordHits, estimatedTotalHits: keywordHits.length };
    const query = request.query.trim();
    if (query.length === 0 || !((await this.options.allowQuery?.(request)) ?? true)) {
      return {
        ...filteredKeywordResponse,
        hits: keywordHits.slice(offset, offset + limit),
      };
    }

    // Without a tenant scope on the inbound request we MUST NOT issue a
    // vector query — that would let any caller match across every tenant's
    // embeddings. Fall back to keyword-only results.
    const requestedOrgId = request.forOrgId ?? orgIdFromFilter(request.filter);
    if (requestedOrgId === undefined) {
      return {
        ...filteredKeywordResponse,
        hits: keywordHits.slice(offset, offset + limit),
      };
    }

    const queryVector = (await this.options.embeddings.embed([query]))[0];
    if (queryVector === undefined) {
      return { ...filteredKeywordResponse, hits: keywordHits.slice(offset, offset + limit) };
    }

    const semanticMatches = await this.options.vectorStore.query(
      requestedOrgId,
      this.#collection,
      queryVector,
      {
        limit: Math.max(this.#vectorLimit, limit + offset),
        // RAG visibility gate: when the request carries the authenticated
        // actor (server-set via `createScopedSearchRequest`), the vector
        // store returns the actor's private items in addition to org-shared
        // ones. When `forActorId` is undefined, only org-shared rows surface.
        ...(request.forActorId === undefined ? {} : { actorId: request.forActorId }),
      },
    );
    const semanticHits = semanticRankMap(semanticMatches, request);
    const hits = reciprocalRankFuse(keywordHits, semanticHits).slice(offset, offset + limit);
    return {
      ...filteredKeywordResponse,
      hits,
      estimatedTotalHits: Math.max(filteredKeywordResponse.estimatedTotalHits ?? 0, hits.length),
    };
  }

  private async vectorItemsByOrg(
    documents: readonly IndexDocument[],
  ): Promise<ReadonlyMap<string, readonly VectorItem[]>> {
    const searchable = documents.flatMap((document) => {
      const text = this.options.embeddingText?.(documentText(document)) ?? documentText(document);
      const orgId = stringAttribute(document.attributes, "orgId");
      // Documents without an orgId are dropped: indexing them across the
      // shared collection would re-introduce the cross-tenant hole this
      // store is designed to prevent.
      if (text.length === 0 || orgId === undefined) return [];
      if (this.options.chunking === undefined) return [{ id: document.id, document, text, orgId }];
      const chunks = chunkDocument(document, this.options.chunking);
      if (chunks.length > 1) this.options.onChunkedDocument?.();
      return chunks.map((chunk) => ({ ...chunk, orgId }));
    });
    if (searchable.length === 0) {
      return new Map();
    }
    const vectors: (readonly number[])[] = [];
    for (let offset = 0; offset < searchable.length; offset += 32) {
      const batch = searchable.slice(offset, offset + 32);
      const result = await this.options.embeddings.embed(batch.map((item) => item.text));
      if (result.length !== batch.length)
        throw new TypeError("Embedding response count does not match inputs.");
      vectors.push(...result);
    }
    const grouped = new Map<string, VectorItem[]>();
    searchable.forEach((item, index) => {
      const vector = vectors[index];
      if (vector === undefined) {
        return;
      }
      // RAG visibility lives on the document's attributes (set by each
      // domain indexer based on the source resource's ACL). Items that omit
      // visibility default to "org" — every member of the tenant can see
      // them. Private items MUST carry an ownerActorId; we drop the item
      // and log rather than silently widen a private doc to org-shared.
      const visibility = visibilityFromAttributes(item.document.attributes);
      const ownerActorId = ownerActorIdFromAttributes(item.document.attributes);
      if (visibility === "private" && ownerActorId === undefined) {
        // Misconfigured indexer: skip rather than leak.
        return;
      }
      const list = grouped.get(item.orgId) ?? [];
      list.push({
        id: item.id,
        vector,
        metadata: semanticMetadata(item.document),
        visibility,
        ...(visibility === "private" && ownerActorId !== undefined ? { ownerActorId } : {}),
      });
      grouped.set(item.orgId, list);
    });
    return grouped;
  }
}

function semanticMetadata(document: IndexDocument): SemanticMetadata {
  const orgId = stringAttribute(document.attributes, "orgId");
  return {
    document: toJsonObject(document),
    type: document.type,
    ...(orgId === undefined ? {} : { orgId }),
  };
}

function semanticRankMap(
  matches: ReadonlyArray<{ readonly metadata?: JsonObject; readonly score: number }>,
  request: SearchRequest,
): Map<string, { readonly hit: SearchHit; readonly score: number }> {
  const ranks = new Map<string, { readonly hit: SearchHit; readonly score: number }>();
  matches.forEach((match) => {
    const hit = semanticHit(match.metadata);
    if (hit === null || !hitMatchesRequest(hit, request)) {
      return;
    }
    // Many matching passages must not drown out other documents or lower the best match.
    if (!ranks.has(hit.id)) ranks.set(hit.id, { hit, score: 1 / (60 + ranks.size + 1) });
  });
  return ranks;
}

function semanticHit(metadata: JsonObject | undefined): SearchHit | null {
  const document = metadata?.document;
  if (!isIndexDocument(document)) {
    return null;
  }
  const attributes = isJsonObject(document.attributes) ? document.attributes : undefined;
  return {
    id: document.id,
    type: document.type,
    ...(typeof document.title === "string" ? { title: document.title } : {}),
    ...(typeof document.body === "string" ? { body: document.body } : {}),
    ...(typeof document.url === "string" ? { url: document.url } : {}),
    ...(attributes === undefined ? {} : { attributes }),
    ...(typeof document.updatedAt === "string" ? { updatedAt: document.updatedAt } : {}),
  };
}

function reciprocalRankFuse(
  keywordHits: readonly SearchHit[],
  semanticHits: ReadonlyMap<string, { readonly hit: SearchHit; readonly score: number }>,
): readonly SearchHit[] {
  const byId = new Map<
    string,
    { hit: SearchHit; score: number; keyword: boolean; semantic: boolean }
  >();
  addRankedHits(byId, keywordHits, 60);
  for (const [id, semantic] of semanticHits) {
    const existing = byId.get(id);
    byId.set(id, {
      hit:
        semantic.hit.attributes?.chunkIndex === undefined
          ? (existing?.hit ?? semantic.hit)
          : semantic.hit,
      score: (existing?.score ?? 0) + semantic.score,
      keyword: existing?.keyword ?? false,
      semantic: true,
    });
  }
  return [...byId.values()]
    .sort((left, right) => right.score - left.score)
    .map((entry) => ({
      ...entry.hit,
      score: Number(entry.score.toFixed(6)),
      attributes: {
        ...(entry.hit.attributes ?? {}),
        searchProvenance:
          entry.keyword && entry.semantic ? "hybrid" : entry.semantic ? "semantic" : "keyword",
      },
    }));
}

function addRankedHits(
  byId: Map<string, { hit: SearchHit; score: number; keyword: boolean; semantic: boolean }>,
  hits: readonly SearchHit[],
  k: number,
): void {
  hits.forEach((hit, index) => {
    const score = 1 / (k + index + 1);
    const existing = byId.get(hit.id);
    if (existing === undefined) {
      byId.set(hit.id, { hit, score, keyword: true, semantic: false });
      return;
    }
    byId.set(hit.id, { ...existing, score: existing.score + score, keyword: true });
  });
}

function hitMatchesRequest(hit: SearchHit, request: SearchRequest): boolean {
  if (
    request.types !== undefined &&
    request.types.length > 0 &&
    !request.types.includes(hit.type)
  ) {
    return false;
  }
  if (hit.type === "drive" && request.forActorId !== undefined) {
    const allowedActorIds = hit.attributes?.["allowedActorIds"];
    if (!Array.isArray(allowedActorIds) || !allowedActorIds.includes(request.forActorId)) {
      return false;
    }
  }
  const requestedOrgId = request.forOrgId ?? orgIdFromFilter(request.filter);
  if (requestedOrgId === undefined) {
    return true;
  }
  return stringAttribute(hit.attributes, "orgId") === requestedOrgId;
}

function orgIdFromFilter(filter: SearchRequest["filter"]): string | undefined {
  const filters = typeof filter === "string" ? [filter] : (filter ?? []);
  for (const item of filters) {
    const match = item.match(/^attributes\.orgId = "(.+)"$/u);
    if (match?.[1] !== undefined) {
      return match[1].replaceAll('\\"', '"');
    }
  }
  return undefined;
}

/** Read the `ragVisibility` attribute set by an indexer onto an
 *  IndexDocument. We use the `rag` prefix to avoid colliding with
 *  domain-specific `visibility` semantics (calendar events carry a CalDAV
 *  PUBLIC/PRIVATE/CONFIDENTIAL string under `visibility`). Defaults to
 *  `"org"` so an indexer that hasn't been updated for the RAG visibility
 *  model behaves like the pre-feature behavior. */
function visibilityFromAttributes(attributes: JsonObject | undefined): VectorVisibility {
  const value = attributes?.["ragVisibility"];
  return value === "private" ? "private" : "org";
}

/** Read the `ragOwnerActorId` attribute set by an indexer. Returns undefined
 *  unless explicitly set. Required when visibility is private; ignored when
 *  visibility is org. */
function ownerActorIdFromAttributes(attributes: JsonObject | undefined): string | undefined {
  const value = attributes?.["ragOwnerActorId"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringAttribute(attributes: JsonObject | undefined, key: string): string | undefined {
  const value = attributes?.[key];
  return typeof value === "string" ? value : undefined;
}

function isIndexDocument(value: unknown): value is IndexDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.type === "string";
}
