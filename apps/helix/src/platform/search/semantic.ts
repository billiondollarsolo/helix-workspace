import type { JsonObject } from "@helix/sdk-types";
import type { VectorStore } from "../ai/vector/index.js";
import type { IndexDocument, SearchEngine, SearchHit, SearchRequest, SearchResponse } from "./types.js";

export interface SearchEmbeddingProvider {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface SemanticSearchEngineOptions {
  readonly keyword: SearchEngine;
  readonly embeddings: SearchEmbeddingProvider;
  readonly vectorStore: VectorStore;
  readonly collection?: string;
  readonly vectorLimit?: number;
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
  }

  async index(document: IndexDocument): Promise<void> {
    await this.upsert([document]);
  }

  async upsert(documents: readonly IndexDocument[]): Promise<void> {
    await this.options.keyword.upsert(documents);
    const vectorItems = await this.vectorItems(documents);
    if (vectorItems.length === 0) {
      return;
    }
    const firstVector = vectorItems[0]?.vector;
    if (firstVector === undefined) {
      return;
    }
    await this.options.vectorStore.createCollection(this.#collection, firstVector.length, "cosine");
    await this.options.vectorStore.upsert(this.#collection, vectorItems);
  }

  async delete(ids: readonly string[]): Promise<void> {
    await this.options.keyword.delete(ids);
    await this.options.vectorStore.delete(this.#collection, ids);
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const limit = request.limit ?? 10;
    const offset = request.offset ?? 0;
    const keywordResponse = await this.options.keyword.search({
      ...request,
      limit: limit + offset,
      offset: 0,
    });
    const query = request.query.trim();
    if (query.length === 0) {
      return {
        ...keywordResponse,
        hits: keywordResponse.hits.slice(offset, offset + limit),
      };
    }

    const queryVector = (await this.options.embeddings.embed([query]))[0];
    if (queryVector === undefined) {
      return keywordResponse;
    }

    const semanticMatches = await this.options.vectorStore.query(this.#collection, queryVector, {
      limit: Math.max(this.#vectorLimit, limit + offset),
    });
    const semanticRanks = semanticRankMap(semanticMatches, request);
    const hits = reciprocalRankFuse(keywordResponse.hits, semanticRanks).slice(offset, offset + limit);
    return {
      ...keywordResponse,
      hits,
      estimatedTotalHits: Math.max(keywordResponse.estimatedTotalHits ?? 0, hits.length),
    };
  }

  private async vectorItems(documents: readonly IndexDocument[]) {
    const searchable = documents.flatMap((document) => {
      const text = documentText(document);
      return text.length === 0 ? [] : [{ document, text }];
    });
    if (searchable.length === 0) {
      return [];
    }
    const vectors = await this.options.embeddings.embed(searchable.map((item) => item.text));
    return searchable.flatMap((item, index) => {
      const vector = vectors[index];
      if (vector === undefined) {
        return [];
      }
      return [
        {
          id: item.document.id,
          vector,
          metadata: semanticMetadata(item.document),
        },
      ];
    });
  }
}

function documentText(document: IndexDocument): string {
  return [document.title, document.body]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
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
): Map<string, number> {
  const ranks = new Map<string, number>();
  matches.forEach((match, index) => {
    const hit = semanticHit(match.metadata);
    if (hit === null || !hitMatchesRequest(hit, request)) {
      return;
    }
    ranks.set(hit.id, 1 / (60 + index + 1));
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
  semanticRanks: ReadonlyMap<string, number>,
): readonly SearchHit[] {
  const byId = new Map<string, { hit: SearchHit; score: number }>();
  addRankedHits(byId, keywordHits, 60);
  for (const [id, semanticScore] of semanticRanks) {
    const existing = byId.get(id);
    if (existing !== undefined) {
      byId.set(id, { hit: existing.hit, score: existing.score + semanticScore });
    }
  }
  return [...byId.values()]
    .sort((left, right) => right.score - left.score)
    .map((entry) => ({ ...entry.hit, score: Number(entry.score.toFixed(6)) }));
}

function addRankedHits(
  byId: Map<string, { hit: SearchHit; score: number }>,
  hits: readonly SearchHit[],
  k: number,
): void {
  hits.forEach((hit, index) => {
    const score = 1 / (k + index + 1);
    const existing = byId.get(hit.id);
    if (existing === undefined) {
      byId.set(hit.id, { hit, score });
      return;
    }
    byId.set(hit.id, { hit: existing.hit, score: existing.score + score });
  });
}

function hitMatchesRequest(hit: SearchHit, request: SearchRequest): boolean {
  if (request.types !== undefined && request.types.length > 0 && !request.types.includes(hit.type)) {
    return false;
  }
  const requestedOrgId = orgIdFromFilter(request.filter);
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

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonObject(value: IndexDocument): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
