import type { AuditRecord, JsonObject } from "@helix/sdk-types";
import { sha256Hex } from "./crypto/index.js";

export interface HashableAuditRecord extends AuditRecord {
  readonly id?: string;
}

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function hashAuditRecord(record: HashableAuditRecord, previousHash: string | null): string {
  const payload: JsonObject = {
    actorId: record.actorId,
    verb: record.verb,
    objectType: record.objectType,
    objectId: record.objectId ?? null,
    toolId: record.toolId ?? null,
    metadata: record.metadata ?? {},
    previousHash,
    createdAt: record.createdAt ?? null,
  };

  return sha256Hex(canonicalizeJson(payload));
}
