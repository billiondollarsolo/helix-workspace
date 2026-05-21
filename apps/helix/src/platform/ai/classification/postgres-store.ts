import type postgres from "postgres";
import type {
  ClassificationSource,
  DataClassification,
  ResourceClassificationRecord,
  ResourceClassificationStore,
} from "./types.js";

interface ResourceClassificationRow {
  readonly org_id: string;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly classification: string;
  readonly source: string;
  readonly reason: string;
  readonly actor_id: string | null;
  readonly updated_at: Date;
}

/**
 * Postgres-backed {@link ResourceClassificationStore}.
 *
 * Replaces `InMemoryResourceClassificationStore` for durable, replica-shared
 * resource classification tags. Each (org, resourceType, resourceId) tuple is
 * upserted into the `resource_classifications` table created by migration
 * `0017_resource_classifications.sql`.
 */
export class PostgresResourceClassificationStore implements ResourceClassificationStore {
  constructor(private readonly sql: postgres.Sql) {}

  async get(input: {
    readonly orgId: string;
    readonly resourceType: string;
    readonly resourceId: string;
  }): Promise<ResourceClassificationRecord | null> {
    const rows = (await this.sql`
      select org_id, resource_type, resource_id, classification, source, reason, actor_id, updated_at
      from resource_classifications
      where org_id = ${input.orgId}
        and resource_type = ${input.resourceType}
        and resource_id = ${input.resourceId}
      limit 1
    `) as readonly ResourceClassificationRow[];
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async set(record: ResourceClassificationRecord): Promise<void> {
    await this.sql`
      insert into resource_classifications (
        org_id, resource_type, resource_id, classification, source, reason, actor_id, updated_at
      )
      values (
        ${record.orgId},
        ${record.resourceType},
        ${record.resourceId},
        ${record.classification},
        ${record.source},
        ${record.reason},
        ${record.actorId ?? null},
        ${new Date(record.updatedAt)}
      )
      on conflict (org_id, resource_type, resource_id)
      do update set
        classification = excluded.classification,
        source = excluded.source,
        reason = excluded.reason,
        actor_id = excluded.actor_id,
        updated_at = excluded.updated_at
    `;
  }

  /** Lists classifications for an org, most-recently-updated first. */
  async list(input: {
    readonly orgId: string;
    readonly limit?: number;
  }): Promise<readonly ResourceClassificationRecord[]> {
    const limit = clampLimit(input.limit);
    const rows = (await this.sql`
      select org_id, resource_type, resource_id, classification, source, reason, actor_id, updated_at
      from resource_classifications
      where org_id = ${input.orgId}
      order by updated_at desc, resource_type asc, resource_id asc
      limit ${limit}
    `) as readonly ResourceClassificationRow[];
    return rows.map(toRecord);
  }
}

function toRecord(row: ResourceClassificationRow): ResourceClassificationRecord {
  return {
    orgId: row.org_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    classification: row.classification as DataClassification,
    source: row.source as ClassificationSource,
    reason: row.reason,
    ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
    updatedAt: row.updated_at.toISOString(),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 200;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 1000);
}
