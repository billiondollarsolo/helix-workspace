import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import type { AdminConsoleAuditSink } from "../admin/console-shared.js";
import { auditAdminAction } from "../admin/console-shared.js";
import type { AntivirusScanner } from "./antivirus.js";

export type MailQuarantineStatus = "quarantined" | "rescanning" | "released" | "deleted";

export interface MailQuarantineRecord {
  readonly id: string;
  readonly orgId: string;
  readonly dedupKey: string;
  readonly status: MailQuarantineStatus;
  readonly envelopeFrom: string | null;
  readonly envelopeTo: readonly string[];
  readonly subject: string;
  readonly reasons: readonly string[];
  readonly authEvidence: JsonObject;
  readonly scanEvidence: JsonObject;
  /** Internal-only bytes. Admin serializers must never expose this field. */
  readonly rawMessage: Buffer | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly releasedAt: Date | null;
  readonly releasedBy: string | null;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
}

export interface MailQuarantineStore {
  quarantine(input: {
    readonly orgId: string;
    readonly dedupKey: string;
    readonly envelopeFrom: string | null;
    readonly envelopeTo: readonly string[];
    readonly subject: string;
    readonly reasons: readonly string[];
    readonly authEvidence: JsonObject;
    readonly scanEvidence: JsonObject;
    readonly rawMessage: Buffer;
  }): Promise<{ readonly record: MailQuarantineRecord; readonly duplicate: boolean }>;
  list(orgId: string): Promise<readonly MailQuarantineRecord[]>;
  claimForRelease(orgId: string, id: string): Promise<MailQuarantineRecord | null>;
  restoreAfterFailedRescan(input: {
    readonly orgId: string;
    readonly id: string;
    readonly scanEvidence: JsonObject;
    readonly reason: string;
  }): Promise<MailQuarantineRecord | null>;
  markReleased(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId: string;
  }): Promise<MailQuarantineRecord | null>;
  deleteQuarantine(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId: string;
  }): Promise<MailQuarantineRecord | null>;
}

interface QuarantineRow {
  readonly id: string;
  readonly org_id: string;
  readonly dedup_key: string;
  readonly status: MailQuarantineStatus;
  readonly envelope_from: string | null;
  readonly envelope_to: readonly string[];
  readonly subject: string;
  readonly reasons: readonly string[];
  readonly auth_evidence: JsonObject;
  readonly scan_evidence: JsonObject;
  readonly raw_message: Buffer | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly released_at: Date | null;
  readonly released_by: string | null;
  readonly deleted_at: Date | null;
  readonly deleted_by: string | null;
}

export class PostgresMailQuarantineStore implements MailQuarantineStore {
  constructor(private readonly sql: postgres.Sql) {}

  async quarantine(input: {
    readonly orgId: string;
    readonly dedupKey: string;
    readonly envelopeFrom: string | null;
    readonly envelopeTo: readonly string[];
    readonly subject: string;
    readonly reasons: readonly string[];
    readonly authEvidence: JsonObject;
    readonly scanEvidence: JsonObject;
    readonly rawMessage: Buffer;
  }): Promise<{ readonly record: MailQuarantineRecord; readonly duplicate: boolean }> {
    const rows = (await this.sql`
      insert into mail_quarantined_messages (
        org_id, dedup_key, envelope_from, envelope_to, subject, reasons,
        auth_evidence, scan_evidence, raw_message
      )
      values (
        ${input.orgId}, ${input.dedupKey}, ${input.envelopeFrom}, ${input.envelopeTo},
        ${input.subject}, ${input.reasons},
        ${this.sql.json(toSqlJson(input.authEvidence))},
        ${this.sql.json(toSqlJson(input.scanEvidence))},
        ${input.rawMessage}
      )
      on conflict (org_id, dedup_key) do nothing
      returning *
    `) as unknown as readonly QuarantineRow[];
    if (rows[0] !== undefined) return { record: mapRow(rows[0]), duplicate: false };
    const existing = (await this.sql`
      select * from mail_quarantined_messages
      where org_id = ${input.orgId} and dedup_key = ${input.dedupKey}
      limit 1
    `) as unknown as readonly QuarantineRow[];
    if (existing[0] === undefined) throw new Error("Unable to persist quarantined mail.");
    return { record: mapRow(existing[0]), duplicate: true };
  }

  async list(orgId: string): Promise<readonly MailQuarantineRecord[]> {
    const rows = (await this.sql`
      select * from mail_quarantined_messages
      where org_id = ${orgId} and status <> 'deleted'
      order by created_at desc, id desc
    `) as unknown as readonly QuarantineRow[];
    return rows.map(mapRow);
  }

