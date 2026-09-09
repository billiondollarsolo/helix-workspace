import type postgres from "postgres";
import type { AuditRecord, JsonObject } from "@helix/sdk";
import type { AuditLogRecord, AuditLogStore, ListAuditLogInput } from "./routes.js";
import type {
  AuditVerificationRecord,
  AuditVerificationStore,
  ListAuditVerificationRecordsInput,
} from "./verifier.js";
import type {
  AuditShippingBacklog,
  AuditShippingCheckpoint,
  AuditShippingStore,
  ListAuditShippingRecordsInput,
} from "./shipping-worker.js";
import type { ImmutableAuditActivityRecord } from "./immutable-s3.js";

export interface AuditAppendResult {
  readonly id: string;
  readonly thisHash: string;
}

export interface PostgresAuditStoreOptions {
  readonly onAppend?: (record: AuditRecord & { readonly orgId: string }) => void;
}

export class PostgresAuditStore
  implements AuditLogStore, AuditVerificationStore, AuditShippingStore
{
  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: PostgresAuditStoreOptions = {},
  ) {}

  async append(record: AuditRecord & { readonly orgId: string }): Promise<AuditAppendResult> {
    return this.sql.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${record.orgId}, true)`;
      const rows = await tx<{ readonly id: string; readonly this_hash: string }[]>`
        insert into activity (
          org_id,
          actor_id,
          verb,
          object_type,
          object_id,
          trace_id,
          payload,
          prev_hash,
          this_hash,
          created_at
        )
        values (
          ${record.orgId},
          ${record.actorId},
          ${record.verb},
          ${record.objectType},
          ${record.objectId ?? null},
          ${record.trace?.traceId ?? null},
          ${tx.json(record.metadata ?? ({} satisfies JsonObject))},
          null,
          '',
          ${new Date()}
        )
        returning id, this_hash
      `;
      this.options.onAppend?.(record);

      return {
        id: rows[0]?.id ?? "",
        thisHash: rows[0]?.this_hash ?? "",
      };
    });
  }

  async listRecords(input: ListAuditLogInput): Promise<readonly AuditLogRecord[]> {
    const actorId = input.actorId ?? null;
    const objectId = input.objectId ?? null;
    const verb = input.verb ?? null;
    const objectType = input.objectType ?? null;
    const cursorCreatedAt = input.cursor?.createdAt ?? null;
    const cursorId = input.cursor?.id ?? null;
    return this.sql.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${input.orgId}, true)`;
      const rows = await tx<AuditLogRow[]>`
        select
          id,
          org_id,
          actor_id,
          verb,
          object_type,
          object_id,
          trace_id,
          payload,
          prev_hash,
          this_hash,
          created_at
        from activity
        where org_id = ${input.orgId}
          and (${actorId}::uuid is null or actor_id = ${actorId}::uuid)
          and (${objectId}::uuid is null or object_id = ${objectId}::uuid)
          and (${verb}::text is null or verb = ${verb}::text)
          and (${objectType}::text is null or object_type = ${objectType}::text)
          and (
            ${cursorCreatedAt}::timestamptz is null
            or (created_at, id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
          )
        order by created_at desc, id desc
        limit ${input.limit}
      `;
      return rows.map(mapAuditLogRow);
    });
  }

  async listVerificationRecords(
    input: ListAuditVerificationRecordsInput,
  ): Promise<readonly AuditVerificationRecord[]> {
    return this.sql.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${input.orgId}, true)`;
      const rows = await tx<AuditVerificationRow[]>`
        select
          id,
          org_id,
          actor_id,
          verb,
          object_type,
          object_id,
          trace_id,
          payload,
          prev_hash,
          this_hash,
          created_at,
          schema_version,
          sequence::text as sequence
        from activity
        where org_id = ${input.orgId}
        order by activity.sequence asc
      `;
      return rows.map(mapAuditVerificationRow);
    });
  }

  async listVerificationOrgIds(): Promise<readonly string[]> {
    const rows = await this.sql<{ readonly org_id: string }[]>`
      select org_id
      from helix_list_audit_org_ids()
    `;
    return rows.map((row) => row.org_id);
  }

  async loadAuditShippingCheckpoint(destination: string): Promise<AuditShippingCheckpoint | null> {
    const rows = await this.sql<{ readonly value: unknown }[]>`
      select value
      from platform_config
      where key = ${checkpointKey(destination)}
      limit 1
    `;
    return parseCheckpoint(rows[0]?.value);
  }

  async saveAuditShippingCheckpoint(
    destination: string,
    checkpoint: AuditShippingCheckpoint,
  ): Promise<void> {
    await this.sql`
      insert into platform_config (key, value, sensitive, updated_by_actor_id, updated_at)
      values (
        ${checkpointKey(destination)},
        ${this.sql.json({ id: checkpoint.id, createdAt: checkpoint.createdAt } satisfies JsonObject)},
        false,
        null,
        now()
      )
      on conflict (key) do update set
        value = excluded.value,
        updated_at = excluded.updated_at
    `;
  }

  async listAuditShippingRecords(
    input: ListAuditShippingRecordsInput,
  ): Promise<readonly ImmutableAuditActivityRecord[]> {
    const cursorCreatedAt = input.after?.createdAt ?? null;
    const cursorId = input.after?.id ?? null;
    const rows = await this.sql<AuditShippingRow[]>`
      select
        id,
        org_id,
        actor_id,
        verb,
        object_type,
        object_id,
        trace_id,
        payload,
        prev_hash,
        this_hash,
        created_at,
        schema_version,
        sequence::text as sequence
      from helix_list_audit_shipping_records(
        ${cursorCreatedAt}::timestamptz,
        ${cursorId}::uuid,
        ${input.limit}
      )
    `;
    return rows.map(mapImmutableAuditActivityRow);
  }

  async getAuditShippingBacklog(
    after: AuditShippingCheckpoint | null,
  ): Promise<AuditShippingBacklog> {
    const cursorCreatedAt = after?.createdAt ?? null;
    const cursorId = after?.id ?? null;
    const rows = await this.sql<
      {
        readonly record_count: number;
        readonly oldest_created_at: Date | null;
      }[]
    >`
      select record_count::int, oldest_created_at
      from helix_get_audit_shipping_backlog(
        ${cursorCreatedAt}::timestamptz,
        ${cursorId}::uuid
      )
    `;
    const row = rows[0];
    return {
      recordCount: row?.record_count ?? 0,
      ...(row?.oldest_created_at === null || row?.oldest_created_at === undefined
        ? {}
        : { oldestCreatedAt: row.oldest_created_at.toISOString() }),
    };
  }
}

interface AuditLogRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string | null;
  readonly verb: string;
  readonly object_type: string;
  readonly object_id: string | null;
  readonly trace_id: string | null;
  readonly payload: JsonObject;
  readonly prev_hash: string | null;
  readonly this_hash: string;
  readonly created_at: Date;
}

function mapAuditLogRow(row: AuditLogRow): AuditLogRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    verb: row.verb,
    objectType: row.object_type,
    objectId: row.object_id,
    traceId: row.trace_id,
    payload: row.payload,
    prevHash: row.prev_hash,
    thisHash: row.this_hash,
    createdAt: row.created_at.toISOString(),
  };
}

interface AuditVerificationRow extends AuditLogRow {
  readonly schema_version: number;
  readonly sequence: string;
}

interface AuditShippingRow extends AuditLogRow {
  readonly schema_version: number;
  readonly sequence: string;
}

function mapAuditVerificationRow(row: AuditVerificationRow): AuditVerificationRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id ?? "system",
    verb: row.verb,
    objectType: row.object_type,
    metadata: row.payload,
    prevHash: row.prev_hash,
    thisHash: row.this_hash,
    createdAt: row.created_at.toISOString(),
    schemaVersion: row.schema_version,
    sequence: row.sequence,
    ...(row.object_id === null ? {} : { objectId: row.object_id }),
    ...(row.trace_id === null ? {} : { trace: { traceId: row.trace_id } }),
  };
}

function mapImmutableAuditActivityRow(row: AuditShippingRow): ImmutableAuditActivityRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id ?? "system",
    verb: row.verb,
    objectType: row.object_type,
    metadata: row.payload,
    prevHash: row.prev_hash,
    thisHash: row.this_hash,
    createdAt: row.created_at.toISOString(),
    schemaVersion: row.schema_version,
    sequence: row.sequence,
    ...(row.object_id === null ? {} : { objectId: row.object_id }),
    ...(row.trace_id === null ? {} : { trace: { traceId: row.trace_id } }),
  };
}

function checkpointKey(destination: string): string {
  return `audit.shipping.${destination}.checkpoint`;
}

function parseCheckpoint(value: unknown): AuditShippingCheckpoint | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as { readonly id?: unknown; readonly createdAt?: unknown };
  if (typeof candidate.id !== "string" || typeof candidate.createdAt !== "string") {
    return null;
  }
  return { id: candidate.id, createdAt: candidate.createdAt };
}
