import {
  isJsonObject,
  normalizeHttpConfig,
  optionalJsonObject,
  optionalVector,
  requestJson,
  withOptionalFields,
  type HttpVectorAdapterConfig,
  type NormalizedHttpVectorConfig,
} from "./http.js";
import {
  assertVectorMetric,
  scopedCollectionName,
  validateCollectionName,
  validateDimension,
  validateLimit,
  validateVector,
  type VectorItem,
  type VectorMatch,
  type VectorMetric,
  type VectorOrgScope,
  type VectorQueryOpts,
  type VectorStore,
} from "./types.js";

export class ChromaVectorStore implements VectorStore {
  readonly id = "chroma";
  readonly #config: NormalizedHttpVectorConfig;

  constructor(config: HttpVectorAdapterConfig) {
    this.#config = normalizeHttpConfig(config);
  }

  async createCollection(
    orgId: VectorOrgScope,
    name: string,
    dim: number,
    metric: VectorMetric,
  ): Promise<void> {
    await requestJson(this.id, this.#config, "POST", "/api/v1/collections", {
      name: scopedCollectionName(orgId, validateCollectionName(name)),
      get_or_create: true,
      metadata: { dimension: validateDimension(dim), metric: assertVectorMetric(metric) },
    });
  }

  async upsert(
    orgId: VectorOrgScope,
    collection: string,
    items: readonly VectorItem[],
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const scoped = scopedCollectionName(orgId, validateCollectionName(collection));
    await requestJson(
      this.id,
      this.#config,
      "POST",
      `/api/v1/collections/${encodeURIComponent(scoped)}/upsert`,
      {
        ids: items.map((item) => item.id),
        embeddings: items.map((item) => [...validateVector(item.vector)]),
        metadatas: items.map((item) => item.metadata ?? {}),
      },
    );
  }

  async query(
    orgId: VectorOrgScope,
    collection: string,
    vector: readonly number[],
    opts: VectorQueryOpts = {},
  ): Promise<readonly VectorMatch[]> {
    const scoped = scopedCollectionName(orgId, validateCollectionName(collection));
    const response = await requestJson(
      this.id,
      this.#config,
      "POST",
      `/api/v1/collections/${encodeURIComponent(scoped)}/query`,
      {
        query_embeddings: [[...validateVector(vector)]],
        n_results: validateLimit(opts.limit),
        include:
          opts.includeVectors === true
            ? ["metadatas", "distances", "embeddings"]
            : ["metadatas", "distances"],
        ...(opts.filter === undefined ? {} : { where: opts.filter }),
      },
    );
    return chromaMatches(response, opts.includeVectors === true);
  }

  async delete(orgId: VectorOrgScope, collection: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const scoped = scopedCollectionName(orgId, validateCollectionName(collection));
    await requestJson(
      this.id,
      this.#config,
      "POST",
      `/api/v1/collections/${encodeURIComponent(scoped)}/delete`,
      {
        ids: [...ids],
      },
    );
  }
}

function chromaMatches(response: unknown, includeVectors: boolean): readonly VectorMatch[] {
  if (!isJsonObject(response)) {
    return [];
  }
  const ids = firstArray(response.ids);
  const distances = firstArray(response.distances);
  const metadatas = firstArray(response.metadatas);
  const embeddings = includeVectors ? firstArray(response.embeddings) : [];
  const matches: VectorMatch[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const distance = distances[index];
    if (typeof id !== "string" || typeof distance !== "number") {
      continue;
    }
    const embedding = embeddings[index];
    matches.push(
      withOptionalFields({
        id,
        score: 1 / (1 + distance),
        metadata: optionalJsonObject(metadatas[index]),
        vector: optionalVector(embedding),
      }),
    );
  }
  return matches;
}

function firstArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) && Array.isArray(value[0]) ? value[0] : [];
}