  async claimForRelease(orgId: string, id: string): Promise<MailQuarantineRecord | null> {
    const rows = (await this.sql`
      update mail_quarantined_messages
      set status = 'rescanning', updated_at = now()
      where org_id = ${orgId} and id = ${id} and status = 'quarantined'
      returning *
    `) as unknown as readonly QuarantineRow[];
    return rows[0] === undefined ? null : mapRow(rows[0]);
  }

  async restoreAfterFailedRescan(input: {
    readonly orgId: string;
    readonly id: string;
    readonly scanEvidence: JsonObject;
    readonly reason: string;
  }): Promise<MailQuarantineRecord | null> {
    const rows = (await this.sql`
      update mail_quarantined_messages
      set
        status = 'quarantined',
        reasons = array(select distinct unnest(reasons || ${[input.reason]}::text[])),
        scan_evidence = ${this.sql.json(toSqlJson(input.scanEvidence))},
        updated_at = now()
      where org_id = ${input.orgId} and id = ${input.id} and status = 'rescanning'
      returning *
    `) as unknown as readonly QuarantineRow[];
    return rows[0] === undefined ? null : mapRow(rows[0]);
  }

  async markReleased(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId: string;
  }): Promise<MailQuarantineRecord | null> {
    const rows = (await this.sql`
      update mail_quarantined_messages
      set
        status = 'released',
        released_at = now(),
        released_by = ${input.actorId},
        raw_message = null,
        updated_at = now()
      where org_id = ${input.orgId} and id = ${input.id} and status = 'rescanning'
      returning *
    `) as unknown as readonly QuarantineRow[];
    return rows[0] === undefined ? null : mapRow(rows[0]);
  }

  async deleteQuarantine(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId: string;
  }): Promise<MailQuarantineRecord | null> {
    const rows = (await this.sql`
      update mail_quarantined_messages
      set
        status = 'deleted',
        deleted_at = now(),
        deleted_by = ${input.actorId},
        raw_message = null,
        updated_at = now()
      where org_id = ${input.orgId}
        and id = ${input.id}
        and status in ('quarantined', 'rescanning')
      returning *
    `) as unknown as readonly QuarantineRow[];
    return rows[0] === undefined ? null : mapRow(rows[0]);
  }
}

export class InMemoryMailQuarantineStore implements MailQuarantineStore {
  readonly #records = new Map<string, MailQuarantineRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async quarantine(
    input: Parameters<MailQuarantineStore["quarantine"]>[0],
  ): Promise<{ readonly record: MailQuarantineRecord; readonly duplicate: boolean }> {
    const existing = [...this.#records.values()].find(
      (record) => record.orgId === input.orgId && record.dedupKey === input.dedupKey,
    );
    if (existing !== undefined) return { record: existing, duplicate: true };
    const now = this.now();
    const record: MailQuarantineRecord = {
      id: randomUUID(),
      ...input,
      status: "quarantined",
      createdAt: now,
      updatedAt: now,
      releasedAt: null,
      releasedBy: null,
      deletedAt: null,
      deletedBy: null,
    };
    this.#records.set(record.id, record);
    return { record, duplicate: false };
  }

  async list(orgId: string): Promise<readonly MailQuarantineRecord[]> {
    return [...this.#records.values()].filter(
      (record) => record.orgId === orgId && record.status !== "deleted",
    );
  }

  async claimForRelease(orgId: string, id: string): Promise<MailQuarantineRecord | null> {
    const record = this.#records.get(id);
    if (record === undefined || record.orgId !== orgId || record.status !== "quarantined") {
      return null;
    }
    return this.#update(record, { status: "rescanning" });
  }

  async restoreAfterFailedRescan(
    input: Parameters<MailQuarantineStore["restoreAfterFailedRescan"]>[0],
  ): Promise<MailQuarantineRecord | null> {
    const record = this.#records.get(input.id);
    if (record === undefined || record.orgId !== input.orgId || record.status !== "rescanning") {
      return null;
    }
    return this.#update(record, {
      status: "quarantined",
      reasons: [...new Set([...record.reasons, input.reason])],
      scanEvidence: input.scanEvidence,
    });
  }

  async markReleased(
    input: Parameters<MailQuarantineStore["markReleased"]>[0],
  ): Promise<MailQuarantineRecord | null> {
    const record = this.#records.get(input.id);
    if (record === undefined || record.orgId !== input.orgId || record.status !== "rescanning") {
      return null;
    }
    return this.#update(record, {
      status: "released",
      releasedAt: this.now(),
      releasedBy: input.actorId,
      rawMessage: null,
    });
  }

  async deleteQuarantine(
    input: Parameters<MailQuarantineStore["deleteQuarantine"]>[0],
  ): Promise<MailQuarantineRecord | null> {
    const record = this.#records.get(input.id);
    if (
      record === undefined ||
      record.orgId !== input.orgId ||
      !["quarantined", "rescanning"].includes(record.status)
    ) {
      return null;
    }
    return this.#update(record, {
      status: "deleted",
      deletedAt: this.now(),
      deletedBy: input.actorId,
      rawMessage: null,
    });
  }

  #update(
    record: MailQuarantineRecord,
    patch: Partial<MailQuarantineRecord>,
  ): MailQuarantineRecord {
    const updated = { ...record, ...patch, updatedAt: this.now() };
    this.#records.set(updated.id, updated);
    return updated;
  }
}

