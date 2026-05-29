import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import {
  assertVectorMetric,
  validateCollectionName,
  validateDimension,
  validateLimit,
  validateVector,
  vectorToPgLiteral,
  type VectorItem,
  type VectorMatch,
  type VectorMetric,
  type VectorOrgScope,
  type VectorQueryOpts,
  type VectorStore,
} from "./types.js";

interface VectorCollectionRow {
  readonly dim: number;
  readonly metric: VectorMetric;
}

interface VectorItemRow {
  readonly id: string;
  readonly metadata: JsonObject;
  readonly embedding: string | readonly number[] | null;
  readonly score: number;
}

export class PgVectorStore implements VectorStore {
  readonly id = "pgvector";

  constructor(private readonly sql: postgres.Sql) {}

  async createCollection(
    orgId: VectorOrgScope,
    name: string,
    dim: number,
    metric: VectorMetric,
  ): Promise<void> {
    const collection = validateCollectionName(name);
    // Collection rows are scoped per (org_id, name). A tenant cannot create or
    // mutate a collection that another tenant already owns under the same
    // name — the unique key includes org_id.
    await this.sql`
      insert into vector_collections (org_id, name, dim, metric)
      values (${orgId}, ${collection}, ${validateDimension(dim)}, ${assertVectorMetric(metric)})
      on conflict (org_id, name) do update
      set dim = excluded.dim, metric = excluded.metric, updated_at = now()
    `;
  }

  async upsert(
    orgId: VectorOrgScope,
    collectionName: string,
    items: readonly VectorItem[],
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const collection = validateCollectionName(collectionName);
    const collectionRow = await this.collection(orgId, collection);

    await this.sql.begin(async (tx) => {
      for (const item of items) {
        validateVector(item.vector, collectionRow.dim);
        const visibility = item.visibility ?? "org";
        if (visibility === "private" && item.ownerActorId === undefined) {
          throw new TypeError(
            `Private vector item ${item.id} requires ownerActorId`,
          );
        }
        const ownerActorId = visibility === "private" ? item.ownerActorId : null;
        await tx`
          insert into vector_items (
            org_id, collection_name, id,
            embedding, metadata, visibility, owner_actor_id
          )
          values (
            ${orgId}, ${collection}, ${item.id},
            ${vectorToPgLiteral(item.vector)}::vector, ${tx.json(item.metadata ?? {})},
            ${visibility}, ${ownerActorId ?? null}
          )
          on conflict (org_id, collection_name, id) do update
          set embedding = excluded.embedding,
              metadata = excluded.metadata,
              visibility = excluded.visibility,
              owner_actor_id = excluded.owner_actor_id,
              updated_at = now()
        `;
      }
    });
  }

  async query(
    orgId: VectorOrgScope,
    collectionName: string,
    vector: readonly number[],
    opts: VectorQueryOpts = {},
  ): Promise<readonly VectorMatch[]> {
    const collection = validateCollectionName(collectionName);
    const collectionRow = await this.collection(orgId, collection);
    validateVector(vector, collectionRow.dim);
    const limit = validateLimit(opts.limit);
    const queryVector = vectorToPgLiteral(vector);

    const rows =
      opts.filter === undefined
        ? await this.queryWithoutFilter(
            orgId,
            collection,
            collectionRow.metric,
            queryVector,
            limit,
            opts.includeVectors === true,
            opts.actorId,
          )
        : await this.queryWithFilter(
            orgId,
            collection,
            collectionRow.metric,
            queryVector,
            opts.filter,
            limit,
            opts.includeVectors === true,
            opts.actorId,
          );

    return rows.map((row) => ({
      id: row.id,
      score: row.score,
      ...(Object.keys(row.metadata).length === 0 ? {} : { metadata: row.metadata }),
      ...(row.embedding === null ? {} : { vector: parsePgVector(row.embedding) }),
    }));
  }

  async delete(
    orgId: VectorOrgScope,
    collectionName: string,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const collection = validateCollectionName(collectionName);
    await this.sql`
      delete from vector_items
      where org_id is not distinct from ${orgId}
        and collection_name = ${collection}
        and id = any(${this.sql.array([...ids])})
    `;
  }

