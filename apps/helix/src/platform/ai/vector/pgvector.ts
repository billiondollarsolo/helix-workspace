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

  async createCollection(name: string, dim: number, metric: VectorMetric): Promise<void> {
    const collection = validateCollectionName(name);
    await this.sql`
      insert into vector_collections (name, dim, metric)
      values (${collection}, ${validateDimension(dim)}, ${assertVectorMetric(metric)})
      on conflict (name) do update
      set dim = excluded.dim, metric = excluded.metric, updated_at = now()
    `;
  }

  async upsert(collectionName: string, items: readonly VectorItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const collection = validateCollectionName(collectionName);
    const collectionRow = await this.collection(collection);

    await this.sql.begin(async (tx) => {
      for (const item of items) {
        validateVector(item.vector, collectionRow.dim);
        await tx`
          insert into vector_items (collection_name, id, embedding, metadata)
          values (${collection}, ${item.id}, ${vectorToPgLiteral(item.vector)}::vector, ${tx.json(item.metadata ?? {})})
          on conflict (collection_name, id) do update
          set embedding = excluded.embedding, metadata = excluded.metadata, updated_at = now()
        `;
      }
    });
  }

  async query(collectionName: string, vector: readonly number[], opts: VectorQueryOpts = {}): Promise<readonly VectorMatch[]> {
    const collection = validateCollectionName(collectionName);
    const collectionRow = await this.collection(collection);
    validateVector(vector, collectionRow.dim);
    const limit = validateLimit(opts.limit);
    const queryVector = vectorToPgLiteral(vector);

    const rows =
      opts.filter === undefined
        ? await this.queryWithoutFilter(collection, collectionRow.metric, queryVector, limit, opts.includeVectors === true)
        : await this.queryWithFilter(collection, collectionRow.metric, queryVector, opts.filter, limit, opts.includeVectors === true);

    return rows.map((row) => ({
      id: row.id,
      score: row.score,
      ...(Object.keys(row.metadata).length === 0 ? {} : { metadata: row.metadata }),
      ...(row.embedding === null ? {} : { vector: parsePgVector(row.embedding) }),
    }));
  }

  async delete(collectionName: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const collection = validateCollectionName(collectionName);
    await this.sql`
      delete from vector_items
      where collection_name = ${collection}
        and id = any(${this.sql.array([...ids])})
    `;
  }

  private async collection(name: string): Promise<VectorCollectionRow> {
    const selectedRows = await this.sql`
      select dim, metric
      from vector_collections
      where name = ${name}
      limit 1
    `;
    const rows = selectedRows as unknown as readonly VectorCollectionRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Vector collection does not exist: ${name}`);
    }
    return row;
  }

  private async queryWithoutFilter(
    collection: string,
    metric: VectorMetric,
    queryVector: string,
    limit: number,
    includeVectors: boolean,
  ): Promise<readonly VectorItemRow[]> {
    if (metric === "cosine") {
      const rows = await this.sql`
        select id, metadata, ${includeVectors ? this.sql`embedding::text` : this.sql`null`} as embedding, 1 - (embedding <=> ${queryVector}::vector) as score
        from vector_items
        where collection_name = ${collection}
        order by embedding <=> ${queryVector}::vector
        limit ${limit}
      `;
      return rows as unknown as readonly VectorItemRow[];
    }
    if (metric === "dot") {
      const rows = await this.sql`
        select id, metadata, ${includeVectors ? this.sql`embedding::text` : this.sql`null`} as embedding, -(embedding <#> ${queryVector}::vector) as score
        from vector_items
        where collection_name = ${collection}
        order by embedding <#> ${queryVector}::vector
        limit ${limit}
      `;
      return rows as unknown as readonly VectorItemRow[];
    }
    const rows = await this.sql`
      select id, metadata, ${includeVectors ? this.sql`embedding::text` : this.sql`null`} as embedding, 1 / (1 + (embedding <-> ${queryVector}::vector)) as score
      from vector_items
      where collection_name = ${collection}
      order by embedding <-> ${queryVector}::vector
      limit ${limit}
    `;
    return rows as unknown as readonly VectorItemRow[];
  }

  private async queryWithFilter(
    collection: string,
    metric: VectorMetric,
    queryVector: string,
    filter: JsonObject,
    limit: number,
    includeVectors: boolean,
  ): Promise<readonly VectorItemRow[]> {
    if (metric === "cosine") {
      const rows = await this.sql`
        select id, metadata, ${includeVectors ? this.sql`embedding::text` : this.sql`null`} as embedding, 1 - (embedding <=> ${queryVector}::vector) as score
        from vector_items
        where collection_name = ${collection}
          and metadata @> ${this.sql.json(filter)}
        order by embedding <=> ${queryVector}::vector
        limit ${limit}
      `;
      return rows as unknown as readonly VectorItemRow[];
    }
    if (metric === "dot") {
      const rows = await this.sql`
        select id, metadata, ${includeVectors ? this.sql`embedding::text` : this.sql`null`} as embedding, -(embedding <#> ${queryVector}::vector) as score
        from vector_items
        where collection_name = ${collection}
          and metadata @> ${this.sql.json(filter)}
        order by embedding <#> ${queryVector}::vector
        limit ${limit}
      `;
      return rows as unknown as readonly VectorItemRow[];
    }
    const rows = await this.sql`
      select id, metadata, ${includeVectors ? this.sql`embedding::text` : this.sql`null`} as embedding, 1 / (1 + (embedding <-> ${queryVector}::vector)) as score
      from vector_items
      where collection_name = ${collection}
        and metadata @> ${this.sql.json(filter)}
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
