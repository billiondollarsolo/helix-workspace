import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject, StorageObject } from "@helix/sdk-types";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
import { MailQuarantineIntegrityError } from "./errors.js";
import { MAIL_RAW_SOURCE_MAX_BYTES } from "./raw-source.js";

export interface QuarantineInboundMailInput {
  readonly orgId: string;
  readonly recipientAddresses: readonly string[];
  readonly raw: Buffer;
  readonly signature: string;
  readonly authentication: JsonObject;
  readonly scanEvidence: JsonObject;
  readonly envelopeFrom?: string | undefined;
  readonly remoteAddress?: string | undefined;
  readonly helo?: string | undefined;
  readonly providerDeliveryId?: string | undefined;
}

export interface MailQuarantineSummary {
  readonly id: string;
  readonly recipientAddresses: readonly string[];
  readonly envelopeFrom: string | null;
  readonly signature: string;
  readonly status: "pending" | "rechecking" | "released" | "deleted";
  readonly bytesDeleted: boolean;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

export interface MailQuarantinePayload extends QuarantineInboundMailInput {
  readonly id: string;
  readonly releaseToken: string;
}

export interface MailQuarantineStore {
  quarantine(input: QuarantineInboundMailInput): Promise<{ readonly id: string }>;
  listPending(orgId: string): Promise<readonly MailQuarantineSummary[]>;
  claimRelease(orgId: string, id: string): Promise<MailQuarantinePayload | null>;
  abortRelease(orgId: string, id: string, releaseToken: string): Promise<void>;
  release(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId: string;
    readonly messageId: string;
    readonly reason: string;
    readonly releaseToken: string;
  }): Promise<{ readonly resolved: boolean; readonly bytesDeleted: boolean }>;
  delete(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<{ readonly found: boolean; readonly bytesDeleted: boolean }>;
}

interface QuarantineRow {
  readonly id: string;
  readonly org_id: string;
  readonly recipient_addresses: readonly string[];
  readonly envelope_from: string | null;
  readonly remote_address: string | null;
  readonly helo: string | null;
  readonly provider_delivery_id: string | null;
  readonly storage_key: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly signature: string;
  readonly authentication: JsonObject;
  readonly scan_evidence: JsonObject;
  readonly status: "pending" | "rechecking" | "released" | "deleted";
  readonly release_token: string | null;
  readonly bytes_deleted_at: Date | null;
  readonly created_at: Date;
  readonly resolved_at: Date | null;
}

export class PostgresMailQuarantineStore implements MailQuarantineStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly storageResolver: TenantStorageResolver,
  ) {}

  async quarantine(input: QuarantineInboundMailInput): Promise<{ readonly id: string }> {
    if (input.raw.byteLength === 0 || input.raw.byteLength > MAIL_RAW_SOURCE_MAX_BYTES) {
      throw new RangeError("Quarantined mail must be between 1 byte and 50 MiB.");
    }
    const signature = input.signature.trim();
    if (signature.length === 0 || signature.length > 512) {
      throw new TypeError("Malware signature must be between 1 and 512 characters.");
    }
    const storage = (await this.storageResolver({ orgId: input.orgId }))?.client;
    if (storage === undefined) {
      throw new Error("Tenant storage is required for mail quarantine.");
    }
    const id = randomUUID();
    const sha256 = createHash("sha256").update(input.raw).digest("hex");
    const storageKey = `mail-quarantine/${id}/${sha256}.eml`;
    await storage.put({
      key: storageKey,
      body: input.raw,
      contentType: "application/octet-stream",
      metadata: { quarantineId: id, sha256 },
    });
    try {
      await this.sql`
        insert into mail_quarantines (
          id, org_id, recipient_addresses, envelope_from, remote_address, helo,
          provider_delivery_id, storage_key, byte_size, sha256, signature,
          authentication, scan_evidence
        )
        values (
          ${id}, ${input.orgId}, ${this.sql.array([...input.recipientAddresses])},
          ${input.envelopeFrom ?? null}, ${input.remoteAddress ?? null}, ${input.helo ?? null},
          ${input.providerDeliveryId ?? null}, ${storageKey}, ${input.raw.byteLength}, ${sha256},
          ${signature}, ${this.sql.json(toSqlJson(input.authentication))},
          ${this.sql.json(toSqlJson(input.scanEvidence))}
        )
      `;
    } catch (error) {
      await storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
    return { id };
  }

  async listPending(orgId: string): Promise<readonly MailQuarantineSummary[]> {
    const rows = await this.sql<QuarantineRow[]>`
      select id, recipient_addresses, envelope_from, signature, status,
        bytes_deleted_at, created_at, resolved_at
      from mail_quarantines
      where org_id = ${orgId}
        and (status = 'pending'
          or (status = 'rechecking' and release_lease_expires_at <= now()))
      order by created_at desc, id
      limit 200
    `;
    return rows.map((row) => ({
      id: row.id,
      recipientAddresses: row.recipient_addresses,
      envelopeFrom: row.envelope_from,
      signature: row.signature,
      status: row.status,
      bytesDeleted: row.bytes_deleted_at !== null,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    }));
  }

  async claimRelease(orgId: string, id: string): Promise<MailQuarantinePayload | null> {
    const rows = await this.sql<QuarantineRow[]>`
      update mail_quarantines
      set status = 'rechecking', release_token = gen_random_uuid(),
        release_lease_expires_at = now() + interval '5 minutes'
      where org_id = ${orgId} and id = ${id}
        and (status = 'pending'
          or (status = 'rechecking' and release_lease_expires_at <= now()))
      returning *
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const storage = (await this.storageResolver({ orgId }))?.client;
    try {
      if (storage === undefined) throw new MailQuarantineIntegrityError();
      const object = await storage.get(row.storage_key);
      if (object === null || object.key !== row.storage_key) {
        throw new MailQuarantineIntegrityError();
      }
      const raw = await verifiedBody(object.body, row.byte_size, row.sha256);
      return {
        id: row.id,
        releaseToken: requiredToken(row.release_token),
        orgId: row.org_id,
        recipientAddresses: row.recipient_addresses,
        raw,
        signature: row.signature,
        authentication: row.authentication,
        scanEvidence: row.scan_evidence,
        ...(row.envelope_from === null ? {} : { envelopeFrom: row.envelope_from }),
        ...(row.remote_address === null ? {} : { remoteAddress: row.remote_address }),
        ...(row.helo === null ? {} : { helo: row.helo }),
        ...(row.provider_delivery_id === null
          ? {}
          : { providerDeliveryId: row.provider_delivery_id }),
      };
    } catch (error) {
      if (row.release_token !== null) await this.abortRelease(orgId, id, row.release_token);
      throw error;
    }
  }

  async abortRelease(orgId: string, id: string, releaseToken: string): Promise<void> {
    await this.sql`
      update mail_quarantines
      set status = 'pending', release_token = null, release_lease_expires_at = null
      where org_id = ${orgId} and id = ${id}
        and status = 'rechecking' and release_token = ${releaseToken}
    `;
  }

  async release(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId: string;
    readonly messageId: string;
    readonly reason: string;
    readonly releaseToken: string;
  }): Promise<{ readonly resolved: boolean; readonly bytesDeleted: boolean }> {
    const rows = await this.sql<{ readonly storage_key: string }[]>`
      update mail_quarantines
      set status = 'released', released_message_id = ${input.messageId},
        resolved_by_actor_id = ${input.actorId}, resolution_reason = ${input.reason},
        resolved_at = now(), release_token = null, release_lease_expires_at = null
      where org_id = ${input.orgId} and id = ${input.id} and status = 'rechecking'
        and release_token = ${input.releaseToken}
      returning storage_key
    `;
    const row = rows[0];
    if (row === undefined) return { resolved: false, bytesDeleted: false };
    return {
      resolved: true,
      bytesDeleted: await this.deleteBytes(input.orgId, input.id, row.storage_key),
    };
  }

  async delete(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<{ readonly found: boolean; readonly bytesDeleted: boolean }> {
    const rows = await this.sql<{ readonly storage_key: string }[]>`
      with newly_deleted as (
        update mail_quarantines
        set status = 'deleted', resolved_by_actor_id = ${input.actorId},
          resolution_reason = ${input.reason}, resolved_at = now(),
          release_token = null, release_lease_expires_at = null
        where org_id = ${input.orgId} and id = ${input.id}
          and (status = 'pending'
            or (status = 'rechecking' and release_lease_expires_at <= now()))
        returning storage_key
      )
      select storage_key from newly_deleted
      union all
      select storage_key from mail_quarantines
      where org_id = ${input.orgId} and id = ${input.id}
        and status in ('released', 'deleted') and bytes_deleted_at is null
        and not exists (select 1 from newly_deleted)
    `;
    const row = rows[0];
    if (row === undefined) return { found: false, bytesDeleted: false };
    return {
      found: true,
      bytesDeleted: await this.deleteBytes(input.orgId, input.id, row.storage_key),
    };
  }

  private async deleteBytes(orgId: string, id: string, storageKey: string): Promise<boolean> {
    const storage = (await this.storageResolver({ orgId }))?.client;
    if (storage === undefined) return false;
    try {
      await storage.delete(storageKey);
      await this.sql`
        update mail_quarantines set bytes_deleted_at = now()
        where org_id = ${orgId} and id = ${id}
      `;
      return true;
    } catch {
      return false;
    }
  }
}

async function verifiedBody(
  body: StorageObject["body"],
  expectedSize: number,
  expectedSha256: string,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  for await (const chunk of body instanceof Uint8Array ? [body] : body) {
    byteSize += chunk.byteLength;
    if (byteSize > expectedSize || byteSize > MAIL_RAW_SOURCE_MAX_BYTES) {
      throw new MailQuarantineIntegrityError();
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (
    byteSize !== expectedSize ||
    createHash("sha256").update(bytes).digest("hex") !== expectedSha256
  ) {
    throw new MailQuarantineIntegrityError();
  }
  return bytes;
}

function toSqlJson(value: JsonObject): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function requiredToken(value: string | null): string {
  if (value === null) throw new MailQuarantineIntegrityError();
  return value;
}
