import type { JsonObject } from "@helix/sdk-types";

export type VectorMetric = "cosine" | "dot" | "l2";

/**
 * Per-item RAG visibility.
 *
 * - `"org"`: every member of the tenant org may retrieve this item. Used for
 *   embeddings derived from org-shared resources (a Drive file shared with the
 *   whole org, a published native doc, etc.).
 * - `"private"`: only the actor identified by `ownerActorId` may retrieve it.
 *   Used for embeddings derived from a single user's private content
 *   (personal Drive uploads, assistant-chat attachments the user did not
 *   share). Requires `ownerActorId` to be set.
 */
export type VectorVisibility = "org" | "private";

export interface VectorItem {
  readonly id: string;
  readonly vector: readonly number[];
  readonly metadata?: JsonObject;
  /** Defaults to `"org"` so callers that haven't been updated yet remain
   *  visible to everyone in the tenant. New code should set this explicitly. */
  readonly visibility?: VectorVisibility;
  /** Required when `visibility === "private"`; ignored when `"org"`. */
  readonly ownerActorId?: string;
}

export interface VectorQueryOpts {
  readonly limit?: number;
  readonly filter?: JsonObject;
  readonly includeVectors?: boolean;
  /**
   * The actor performing the retrieval. When set, the query returns
   * `visibility === "org"` items plus any `visibility === "private"` items
   * whose `ownerActorId === actorId`. When unset, only `"org"` items are
   * returned — i.e. callers that haven't been updated yet are safe by default
   * (they see no private rows from any user).
   */
  readonly actorId?: string;
}

export interface VectorMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata?: JsonObject;
  readonly vector?: readonly number[];
}

/**
 * Tenant-scope identifier passed through every {@link VectorStore} call so
 * adapters can constrain reads and writes to a single org. The string form is
 * always a tenant org id (UUID); `null` is reserved for explicit system /
 * cross-tenant maintenance code paths (e.g. background reseeders) and must be
 * audited by the caller — it MUST NOT be the default. Adapters that pass
 * `null` here read or mutate vectors across every tenant.
 */
export type VectorOrgScope = string | null;

export interface VectorStore {
  readonly id: string;
  /**
   * Create or upsert a collection definition. `orgId` namespaces the
   * collection to a single tenant so two tenants may reuse the same
   * collection name without colliding.
   */
  createCollection(orgId: VectorOrgScope, name: string, dim: number, metric: VectorMetric): Promise<void>;
  upsert(orgId: VectorOrgScope, collection: string, items: readonly VectorItem[]): Promise<void>;
  query(
    orgId: VectorOrgScope,
    collection: string,
    vector: readonly number[],
    opts?: VectorQueryOpts,
  ): Promise<readonly VectorMatch[]>;
  delete(orgId: VectorOrgScope, collection: string, ids: readonly string[]): Promise<void>;
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

/**
 * Tenant-namespace a collection name for vector adapters whose backing store
 * cannot enforce a separate org_id column (Qdrant, Milvus, Chroma, Weaviate).
 * The returned name is deterministic so concurrent callers from the same
 * tenant hit the same external collection. `null` (the explicit system
 * scope) leaves the collection name unscoped — callers that pass `null` MUST
 * audit and accept cross-tenant reach.
 */
export function scopedCollectionName(orgId: string | null, name: string): string {
  const collection = validateCollectionName(name);
  if (orgId === null) {
    return collection;
  }
  if (orgId.trim().length === 0) {
    throw new TypeError("Vector orgId must be a non-empty string or null");
  }
  // Replace characters that some external vector stores forbid in collection
  // names; UUIDs already only contain `[a-f0-9-]`, but guard against future
  // ids.
  const safeOrg = orgId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `org_${safeOrg}__${collection}`;
}
