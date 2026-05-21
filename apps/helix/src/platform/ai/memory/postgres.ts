import type postgres from "postgres";
import type { Actor, JsonObject } from "@helix/sdk-types";
import { validateVector, vectorToPgLiteral } from "../vector/types.js";
import {
  validateMemoryText,
  validateRecallLimit,
  type ForgetCriteria,
  type MemoryEmbeddingProvider,
  type MemoryInput,
  type MemoryItem,
  type MemoryStore,
} from "./types.js";

interface MemoryItemRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly source: string;
  readonly content: string;
  readonly metadata: JsonObject;
  readonly score: number | null;
  readonly created_at: Date;
  readonly expires_at: Date | null;
}

export interface PostgresMemoryStoreOptions {
  readonly embeddingProvider: MemoryEmbeddingProvider;
  readonly defaultSource?: string;
}

export class PostgresMemoryStore implements MemoryStore {
  readonly id = "per-actor-pgvector";
  readonly #defaultSource: string;

  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: PostgresMemoryStoreOptions,
  ) {
    this.#defaultSource = options.defaultSource ?? "assistant.conversation";
  }

  async recall(actor: Actor, query: string, k: number): Promise<readonly MemoryItem[]> {
    const content = validateMemoryText(query, "Memory recall query");
    const limit = validateRecallLimit(k);
    const embedding = await this.embedOne(content);
    const queryVector = vectorToPgLiteral(embedding);
    const selectedRows = await this.sql`
      select
        id,
        org_id,
        actor_id,
        source,
        content,
        metadata,
        1 - (embedding <=> ${queryVector}::vector) as score,
        created_at,
        expires_at
      from memory_items
      where org_id = ${actor.orgId}
        and actor_id = ${actor.id}
        and embedding is not null
        and (expires_at is null or expires_at > now())
      order by embedding <=> ${queryVector}::vector
      limit ${limit}
    `;
    const rows = selectedRows as unknown as readonly MemoryItemRow[];
    return rows.map(rowToMemoryItem);
  }

  async store(actor: Actor, item: MemoryInput): Promise<MemoryItem> {
    const content = validateMemoryText(item.content, "Memory content");
    const source = validateMemoryText(item.source ?? this.#defaultSource, "Memory source");
    const embedding = item.embedding ?? (await this.embedOne(content));
    validateVector(embedding);
    const insertedRows = await this.sql`
      insert into memory_items (org_id, actor_id, source, content, embedding, metadata, expires_at)
      values (
        ${actor.orgId},
        ${actor.id},
        ${source},
        ${content},
        ${vectorToPgLiteral(embedding)}::vector,
        ${this.sql.json(item.metadata ?? {})},
        ${item.expiresAt === undefined ? null : new Date(item.expiresAt)}
      )
      returning id, org_id, actor_id, source, content, metadata, null::double precision as score, created_at, expires_at
    `;
    const rows = insertedRows as unknown as readonly MemoryItemRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Failed to store memory item");
    }
    return rowToMemoryItem(row);
  }

  async forget(actor: Actor, criteria: ForgetCriteria): Promise<number> {
    if (criteria.all === true) {
      const deletedRows = await this.sql`
        delete from memory_items
        where org_id = ${actor.orgId}
          and actor_id = ${actor.id}
        returning id
      `;
      return (deletedRows as unknown as readonly unknown[]).length;
    }

    let deleted = 0;
    if (criteria.ids !== undefined && criteria.ids.length > 0) {
      const deletedRows = await this.sql`
        delete from memory_items
        where org_id = ${actor.orgId}
          and actor_id = ${actor.id}
          and id::text = any(${this.sql.array([...criteria.ids])})
        returning id
      `;
      deleted += (deletedRows as unknown as readonly unknown[]).length;
    }

    if (criteria.olderThan !== undefined) {
      const deletedRows = await this.sql`
        delete from memory_items
        where org_id = ${actor.orgId}
          and actor_id = ${actor.id}
          and created_at < ${new Date(criteria.olderThan)}
        returning id
      `;
      deleted += (deletedRows as unknown as readonly unknown[]).length;
    }

    return deleted;
  }

  private async embedOne(text: string): Promise<readonly number[]> {
    const embeddings = await this.options.embeddingProvider.embed([text]);
    const embedding = embeddings[0];
    if (embedding === undefined) {
      throw new Error("Memory embedding provider returned no embedding");
    }
    return validateVector(embedding);
  }
}

function rowToMemoryItem(row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    source: row.source,
    content: row.content,
    ...(row.score === null ? {} : { score: row.score }),
    ...(Object.keys(row.metadata).length === 0 ? {} : { metadata: row.metadata }),
    createdAt: row.created_at.toISOString(),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at.toISOString() }),
  };
}