export interface MailQuarantineReleaseScanner {
  rescan(rawMessage: Buffer): Promise<{
    readonly clean: boolean;
    readonly evidence: JsonObject;
  }>;
}

/** Reuse the same shared clamd-backed scanner used during inbound ingest. */
export function quarantineReleaseScannerFromAntivirus(
  scanner: AntivirusScanner,
): MailQuarantineReleaseScanner {
  return {
    async rescan(rawMessage) {
      const result = await scanner.scan(rawMessage);
      return {
        clean: result.scanned && !result.infected && result.disposition !== "quarantine",
        evidence: result.evidence,
      };
    },
  };
}

export class MailQuarantineService {
  constructor(
    private readonly options: {
      readonly store: MailQuarantineStore;
      readonly scanner: MailQuarantineReleaseScanner;
      readonly deliver: (record: MailQuarantineRecord, rawMessage: Buffer) => Promise<void>;
      readonly auditSink: AdminConsoleAuditSink;
    },
  ) {}

  list(orgId: string): Promise<readonly MailQuarantineRecord[]> {
    return this.options.store.list(orgId);
  }

  async release(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
    readonly reason: string;
    readonly confirmed: true;
  }): Promise<MailQuarantineRecord | null> {
    const record = await this.options.store.claimForRelease(input.orgId, input.id);
    if (record === null) return null;
    if (record.rawMessage === null) {
      await this.options.store.restoreAfterFailedRescan({
        orgId: input.orgId,
        id: input.id,
        scanEvidence: {},
        reason: "raw_message_unavailable",
      });
      return null;
    }
    let verdict: { readonly clean: boolean; readonly evidence: JsonObject };
    try {
      verdict = await this.options.scanner.rescan(record.rawMessage);
    } catch {
      verdict = { clean: false, evidence: { state: "scan_failed" } };
    }
    if (!verdict.clean) {
      await this.options.store.restoreAfterFailedRescan({
        orgId: input.orgId,
        id: input.id,
        scanEvidence: verdict.evidence,
        reason: "release_rescan_not_clean",
      });
      return null;
    }
    try {
      await this.options.deliver(record, record.rawMessage);
    } catch {
      await this.options.store.restoreAfterFailedRescan({
        orgId: input.orgId,
        id: input.id,
        scanEvidence: verdict.evidence,
        reason: "release_delivery_failed",
      });
      return null;
    }
    const released = await this.options.store.markReleased({
      orgId: input.orgId,
      id: input.id,
      actorId: input.actorId,
    });
    if (released !== null) {
      await auditAdminAction(this.options.auditSink, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "mail.quarantine.released",
        objectType: "mail_quarantine",
        objectId: input.id,
        metadata: { reason: input.reason },
      });
    }
    return released;
  }

  async delete(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
    readonly reason: string;
    readonly confirmed: true;
  }): Promise<MailQuarantineRecord | null> {
    const deleted = await this.options.store.deleteQuarantine({
      orgId: input.orgId,
      id: input.id,
      actorId: input.actorId,
    });
    if (deleted !== null) {
      await auditAdminAction(this.options.auditSink, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "mail.quarantine.deleted",
        objectType: "mail_quarantine",
        objectId: input.id,
        metadata: { reason: input.reason },
      });
    }
    return deleted;
  }
}

export function serializeMailQuarantine(record: MailQuarantineRecord): JsonObject {
  return {
    id: record.id,
    status: record.status,
    envelopeFrom: record.envelopeFrom,
    envelopeTo: [...record.envelopeTo],
    subject: record.subject,
    reasons: [...record.reasons],
    authEvidence: record.authEvidence,
    scanEvidence: record.scanEvidence,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    releasedAt: record.releasedAt?.toISOString() ?? null,
    deletedAt: record.deletedAt?.toISOString() ?? null,
  };
}

function mapRow(row: QuarantineRow): MailQuarantineRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    dedupKey: row.dedup_key,
    status: row.status,
    envelopeFrom: row.envelope_from,
    envelopeTo: row.envelope_to,
    subject: row.subject,
    reasons: row.reasons,
    authEvidence: row.auth_evidence,
    scanEvidence: row.scan_evidence,
    rawMessage: row.raw_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    releasedAt: row.released_at,
    releasedBy: row.released_by,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  };
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
