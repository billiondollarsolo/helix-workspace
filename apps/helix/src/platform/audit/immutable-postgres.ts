import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk";
import type { ImmutableAuditActivityRecord, ImmutableAuditShipResult } from "./immutable-s3.js";
import type { AuditBatchShipper } from "./shipping-worker.js";

/**
 * WORM-Postgres audit destination (`audit-immutable-postgres`).
 *
 * Appends shipped, hash-chained audit records into the
 * `audit_immutable_postgres` table created by migration 0020. The table is
 * write-once / read-many: a BEFORE UPDATE / DELETE / TRUNCATE trigger blocks
 * every mutation at the database level (see the migration). This shipper only
 * ever issues `insert`s, and re-shipping the same record is idempotent via
 * `on conflict (org_id, record_id) do nothing`.
 *
 * It implements {@link AuditBatchShipper}, so it is a drop-in alternative to
 * `shipImmutableAuditBatch` / {@link import("./siem-syslog.js").SiemAuditShipper}
 * for the `AuditShippingWorker`.
 *
 * server.ts wiring (do NOT edit server.ts here — register later):
 *
 * ```ts
 * import { PostgresWormAuditShipper } from "./platform/audit/immutable-postgres.js";
 * import { AuditShippingWorker } from "./platform/audit/shipping-worker.js";
 *
 * const wormAuditWorker = new AuditShippingWorker({
 *   store: auditStore,
 *   destination: "audit-immutable-postgres",
 *   batchSize: 500,
 *   intervalMs: 60_000,
 *   shipper: new PostgresWormAuditShipper(sql),
 * });
 * // ...started under LeaderElection, stopped in the graceful-shutdown drain.
 * ```
 */

const encoder = new TextEncoder();

export interface WormAuditRow {
  readonly worm_id: string;
  readonly record_id: string;
  readonly org_id: string;
  readonly this_hash: string;
}

export class PostgresWormAuditShipper implements AuditBatchShipper {
  constructor(private readonly sql: postgres.Sql) {}

  async ship(records: readonly ImmutableAuditActivityRecord[]): Promise<ImmutableAuditShipResult> {
    if (records.length === 0) {
      throw new TypeError("WORM Postgres audit shipper requires at least one record");
    }
    for (const record of records) {
      assertRecord(record);
    }

    await this.sql.begin(async (tx) => {
      for (const record of records) {
        const prevHash = record.prevHash ?? record.previousHash ?? null;
        await tx`
          insert into audit_immutable_postgres (
            record_id,
            org_id,
            actor_id,
            on_behalf_of_actor_id,
            verb,
            object_type,
            object_id,
            tool_id,
            trace_id,
            span_id,
            metadata,
            prev_hash,
            this_hash,
            record_created_at
          )
          values (
            ${record.id},
            ${record.orgId},
            ${record.actorId},
            ${record.onBehalfOfActorId ?? null},
            ${record.verb},
            ${record.objectType},
            ${record.objectId ?? null},
            ${record.toolId ?? null},
            ${record.trace?.traceId ?? null},
            ${record.trace?.spanId ?? null},
            ${tx.json(record.metadata ?? ({} satisfies JsonObject))},
            ${prevHash},
            ${record.thisHash},
            ${record.createdAt}
          )
          on conflict (org_id, record_id) do nothing
        `;
      }
    });

    const first = records[0];
    const last = records[records.length - 1];
    if (first === undefined || last === undefined) {
      throw new TypeError("WORM Postgres audit shipper requires at least one record");
    }

    const recordsDigest = digestOfRecords(records);
    return {
      batchId: `audit-immutable-postgres:${last.id}`,
      recordCount: records.length,
      recordsKey: "postgres://audit_immutable_postgres",
      recordsSha256: recordsDigest,
      manifestKey: "postgres://audit_immutable_postgres#manifest",
      manifestSha256: digestOfHashes([first.thisHash, last.thisHash, recordsDigest]),
    };
  }
}

/**
 * Read-only access to the WORM table — for the verifier / reconciliation.
 */
export class PostgresWormAuditReader {
  constructor(private readonly sql: postgres.Sql) {}

  async countForOrg(orgId: string): Promise<number> {
    const rows = (await this.sql`
      select count(*)::int as record_count
      from audit_immutable_postgres
      where org_id = ${orgId}
    `) as unknown as readonly { readonly record_count: number }[];
    return rows[0]?.record_count ?? 0;
  }

  async listHashesForOrg(orgId: string): Promise<readonly string[]> {
    const rows = (await this.sql`
      select this_hash
      from audit_immutable_postgres
      where org_id = ${orgId}
      order by record_created_at asc, record_id asc
    `) as unknown as readonly { readonly this_hash: string }[];
    return rows.map((row) => row.this_hash);
  }
}

function assertRecord(record: ImmutableAuditActivityRecord): void {
  if (record.id.length === 0) {
    throw new TypeError("WORM Postgres audit record id is required");
  }
  if (record.orgId.length === 0) {
    throw new TypeError("WORM Postgres audit record orgId is required");
  }
  if (record.actorId.length === 0 || record.verb.length === 0 || record.objectType.length === 0) {
    throw new TypeError("WORM Postgres audit record actorId, verb, and objectType are required");
  }
  if (Number.isNaN(Date.parse(record.createdAt))) {
    throw new TypeError("WORM Postgres audit record createdAt must be an ISO date string");
  }
  if (!/^[a-f0-9]{64}$/.test(record.thisHash)) {
    throw new TypeError("WORM Postgres audit record thisHash must be a lowercase sha256 hex digest");
  }
}

function digestOfRecords(records: readonly ImmutableAuditActivityRecord[]): string {
  return digestOfHashes(records.map((record) => record.thisHash));
}

function digestOfHashes(hashes: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of hashes) {
    hash.update(encoder.encode(`${value}\n`));
  }
  return hash.digest("hex");
}
