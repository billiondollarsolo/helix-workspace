import { createHash } from "node:crypto";
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
  VectorHttpError,
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
    validateDimension(dim);
    assertVectorMetric(metric);
    const existing = await this.getCollection(orgId, name);
    if (existing !== undefined) {
      assertCollection(existing, dim, metric);
      return;
    }
    try {
      await requestJson(
        this.id,
        this.#config,
        "PUT",
        `/collections/${encodeURIComponent(collection)}`,
        {
          vectors: { size: dim, distance: qdrantDistance(metric) },
        },
      );
    } catch (error) {
      // Another worker can create the same tenant collection concurrently.
      const concurrent = await this.getCollection(orgId, name);
      if (concurrent === undefined) throw error;
      assertCollection(concurrent, dim, metric);
    }
  }

  async getCollection(
    orgId: VectorOrgScope,
    name: string,
  ): Promise<{ dim: number; metric: VectorMetric } | undefined> {
    const collection = scopedCollectionName(orgId, validateCollectionName(name));
    let response: unknown;
    try {
      response = await requestJson(
        this.id,
        this.#config,
        "GET",
        `/collections/${encodeURIComponent(collection)}`,
      );
    } catch (error) {
      if (error instanceof VectorHttpError && error.status === 404) return undefined;
      throw error;
    }
    const result = isJsonObject(response) ? response.result : undefined;
    const config = isJsonObject(result) ? result.config : undefined;
    const params = isJsonObject(config) ? config.params : undefined;
    const vectors = isJsonObject(params) ? params.vectors : undefined;
    if (!isJsonObject(vectors) || typeof vectors.size !== "number")
      throw new TypeError("Qdrant collection has no supported vector configuration");
    const metric =
      vectors.distance === "Cosine"
        ? "cosine"
        : vectors.distance === "Dot"
          ? "dot"
          : vectors.distance === "Euclid"
            ? "l2"
            : undefined;
    if (metric === undefined) throw new TypeError("Qdrant collection metric is unsupported");
    return { dim: vectors.size, metric };
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
      "PUT",
      `/collections/${encodeURIComponent(scoped)}/points?wait=true`,
      {
        points: items.map((item) => {
          const visibility = item.visibility ?? "org";
          if (visibility === "private" && !item.ownerActorId)
            throw new TypeError("Private vector item requires ownerActorId");
          return {
            id: qdrantPointId(item.id),
            vector: [...validateVector(item.vector)],
            payload: {
              _helixId: item.id,
              _helixVisibility: visibility,
              _helixOwner: visibility === "private" ? (item.ownerActorId ?? null) : null,
              metadata: item.metadata ?? {},
            },
          };
        }),
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
      `/collections/${encodeURIComponent(scoped)}/points/search`,
      {
        vector: [...validateVector(vector)],
        limit: validateLimit(opts.limit),
        with_payload: true,
        with_vector: opts.includeVectors === true,
        filter: {
          must: metadataFilter(opts.filter ?? {}),
          should: [
            { key: "_helixVisibility", match: { value: "org" } },
            ...(opts.actorId === undefined
              ? []
              : [
                  {
                    must: [
                      { key: "_helixVisibility", match: { value: "private" } },
                      { key: "_helixOwner", match: { value: opts.actorId } },
                    ],
                  },
                ]),
          ],
        },
      },
    );
    const result = isJsonObject(response) && Array.isArray(response.result) ? response.result : [];
    return result.map(qdrantMatch).filter((match): match is VectorMatch => match !== null);
  }

  async delete(orgId: VectorOrgScope, collection: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const scoped = scopedCollectionName(orgId, validateCollectionName(collection));
    try {
      await requestJson(
        this.id,
        this.#config,
        "POST",
        `/collections/${encodeURIComponent(scoped)}/points/delete?wait=true`,
        {
          points: ids.map(qdrantPointId),
        },
      );
    } catch (error) {
      if (!(error instanceof VectorHttpError && error.status === 404)) throw error;
    }
  }

  async deleteByDocumentIds(
    orgId: VectorOrgScope,
    collection: string,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const scoped = scopedCollectionName(orgId, validateCollectionName(collection));
    try {
      await requestJson(
        this.id,
        this.#config,
        "POST",
        `/collections/${encodeURIComponent(scoped)}/points/delete?wait=true`,
        {
          filter: {
            should: [
              { key: "metadata.document.id", match: { any: [...ids] } },
              { key: "_helixId", match: { any: [...ids] } },
            ],
          },
        },
      );
    } catch (error) {
      if (!(error instanceof VectorHttpError && error.status === 404)) throw error;
    }
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
  return Object.entries(filter).map(([key, match]) => ({
    key: `metadata.${key}`,
    match: { value: match },
  }));
}

function qdrantMatch(value: unknown): VectorMatch | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const payload = optionalJsonObject(value.payload);
  const id = optionalString(payload?._helixId);
  const score = optionalNumber(value.score);
  if (id === undefined || score === undefined) {
    return null;
  }
  return withOptionalFields({
    id,
    score,
    metadata: optionalJsonObject(payload?.metadata),
    vector: optionalVector(value.vector),
  });
}

function qdrantPointId(sourceId: string): string {
  const bytes = createHash("sha256").update(sourceId).digest().subarray(0, 16);
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x50;
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertCollection(
  existing: { dim: number; metric: VectorMetric },
  dim: number,
  metric: VectorMetric,
): void {
  if (existing.dim !== dim || existing.metric !== metric)
    throw new TypeError("Qdrant collection dimensions or metric do not match");
}
