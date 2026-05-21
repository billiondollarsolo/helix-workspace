import type { JsonObject } from "@helix/sdk-types";

export type VectorMetric = "cosine" | "dot" | "l2";

export interface VectorItem {
  readonly id: string;
  readonly vector: readonly number[];
  readonly metadata?: JsonObject;
}

export interface VectorQueryOpts {
  readonly limit?: number;
  readonly filter?: JsonObject;
  readonly includeVectors?: boolean;
}

export interface VectorMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata?: JsonObject;
  readonly vector?: readonly number[];
}

export interface VectorStore {
  readonly id: string;
  createCollection(name: string, dim: number, metric: VectorMetric): Promise<void>;
  upsert(collection: string, items: readonly VectorItem[]): Promise<void>;
  query(collection: string, vector: readonly number[], opts?: VectorQueryOpts): Promise<readonly VectorMatch[]>;
  delete(collection: string, ids: readonly string[]): Promise<void>;
}

export function validateCollectionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new TypeError("Vector collection name is required");
  }
  return trimmed;
}

export function validateVector(vector: readonly number[], expectedDim?: number): readonly number[] {
  if (vector.length === 0) {
    throw new TypeError("Vector must contain at least one dimension");
  }
  if (expectedDim !== undefined && vector.length !== expectedDim) {
    throw new TypeError(
      `Vector dimension ${String(vector.length)} does not match expected dimension ${String(expectedDim)}`,
    );
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new TypeError("Vector values must be finite numbers");
    }
  }
  return vector;
}

export function validateDimension(dim: number): number {
  if (!Number.isSafeInteger(dim) || dim <= 0) {
    throw new TypeError("Vector dimension must be a positive safe integer");
  }
  return dim;
}

export function validateLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 10;
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("Vector query limit must be a positive safe integer");
  }
  return limit;
}

export function assertVectorMetric(metric: string): VectorMetric {
  if (metric !== "cosine" && metric !== "dot" && metric !== "l2") {
    throw new TypeError(`Unsupported vector metric: ${metric}`);
  }
  return metric;
}

export function vectorToPgLiteral(vector: readonly number[]): string {
  validateVector(vector);
  return `[${vector.map((value) => String(value)).join(",")}]`;
}
