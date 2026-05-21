import type { AuditRecord, JsonValue } from "@helix/sdk";
import { sha256Hex } from "../crypto/index.js";

export interface HashableAuditRecord extends AuditRecord {
  readonly id?: string;
  readonly prevHash?: string | null;
}

export interface AuditHashResult {
  readonly prevHash: string | null;
  readonly thisHash: string;
}

export interface VerifiableAuditRecord extends HashableAuditRecord {
  readonly thisHash?: string | null;
}

export type AuditHashChainFailureReason = "prev_hash_mismatch" | "this_hash_mismatch";

export interface AuditHashChainFailure {
  readonly index: number;
  readonly id?: string | undefined;
  readonly reason: AuditHashChainFailureReason;
  readonly expected: string | null;
  readonly actual: string | null;
}

export interface AuditHashChainVerificationResult {
  readonly valid: boolean;
  readonly checked: number;
  readonly failures: readonly AuditHashChainFailure[];
}

export function canonicalJson(value: JsonValue | undefined): string {
  return JSON.stringify(sortJson(value ?? null));
}

export function computeAuditHash(record: HashableAuditRecord, previousHash: string | null): AuditHashResult {
  const normalized = {
    actorId: record.actorId,
    createdAt: record.createdAt ?? null,
    metadata: record.metadata ?? {},
    objectId: record.objectId ?? null,
    objectType: record.objectType,
    onBehalfOfActorId: record.onBehalfOfActorId ?? null,
    prevHash: previousHash,
    spanId: record.trace?.spanId ?? null,
    toolId: record.toolId ?? null,
    traceId: record.trace?.traceId ?? null,
    verb: record.verb,
  };

  return {
    prevHash: previousHash,
    // Routed through the crypto adapter (PRD §14.4). SHA-256 is FIPS-approved,
    // so the FIPS provider produces a byte-identical hash chain.
    thisHash: sha256Hex(canonicalJson(normalized)),
  };
}

export function verifyAuditHashChain(
  records: readonly VerifiableAuditRecord[],
): AuditHashChainVerificationResult {
  const failures: AuditHashChainFailure[] = [];
  let expectedPreviousHash: string | null = null;

  records.forEach((record, index) => {
    const expected = computeAuditHash(record, expectedPreviousHash);
    const actualPreviousHash = record.prevHash ?? null;
    const actualThisHash = record.thisHash ?? null;

    if (actualPreviousHash !== expected.prevHash) {
      failures.push({
        index,
        ...(record.id === undefined ? {} : { id: record.id }),
        reason: "prev_hash_mismatch",
        expected: expected.prevHash,
        actual: actualPreviousHash,
      });
    }

    if (actualThisHash !== expected.thisHash) {
      failures.push({
        index,
        ...(record.id === undefined ? {} : { id: record.id }),
        reason: "this_hash_mismatch",
        expected: expected.thisHash,
        actual: actualThisHash,
      });
    }

    expectedPreviousHash = expected.thisHash;
  });

  return {
    checked: records.length,
    failures,
    valid: failures.length === 0,
  };
}

function sortJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }

  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(input).sort()) {
      output[key] = sortJson(input[key]);
    }
    return output;
  }

  return null;
}
