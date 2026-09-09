import { createHash } from "node:crypto";
import type { JsonObject, StorageClient } from "@helix/sdk";
import {
  encodeAuditAnchorPayload,
  type AuditAnchorAuthentication,
  type AuditAnchorVerifier,
} from "./immutable-s3.js";
import type { AuditVerificationStore } from "./verifier.js";
import { verifyAuditHashChain } from "./verifier.js";

export interface AuditAnchorArchive {
  getObject(key: string): Promise<Uint8Array | null>;
  listKeys(prefix: string): AsyncIterable<string>;
}

export interface AuditAnchorReconcilerOptions {
  readonly archive: AuditAnchorArchive;
  readonly audit: AuditVerificationStore;
  readonly verifier: AuditAnchorVerifier;
  readonly prefix?: string;
}

export interface AuditAnchorReconciliationResult {
  readonly manifestCount: number;
  readonly organizationCount: number;
}

interface AnchorTail {
  readonly id: string;
  readonly orgId: string;
  readonly sequence: string;
  readonly thisHash: string;
}

const decoder = new TextDecoder();

export async function reconcileAuditAnchors(
  options: AuditAnchorReconcilerOptions,
): Promise<AuditAnchorReconciliationResult> {
  const latest = new Map<string, AnchorTail>();
  let manifestCount = 0;

  const prefix = (options.prefix ?? "audit/activity").replace(/^\/+|\/+$/g, "");
  // ponytail: full sweep avoids a database-owned cursor; add an externally signed cursor when archive scale requires it.
  for await (const key of options.archive.listKeys(prefix)) {
    if (!key.endsWith(".manifest.json")) continue;
    const anchor = await readAnchor(options.archive, options.verifier, key);
    const previous = latest.get(anchor.orgId);
    if (previous === undefined || BigInt(anchor.sequence) > BigInt(previous.sequence)) {
      latest.set(anchor.orgId, anchor);
    } else if (
      anchor.sequence === previous.sequence &&
      (anchor.id !== previous.id || anchor.thisHash !== previous.thisHash)
    ) {
      throw new Error(`Conflicting immutable audit anchors for ${anchor.orgId}`);
    }
    manifestCount += 1;
  }

  for (const anchor of latest.values()) {
    const records = await options.audit.listVerificationRecords({ orgId: anchor.orgId });
    const chain = verifyAuditHashChain(records);
    if (!chain.valid) {
      throw new Error(`Audit database chain no longer verifies for ${anchor.orgId}`);
    }
    const anchoredRecord = records.find((record) => record.sequence === anchor.sequence);
    if (anchoredRecord?.id !== anchor.id || anchoredRecord.thisHash !== anchor.thisHash) {
      throw new Error(`Audit database does not match immutable anchor for ${anchor.orgId}`);
    }
  }

  return { manifestCount, organizationCount: latest.size };
}

export function storageClientAuditAnchorArchive(
  storage: StorageClient & { listKeys(prefix: string): AsyncIterable<string> },
): AuditAnchorArchive {
  return {
    listKeys: (prefix) => storage.listKeys(prefix),
    async getObject(key) {
      const object = await storage.get(key);
      if (object === null) return null;
      if (object.body instanceof Uint8Array) return object.body;
      const chunks: Uint8Array[] = [];
      for await (const chunk of object.body) chunks.push(chunk);
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return body;
    },
  };
}

async function readAnchor(
  archive: AuditAnchorArchive,
  verifier: AuditAnchorVerifier,
  key: string,
): Promise<AnchorTail> {
  const body = await archive.getObject(key);
  if (body === null) throw new Error(`Immutable audit anchor disappeared: ${key}`);
  const manifest = parseObject(body, `Invalid immutable audit anchor: ${key}`);
  const authentication = parseAuthentication(manifest.authentication);
  const { authentication: _authentication, ...unsigned } = manifest;
  if (!(await verifier.verify(encodeAuditAnchorPayload(unsigned), authentication))) {
    throw new Error(`Immutable audit anchor authentication failed: ${key}`);
  }

  const manifestKey = requiredString(manifest.manifestKey, "manifestKey");
  const recordsKey = requiredString(manifest.recordsKey, "recordsKey");
  const recordsSha256 = digestString(manifest.recordsSha256, "recordsSha256");
  const recordIds = stringArray(manifest.recordIds, "recordIds");
  const recordCount = positiveInteger(manifest.recordCount, "recordCount");
  const orgId = requiredString(manifest.orgId, "orgId");
  const chain = objectValue(manifest.hashChain, "hashChain");
  const sequence = positiveIntegerString(chain.lastSequence, "hashChain.lastSequence");
  const thisHash = digestString(chain.lastThisHash, "hashChain.lastThisHash");
  if (manifest.format !== "helix.audit.immutable-s3.v2" || manifestKey !== key) {
    throw new Error(`Immutable audit anchor identity failed: ${key}`);
  }
  if (recordIds.length !== recordCount) {
    throw new Error(`Immutable audit anchor count failed: ${key}`);
  }

  const recordsBody = await archive.getObject(recordsKey);
  if (recordsBody === null || sha256Hex(recordsBody) !== recordsSha256) {
    throw new Error(`Immutable audit evidence checksum failed: ${recordsKey}`);
  }
  const lines = decoder.decode(recordsBody).trimEnd().split("\n");
  const last = parseObject(
    new TextEncoder().encode(lines.at(-1) ?? ""),
    `Invalid audit evidence: ${recordsKey}`,
  );
  if (
    lines.length !== recordCount ||
    last.id !== recordIds.at(-1) ||
    last.orgId !== orgId ||
    last.sequence !== sequence ||
    last.thisHash !== thisHash
  ) {
    throw new Error(`Immutable audit evidence does not match its anchor: ${recordsKey}`);
  }
  return { id: requiredString(last.id, "last record id"), orgId, sequence, thisHash };
}

function parseObject(body: Uint8Array, message: string): JsonObject {
  try {
    const value: unknown = JSON.parse(decoder.decode(body));
    return objectValue(value, message);
  } catch {
    throw new Error(message);
  }
}

function objectValue(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as JsonObject;
}

function parseAuthentication(value: unknown): AuditAnchorAuthentication {
  const authentication = objectValue(value, "authentication");
  const algorithm = requiredString(authentication.algorithm, "authentication.algorithm");
  if (algorithm !== "HMAC-SHA256") throw new Error("Unsupported audit anchor authentication");
  return {
    algorithm,
    keyId: requiredString(authentication.keyId, "authentication.keyId"),
    signature: requiredString(authentication.signature, "authentication.signature"),
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Expected ${label}`);
  return value;
}

function digestString(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Expected ${label} to be SHA-256`);
  return digest;
}

function positiveIntegerString(value: unknown, label: string): string {
  const integer = requiredString(value, label);
  if (!/^[1-9][0-9]*$/.test(integer)) throw new Error(`Expected ${label} to be positive`);
  return integer;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`Expected ${label} to be positive`);
  return value as number;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error(`Expected ${label} to be a string array`);
  }
  return value.map((item) => String(item));
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
