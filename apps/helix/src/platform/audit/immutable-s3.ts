import { createHash, randomUUID } from "node:crypto";
import type { AuditRecord, JsonObject, JsonValue, MeteringClient, StorageClient } from "@helix/sdk";
import { canonicalJson } from "./hash.js";

export type ImmutableAuditObjectLockMode = "COMPLIANCE" | "GOVERNANCE";

export interface ImmutableAuditObjectLock {
  readonly mode: ImmutableAuditObjectLockMode;
  readonly retainUntil: string;
}

export interface ImmutableAuditObject {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly metadata: Record<string, string>;
  readonly objectLock?: ImmutableAuditObjectLock;
}

export interface ImmutableAuditObjectStore {
  putObject(object: ImmutableAuditObject): Promise<void>;
}

export interface ImmutableAuditActivityRecord extends AuditRecord {
  readonly id: string;
  readonly orgId: string;
  readonly createdAt: string;
  readonly thisHash: string;
  readonly prevHash?: string | null;
}

export interface ImmutableS3AuditShipperOptions {
  readonly store: ImmutableAuditObjectStore | StorageClient;
  readonly metering?: MeteringClient;
  readonly onMeteringError?: (error: unknown) => void;
  readonly prefix?: string;
  readonly batchSize?: number;
  readonly maxBatchBytes?: number;
  readonly objectLockMode?: ImmutableAuditObjectLockMode;
  readonly retentionDays?: number;
  readonly now?: () => Date;
  readonly batchId?: () => string;
}

export interface ImmutableAuditShipResult {
  readonly batchId: string;
  readonly recordCount: number;
  readonly recordsKey: string;
  readonly recordsSha256: string;
  readonly manifestKey: string;
  readonly manifestSha256: string;
  readonly objectLock?: ImmutableAuditObjectLock;
}

interface NormalizedOptions {
  readonly store: ImmutableAuditObjectStore;
  readonly metering?: MeteringClient;
  readonly onMeteringError?: (error: unknown) => void;
  readonly prefix: string;
  readonly batchSize: number;
  readonly maxBatchBytes: number;
  readonly objectLockMode: ImmutableAuditObjectLockMode;
  readonly retentionDays: number;
  readonly now: () => Date;
  readonly batchId: () => string;
}

const encoder = new TextEncoder();
const defaultPrefix = "audit/activity";
const defaultBatchSize = 500;
const defaultMaxBatchBytes = 5 * 1024 * 1024;
const defaultRetentionDays = 365;
const ndjsonContentType = "application/x-ndjson; charset=utf-8";
const manifestContentType = "application/json; charset=utf-8";

export class ImmutableS3AuditShipper {
  readonly #options: NormalizedOptions;
  readonly #pending: ImmutableAuditActivityRecord[] = [];
  #pendingBytes = 0;

  constructor(options: ImmutableS3AuditShipperOptions) {
    this.#options = normalizeOptions(options);
  }

  async append(record: ImmutableAuditActivityRecord): Promise<ImmutableAuditShipResult | null> {
    assertRecord(record);
    const bytes = estimateRecordBytes(record);

    if (this.#pending.length > 0 && this.#pendingBytes + bytes > this.#options.maxBatchBytes) {
      const result = await this.flush();
      this.#pending.push(record);
      this.#pendingBytes = bytes;
      return result;
    }

    this.#pending.push(record);
    this.#pendingBytes += bytes;

    if (this.#pending.length >= this.#options.batchSize || this.#pendingBytes >= this.#options.maxBatchBytes) {
      return this.flush();
    }

    return null;
  }

