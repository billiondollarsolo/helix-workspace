import type { JsonObject } from "@helix/sdk-types";
import {
  isJsonObject,
  normalizeHttpConfig,
  optionalJsonObject,
  optionalNumber,
  optionalString,
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

export class QdrantVectorStore implements VectorStore {
  readonly id = "qdrant";
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
    const collection = scopedCollectionName(orgId, validateCollectionName(name));
    await requestJson(this.id, this.#config, "PUT", `/collections/${encodeURIComponent(collection)}`, {
      vectors: { size: validateDimension(dim), distance: qdrantDistance(assertVectorMetric(metric)) },
    });
  }

  async upsert(orgId: VectorOrgScope, collection: string, items: readonly VectorItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const scoped = scopedCollectionName(orgId, validateCollectionName(collection));
    await requestJson(this.id, this.#config, "PUT", `/collections/${encodeURIComponent(scoped)}/points?wait=true`, {
      points: items.map((item) => ({
        id: item.id,
        vector: [...validateVector(item.vector)],
        payload: item.metadata ?? {},
      })),
    });
  }

  async query(
    orgId: VectorOrgScope,
    collection: string,
    vector: readonly number[],
    opts: VectorQueryOpts = {},
  ): Promise<readonly VectorMatch[]> {
    const scoped = scopedCollectionName(orgId, validateCollectionName(collection));
    const response = await requestJson(this.id, this.#config, "POST", `/collections/${encodeURIComponent(scoped)}/points/search`, {
      vector: [...validateVector(vector)],
      limit: validateLimit(opts.limit),
      with_payload: true,
      with_vector: opts.includeVectors === true,
      ...(opts.filter === undefined ? {} : { filter: { must: metadataFilter(opts.filter) } }),
    });
    const result = isJsonObject(response) && Array.isArray(response.result) ? response.result : [];
    return result.map(qdrantMatch).filter((match): match is VectorMatch => match !== null);
  }

  async delete(orgId: VectorOrgScope, collection: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const scoped = scopedCollectionName(orgId, validateCollectionName(collection));
    await requestJson(this.id, this.#config, "POST", `/collections/${encodeURIComponent(scoped)}/points/delete?wait=true`, {
      points: [...ids],
    });
  }
}

function qdrantDistance(metric: VectorMetric): "Cosine" | "Dot" | "Euclid" {
  if (metric === "cosine") {
    return "Cosine";
  }
  if (metric === "dot") {
    return "Dot";
  }
  return "Euclid";
}

function metadataFilter(filter: JsonObject): readonly JsonObject[] {
  return Object.entries(filter).map(([key, match]) => ({ key, match: { value: match } }));
}

function qdrantMatch(value: unknown): VectorMatch | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const id = optionalString(value.id) ?? (typeof value.id === "number" ? String(value.id) : undefined);
  const score = optionalNumber(value.score);
  if (id === undefined || score === undefined) {
    return null;
  }
  return withOptionalFields({
    id,
    score,
    metadata: optionalJsonObject(value.payload),
    vector: optionalVector(value.vector),
  });
}
