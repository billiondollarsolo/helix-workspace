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

export class WeaviateVectorStore implements VectorStore {
  readonly id = "weaviate";
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
    await requestJson(this.id, this.#config, "POST", "/v1/schema", {
      class: className(orgId, name),
      vectorizer: "none",
      vectorIndexConfig: {
        distance: weaviateDistance(assertVectorMetric(metric)),
        dimensions: validateDimension(dim),
      },
      properties: [
        { name: "helixId", dataType: ["text"] },
        { name: "metadata", dataType: ["object"] },
      ],
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
    const klass = className(orgId, collection);
    await requestJson(this.id, this.#config, "POST", "/v1/batch/objects", {
      objects: items.map((item) => ({
        class: klass,
        id: item.id,
        vector: [...validateVector(item.vector)],
        properties: { helixId: item.id, metadata: item.metadata ?? {} },
      })),
    });
  }

  async query(
    orgId: VectorOrgScope,
    collection: string,
    vector: readonly number[],
    opts: VectorQueryOpts = {},
  ): Promise<readonly VectorMatch[]> {
    const klass = className(orgId, collection);
    const response = await requestJson(this.id, this.#config, "POST", "/v1/graphql", {
      query: weaviateGraphql(
        klass,
        validateLimit(opts.limit),
        opts.includeVectors === true,
        opts.filter !== undefined,
      ),
      variables: {
        vector: [...validateVector(vector)],
        ...(opts.filter === undefined ? {} : { where: weaviateWhere(opts.filter) }),
      },
    });
    return weaviateMatches(response, klass);
  }

  async delete(orgId: VectorOrgScope, collection: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const klass = className(orgId, collection);
    await Promise.all(
      ids.map((id) =>
        requestJson(
          this.id,
          this.#config,
          "DELETE",
          `/v1/objects/${encodeURIComponent(klass)}/${encodeURIComponent(id)}`,
        ),
      ),
    );
  }
}

function className(orgId: string | null, name: string): string {
  const scoped = scopedCollectionName(orgId, name);
  const normalized = scoped.replace(/[^A-Za-z0-9_]/g, "_");
  return normalized.length === 0 ? "HelixVector" : `Helix_${normalized}`;
}

function weaviateDistance(metric: VectorMetric): "cosine" | "dot" | "l2-squared" {
  if (metric === "cosine") {
    return "cosine";
  }
  if (metric === "dot") {
    return "dot";
  }
  return "l2-squared";
}

function weaviateGraphql(
  klass: string,
  limit: number,
  includeVector: boolean,
  includeWhere: boolean,
): string {
  const where = includeWhere ? "where: $where," : "";
  const vectorField = includeVector ? " vector" : "";
  return `query HelixVectorSearch($vector: [Float!]!, $where: WhereInput) { Get { ${klass}(nearVector: { vector: $vector }, ${where} limit: ${String(limit)}) { helixId metadata${vectorField} _additional { id score distance } } } }`;
}

function weaviateWhere(filter: Readonly<Record<string, unknown>>): JsonObject {
  const operands = Object.entries(filter).map(([key, value]) => ({
    path: ["metadata", key],
    operator: "Equal",
    valueText: typeof value === "string" ? value : JSON.stringify(value),
  }));
  const firstOperand = operands[0];
  return operands.length === 1 && firstOperand !== undefined
    ? firstOperand
    : { operator: "And", operands };
}

function weaviateMatches(response: unknown, klass: string): readonly VectorMatch[] {
  if (!isJsonObject(response) || !isJsonObject(response.data) || !isJsonObject(response.data.Get)) {
    return [];
  }
  const raw = response.data.Get[klass];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(weaviateMatch).filter((match): match is VectorMatch => match !== null);
}

function weaviateMatch(value: unknown): VectorMatch | null {
  if (!isJsonObject(value) || !isJsonObject(value._additional)) {
    return null;
  }
  const id = optionalString(value.helixId) ?? optionalString(value._additional.id);
  const score =
    optionalNumber(value._additional.score) ??
    distanceToScore(optionalNumber(value._additional.distance));
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

function distanceToScore(distance: number | undefined): number | undefined {
  return distance === undefined ? undefined : 1 / (1 + distance);
}