  async flush(): Promise<ImmutableAuditShipResult | null> {
    if (this.#pending.length === 0) {
      return null;
    }

    const records = this.#pending.splice(0, this.#pending.length);
    this.#pendingBytes = 0;
    return writeImmutableAuditBatch(this.#options, records);
  }
}

export async function shipImmutableAuditBatch(
  options: ImmutableS3AuditShipperOptions,
  records: readonly ImmutableAuditActivityRecord[],
): Promise<ImmutableAuditShipResult> {
  return writeImmutableAuditBatch(normalizeOptions(options), records);
}

export function createStorageClientImmutableAuditStore(storage: StorageClient): ImmutableAuditObjectStore {
  return {
    async putObject(object: ImmutableAuditObject): Promise<void> {
      await storage.put({
        key: object.key,
        body: object.body,
        contentType: object.contentType,
        metadata: {
          ...object.metadata,
          ...(object.objectLock === undefined
            ? {}
            : {
                "object-lock-mode": object.objectLock.mode,
                "object-lock-retain-until": object.objectLock.retainUntil,
              }),
        },
      });
    },
  };
}

async function writeImmutableAuditBatch(
  options: NormalizedOptions,
  records: readonly ImmutableAuditActivityRecord[],
): Promise<ImmutableAuditShipResult> {
  if (records.length === 0) {
    throw new TypeError("immutable audit shipper requires at least one record");
  }

  for (const record of records) {
    assertRecord(record);
  }

  const batchId = options.batchId();
  if (batchId.length === 0 || batchId.includes("/")) {
    throw new TypeError("immutable audit shipper batch id must be a non-empty path segment");
  }

  const createdAt = options.now();
  const objectLock = objectLockFor(options, createdAt);
  const orgSegment = commonOrgSegment(records);
  const keyPrefix = joinKey(options.prefix, datePrefix(createdAt), orgSegment);
  const recordsKey = joinKey(keyPrefix, `${batchId}.ndjson`);
  const manifestKey = joinKey(keyPrefix, `${batchId}.manifest.json`);
  const recordsBody = encodeRecords(records);
  const recordsSha256 = sha256Hex(recordsBody);
  const manifest = createManifest({
    batchId,
    createdAt,
    records,
    recordsKey,
    recordsSha256,
    manifestKey,
    objectLock,
  });
  const manifestBody = encodeJson(manifest);
  const manifestSha256 = sha256Hex(manifestBody);
  const baseMetadata = {
    "helix-kind": "audit-activity",
    "helix-batch-id": batchId,
    "helix-record-count": String(records.length),
    "helix-created-at": createdAt.toISOString(),
  };

  await options.store.putObject({
    key: recordsKey,
    body: recordsBody,
    contentType: ndjsonContentType,
    metadata: {
      ...baseMetadata,
      "helix-sha256": recordsSha256,
      "helix-manifest-key": manifestKey,
    },
    objectLock,
  });
  await options.store.putObject({
    key: manifestKey,
    body: manifestBody,
    contentType: manifestContentType,
    metadata: {
      ...baseMetadata,
      "helix-kind": "audit-manifest",
      "helix-sha256": manifestSha256,
      "helix-records-key": recordsKey,
      "helix-records-sha256": recordsSha256,
    },
    objectLock,
  });
  emitImmutableAuditStorageDelta({
    metering: options.metering,
    onMeteringError: options.onMeteringError,
    orgId: commonOrgId(records),
    byteDelta: recordsBody.byteLength + manifestBody.byteLength,
  });

  return {
    batchId,
    recordCount: records.length,
    recordsKey,
    recordsSha256,
    manifestKey,
    manifestSha256,
    objectLock,
  };
}

function normalizeOptions(options: ImmutableS3AuditShipperOptions): NormalizedOptions {
  const batchSize = options.batchSize ?? defaultBatchSize;
  const maxBatchBytes = options.maxBatchBytes ?? defaultMaxBatchBytes;
  const retentionDays = options.retentionDays ?? defaultRetentionDays;

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError("immutable audit shipper batchSize must be a positive integer");
  }
  if (!Number.isInteger(maxBatchBytes) || maxBatchBytes < 1) {
    throw new TypeError("immutable audit shipper maxBatchBytes must be a positive integer");
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new TypeError("immutable audit shipper retentionDays must be a positive integer");
  }

  return {
    store: isImmutableAuditObjectStore(options.store) ? options.store : createStorageClientImmutableAuditStore(options.store),
    ...(options.metering === undefined ? {} : { metering: options.metering }),
    ...(options.onMeteringError === undefined ? {} : { onMeteringError: options.onMeteringError }),
    prefix: trimSlashes(options.prefix ?? defaultPrefix),
    batchSize,
    maxBatchBytes,
    objectLockMode: options.objectLockMode ?? "COMPLIANCE",
    retentionDays,
    now: options.now ?? (() => new Date()),
    batchId: options.batchId ?? randomUUID,
  };
}

function emitImmutableAuditStorageDelta(input: {
  readonly metering?: MeteringClient | undefined;
  readonly onMeteringError?: ((error: unknown) => void) | undefined;
  readonly orgId: string | undefined;
  readonly byteDelta: number;
}): void {
  if (input.orgId === undefined || input.byteDelta === 0) {
    return;
  }

  void input.metering
    ?.emit(input.orgId, {
      type: "storage.delta",
      quantity: input.byteDelta,
      metadata: {
        bucket: "audit_immutable_s3",
        byte_delta: input.byteDelta,
      },
    })
    .catch((error: unknown) => {
      input.onMeteringError?.(error);
    });
}