  private async collection(orgId: VectorOrgScope, name: string): Promise<VectorCollectionRow> {
    const selectedRows = await this.sql`
      select dim, metric
      from vector_collections
      where org_id is not distinct from ${orgId}
        and name = ${name}
      limit 1
    `;
    const rows = selectedRows as unknown as readonly VectorCollectionRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Vector collection does not exist: ${name}`);
    }
    return row;
  }

  /**
   * Build the SQL visibility predicate. When actorId is set, the caller sees
   * org-shared items plus their own private items. When unset (default-safe),
   * only org-shared items are returned — a caller that hasn't been updated
   * for the RAG visibility model can never accidentally pull another user's
   * private embeddings.
   */
  private visibilityClause(actorId: string | undefined) {
    if (actorId === undefined) {
      return this.sql`and visibility = 'org'`;
    }
    return this.sql`and (visibility = 'org' or (visibility = 'private' and owner_actor_id = ${actorId}))`;
  }

  private async queryWithoutFilter(
    orgId: VectorOrgScope,
    collection: string,
    metric: VectorMetric,
    queryVector: string,
    limit: number,
    includeVectors: boolean,
    actorId: string | undefined,
  ): Promise<readonly VectorItemRow[]> {
    const visibility = this.visibilityClause(actorId);
    if (metric === "cosine") {
      const rows = await this.sql`
        select id, metadata, ${includeVectors ? this.sql`embedding::text` : this.sql`null`} as embedding, 1 - (embedding <=> ${queryVector}::vector) as score
        from vector_items
        where org_id is not distinct from ${orgId}
          and collection_name = ${collection}
          ${visibility}
        order by embedding <=> ${queryVector}::vector
        limit ${limit}
      `;
      return rows as unknown as readonly VectorItemRow[];
    }
    if (metric === "dot") {
      const rows = await this.sql`
        select id, metadata, ${includeVectors ? this.sql`embedding::text` : this.sql`null`} as embedding, -(embedding <#> ${queryVector}::vector) as score
        from vector_items
        where org_id is not distinct from ${orgId}
          and collection_name = ${collection}
          ${visibility}
        order by embedding <#> ${queryVector}::vector
        limit ${limit}
      `;
      return rows as unknown as readonly VectorItemRow[];
    }
    const rows = await this.sql`
      select id, metadata, ${includeVectors ? this.sql`embedding::text` : this.sql`null`} as embedding, 1 / (1 + (embedding <-> ${queryVector}::vector)) as score
      from vector_items
      where org_id is not distinct from ${orgId}
        and collection_name = ${collection}
        ${visibility}
      order by embedding <-> ${queryVector}::vector
      limit ${limit}
    `;
    return rows as unknown as readonly VectorItemRow[];
  }

  private async queryWithFilter(
    orgId: VectorOrgScope,
    collection: string,
    metric: VectorMetric,
    queryVector: string,
    filter: JsonObject,
    limit: number,
    includeVectors: boolean,
    actorId: string | undefined,
  ): Promise<readonly VectorItemRow[]> {
    const visibility = this.visibilityClause(actorId);
    if (metric === "cosine") {
      const rows = await this.sql`
        select id, metadata, ${includeVectors ? this.sql`embedding::text` : this.sql`null`} as embedding, 1 - (embedding <=> ${queryVector}::vector) as score
        from vector_items
        where org_id is not distinct from ${orgId}
          and collection_name = ${collection}
          and metadata @> ${this.sql.json(filter)}
          ${visibility}
        order by embedding <=> ${queryVector}::vector
        limit ${limit}
      `;
      return rows as unknown as readonly VectorItemRow[];
    }
    if (metric === "dot") {
      const rows = await this.sql`
        select id, metadata, ${includeVectors ? this.sql`embedding::text` : this.sql`null`} as embedding, -(embedding <#> ${queryVector}::vector) as score
        from vector_items
        where org_id is not distinct from ${orgId}
          and collection_name = ${collection}
          and metadata @> ${this.sql.json(filter)}
          ${visibility}
        order by embedding <#> ${queryVector}::vector
        limit ${limit}
      `;
      return rows as unknown as readonly VectorItemRow[];
    }
    const rows = await this.sql`
      select id, metadata, ${includeVectors ? this.sql`embedding::text` : this.sql`null`} as embedding, 1 / (1 + (embedding <-> ${queryVector}::vector)) as score
      from vector_items
      where org_id is not distinct from ${orgId}
        and collection_name = ${collection}
        and metadata @> ${this.sql.json(filter)}
        ${visibility}
      order by embedding <-> ${queryVector}::vector
      limit ${limit}
    `;
    return rows as unknown as readonly VectorItemRow[];
  }
}

function parsePgVector(value: string | readonly number[]): readonly number[] {
  if (typeof value !== "string") {
    return value;
  }
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .filter((part) => part.length > 0)
    .map((part) => Number.parseFloat(part));
}
