import type { JsonObject } from "@helix/sdk-types";
import type { IndexDocument } from "./types.js";
import type {
  MeilisearchClientLike,
  MeilisearchIndexLike,
  MeilisearchIndexSettings,
  MeilisearchSearchOptions,
  MeilisearchSearchResponse,
} from "./meilisearch.js";

export interface MeilisearchHttpClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
}

export class MeilisearchHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
  ) {
    super(`Meilisearch request failed with ${String(status)} ${statusText}`);
    this.name = "MeilisearchHttpError";
  }
}

export function createMeilisearchHttpClient(
  options: MeilisearchHttpClientOptions,
): MeilisearchClientLike {
  return new MeilisearchHttpClient(options);
}

class MeilisearchHttpClient implements MeilisearchClientLike {
  readonly #baseUrl: URL;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: MeilisearchHttpClientOptions) {
    if (options.baseUrl.trim().length === 0) {
      throw new TypeError("Meilisearch baseUrl is required");
    }
    this.#baseUrl = new URL(options.baseUrl);
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
  }

  index(uid: string): MeilisearchIndexLike {
    return new MeilisearchHttpIndex(this.#baseUrl, this.#fetch, uid, this.#apiKey);
  }

  async createIndex(uid: string, options?: { readonly primaryKey?: string }): Promise<unknown> {
    return requestJson(
      this.#baseUrl,
      this.#fetch,
      this.#apiKey,
      "POST",
      "/indexes",
      {
        uid,
        ...(options?.primaryKey === undefined ? {} : { primaryKey: options.primaryKey }),
      },
      { allowConflict: true },
    );
  }
}

class MeilisearchHttpIndex implements MeilisearchIndexLike {
  constructor(
    private readonly baseUrl: URL,
    private readonly fetchImpl: typeof fetch,
    private readonly uid: string,
    private readonly apiKey: string | undefined,
  ) {}

  async addDocuments(
    documents: readonly IndexDocument[],
    options?: { readonly primaryKey?: string },
  ): Promise<unknown> {
    const path =
      options?.primaryKey === undefined
        ? `/indexes/${encodePathSegment(this.uid)}/documents`
        : `/indexes/${encodePathSegment(this.uid)}/documents?primaryKey=${encodeURIComponent(options.primaryKey)}`;
    return requestJson(this.baseUrl, this.fetchImpl, this.apiKey, "POST", path, documents);
  }

  async deleteDocuments(ids: readonly string[]): Promise<unknown> {
    return requestJson(
      this.baseUrl,
      this.fetchImpl,
      this.apiKey,
      "POST",
      `/indexes/${encodePathSegment(this.uid)}/documents/delete-batch`,
      ids,
    );
  }

  async search(
    query: string,
    options?: MeilisearchSearchOptions,
  ): Promise<MeilisearchSearchResponse> {
    const response = await requestJson(
      this.baseUrl,
      this.fetchImpl,
      this.apiKey,
      "POST",
      `/indexes/${encodePathSegment(this.uid)}/search`,
      {
        q: query,
        ...(options?.limit === undefined ? {} : { limit: options.limit }),
        ...(options?.offset === undefined ? {} : { offset: options.offset }),
        ...(options?.filter === undefined ? {} : { filter: options.filter }),
        ...(options?.attributesToRetrieve === undefined
          ? {}
          : { attributesToRetrieve: options.attributesToRetrieve }),
      },
    );
    return parseSearchResponse(response);
  }

  async updateSettings(settings: MeilisearchIndexSettings): Promise<unknown> {
    return requestJson(
      this.baseUrl,
      this.fetchImpl,
      this.apiKey,
      "PATCH",
      `/indexes/${encodePathSegment(this.uid)}/settings`,
      settings,
    );
  }
}

async function requestJson(
  baseUrl: URL,
  fetchImpl: typeof fetch,
  apiKey: string | undefined,
  method: "POST" | "PATCH",
  path: string,
  body: JsonObject | readonly IndexDocument[] | readonly string[] | MeilisearchIndexSettings,
  options?: { readonly allowConflict?: boolean },
): Promise<unknown> {
  const url = new URL(path, baseUrl);
  const response = await fetchImpl(url, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const conflictAllowed = response.status === 409 && options?.allowConflict === true;
  if (!response.ok && !conflictAllowed) {
    throw new MeilisearchHttpError(response.status, response.statusText, text);
  }
  return text.length === 0 ? null : (JSON.parse(text) as unknown);
}

function parseSearchResponse(value: unknown): MeilisearchSearchResponse {
  if (!isObject(value)) {
    return { hits: [] };
  }
  const hits = Array.isArray(value.hits)
    ? value.hits.filter(isIndexDocumentLike).map((hit) => {
        const formatted = isJsonObject(hit._formatted) ? hit._formatted : undefined;
        const score = typeof hit._rankingScore === "number" ? hit._rankingScore : undefined;
        return {
          id: hit.id,
          type: hit.type,
          ...(typeof hit.title === "string" ? { title: hit.title } : {}),
          ...(typeof hit.body === "string" ? { body: hit.body } : {}),
          ...(typeof hit.url === "string" ? { url: hit.url } : {}),
          ...(isJsonObject(hit.attributes) ? { attributes: hit.attributes } : {}),
          ...(typeof hit.updatedAt === "string" ? { updatedAt: hit.updatedAt } : {}),
          ...(score === undefined ? {} : { _rankingScore: score }),
          ...(formatted === undefined ? {} : { _formatted: formatted }),
        };
      })
    : [];
  return {
    hits,
    ...(typeof value.query === "string" ? { query: value.query } : {}),
    ...(typeof value.estimatedTotalHits === "number"
      ? { estimatedTotalHits: value.estimatedTotalHits }
      : {}),
    ...(typeof value.processingTimeMs === "number"
      ? { processingTimeMs: value.processingTimeMs }
      : {}),
  };
}

function isIndexDocumentLike(value: unknown): value is IndexDocument & {
  readonly _rankingScore?: unknown;
  readonly _formatted?: unknown;
} {
  return isObject(value) && typeof value.id === "string" && typeof value.type === "string";
}

function isJsonObject(value: unknown): value is JsonObject {
  return isObject(value) && !Array.isArray(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