function isImmutableAuditObjectStore(store: ImmutableAuditObjectStore | StorageClient): store is ImmutableAuditObjectStore {
  return "putObject" in store;
}

function assertRecord(record: ImmutableAuditActivityRecord): void {
  if (record.id.length === 0) {
    throw new TypeError("immutable audit record id is required");
  }
  if (record.orgId.length === 0) {
    throw new TypeError("immutable audit record orgId is required");
  }
  if (record.actorId.length === 0 || record.verb.length === 0 || record.objectType.length === 0) {
    throw new TypeError("immutable audit record actorId, verb, and objectType are required");
  }
  if (Number.isNaN(Date.parse(record.createdAt))) {
    throw new TypeError("immutable audit record createdAt must be an ISO date string");
  }
  if (!/^[a-f0-9]{64}$/.test(record.thisHash)) {
    throw new TypeError("immutable audit record thisHash must be a lowercase sha256 hex digest");
  }
}

function estimateRecordBytes(record: ImmutableAuditActivityRecord): number {
  return encoder.encode(canonicalJson(toExportRecord(record))).byteLength + 1;
}

function encodeRecords(records: readonly ImmutableAuditActivityRecord[]): Uint8Array {
  return encoder.encode(records.map((record) => canonicalJson(toExportRecord(record))).join("\n") + "\n");
}

function toExportRecord(record: ImmutableAuditActivityRecord): JsonObject {
  return {
    actorId: record.actorId,
    createdAt: record.createdAt,
    id: record.id,
    metadata: record.metadata ?? {},
    objectId: record.objectId ?? null,
    objectType: record.objectType,
    onBehalfOfActorId: record.onBehalfOfActorId ?? null,
    orgId: record.orgId,
    prevHash: record.prevHash ?? record.previousHash ?? null,
    spanId: record.trace?.spanId ?? null,
    thisHash: record.thisHash,
    toolId: record.toolId ?? null,
    traceId: record.trace?.traceId ?? null,
    verb: record.verb,
  };
}

function createManifest(input: {
  readonly batchId: string;
  readonly createdAt: Date;
  readonly records: readonly ImmutableAuditActivityRecord[];
  readonly recordsKey: string;
  readonly recordsSha256: string;
  readonly manifestKey: string;
  readonly objectLock?: ImmutableAuditObjectLock;
}): JsonObject {
  const first = input.records[0];
  const last = input.records.at(-1);

  if (first === undefined || last === undefined) {
    throw new TypeError("immutable audit manifest requires records");
  }

  const manifest: Record<string, JsonValue> = {
    batchId: input.batchId,
    createdAt: input.createdAt.toISOString(),
    firstCreatedAt: first.createdAt,
    format: "helix.audit.immutable-s3.v1",
    hashChain: {
      firstPrevHash: first.prevHash ?? first.previousHash ?? null,
      lastThisHash: last.thisHash,
    },
    lastCreatedAt: last.createdAt,
    manifestKey: input.manifestKey,
    recordCount: input.records.length,
    recordIds: input.records.map((record) => record.id),
    recordsKey: input.recordsKey,
    recordsSha256: input.recordsSha256,
  };

  if (input.objectLock !== undefined) {
    manifest.objectLock = {
      mode: input.objectLock.mode,
      retainUntil: input.objectLock.retainUntil,
    } satisfies JsonObject;
  }

  return manifest;
}

function objectLockFor(options: NormalizedOptions, from: Date): ImmutableAuditObjectLock {
  const retainUntil = new Date(from.getTime() + options.retentionDays * 24 * 60 * 60 * 1000);
  return {
    mode: options.objectLockMode,
    retainUntil: retainUntil.toISOString(),
  };
}

function commonOrgSegment(records: readonly ImmutableAuditActivityRecord[]): string {
  const firstOrgId = records[0]?.orgId;
  if (firstOrgId === undefined) {
    return "unknown-org";
  }

  return records.every((record) => record.orgId === firstOrgId) ? safeSegment(firstOrgId) : "multi-org";
}

function commonOrgId(records: readonly ImmutableAuditActivityRecord[]): string | undefined {
  const firstOrgId = records[0]?.orgId;
  if (firstOrgId === undefined) {
    return undefined;
  }
  return records.every((record) => record.orgId === firstOrgId) ? firstOrgId : undefined;
}

function datePrefix(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "/");
}

function joinKey(...parts: readonly string[]): string {
  return parts.map(trimSlashes).filter((part) => part.length > 0).join("/");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function safeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeJson(value: JsonValue): Uint8Array {
  return encoder.encode(`${canonicalJson(value)}\n`);
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
