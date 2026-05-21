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
  validateCollectionName,
  validateDimension,
  validateLimit,
  validateVector,
  type VectorItem,
  type VectorMatch,
  type VectorMetric,
  type VectorQueryOpts,
  type VectorStore,
} from "./types.js";

export class MilvusVectorStore implements VectorStore {
  readonly id = "milvus";
  readonly #config: NormalizedHttpVectorConfig;

  constructor(config: HttpVectorAdapterConfig) {
    this.#config = normalizeHttpConfig(config);
  }

  async createCollection(name: string, dim: number, metric: VectorMetric): Promise<void> {
    await requestJson(this.id, this.#config, "POST", "/v2/vectordb/collections/create", {
      collectionName: validateCollectionName(name),
      dimension: validateDimension(dim),
      metricType: milvusMetric(assertVectorMetric(metric)),
      primaryFieldName: "id",
      vectorFieldName: "vector",
    });
  }

  async upsert(collection: string, items: readonly VectorItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await requestJson(this.id, this.#config, "POST", "/v2/vectordb/entities/upsert", {
      collectionName: validateCollectionName(collection),
      data: items.map((item) => ({
        id: item.id,
        vector: [...validateVector(item.vector)],
        metadata: item.metadata ?? {},
      })),
    });
  }

  async query(collection: string, vector: readonly number[], opts: VectorQueryOpts = {}): Promise<readonly VectorMatch[]> {
    const response = await requestJson(this.id, this.#config, "POST", "/v2/vectordb/entities/search", {
      collectionName: validateCollectionName(collection),
      data: [[...validateVector(vector)]],
      limit: validateLimit(opts.limit),
      outputFields: opts.includeVectors === true ? ["id", "metadata", "vector"] : ["id", "metadata"],
      ...(opts.filter === undefined ? {} : { filter: milvusFilter(opts.filter) }),
    });
    const data = isJsonObject(response) && isJsonObject(response.data) && Array.isArray(response.data.data) ? response.data.data : [];
    return data.map(milvusMatch).filter((match): match is VectorMatch => match !== null);
  }

  async delete(collection: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await requestJson(this.id, this.#config, "POST", "/v2/vectordb/entities/delete", {
      collectionName: validateCollectionName(collection),
      filter: `id in [${ids.map((id) => JSON.stringify(id)).join(", ")}]`,
    });
  }
}

function milvusMetric(metric: VectorMetric): "COSINE" | "IP" | "L2" {
  if (metric === "cosine") {
    return "COSINE";
  }
  if (metric === "dot") {
    return "IP";
  }
  return "L2";
}

function milvusFilter(filter: Readonly<Record<string, unknown>>): string {
  return Object.entries(filter)
    .map(([key, value]) => `metadata["${key.replaceAll('"', '\\"')}"] == ${JSON.stringify(value)}`)
    .join(" and ");
}

function milvusMatch(value: unknown): VectorMatch | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const id = optionalString(value.id);
  const score = optionalNumber(value.score) ?? optionalNumber(value.distance);
  if (id === undefined || score === undefined) {
    return null;
  }
  return withOptionalFields({
    id,
    score,
    metadata: optionalJsonObject(value.metadata),
    vector: optionalVector(value.vector),
  });
}

