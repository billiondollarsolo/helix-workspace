import type { HashableAuditRecord } from "./hash.js";
import { computeAuditHash } from "./hash.js";

export type AuditHashChainIssueCode = "prev_hash_mismatch" | "this_hash_mismatch";

export interface VerifiableAuditRecord extends HashableAuditRecord {
  readonly thisHash: string;
  readonly prevHash?: string | null;
}

export interface AuditVerificationRecord extends VerifiableAuditRecord {
  readonly createdAt: string;
}

export interface AuditHashChainIssue {
  readonly code: AuditHashChainIssueCode;
  readonly index: number;
  readonly id?: string;
  readonly expected: string | null;
  readonly actual: string | null;
}

export interface AuditHashChainVerificationResult {
  readonly valid: boolean;
  readonly checkedRecordCount: number;
  readonly issues: readonly AuditHashChainIssue[];
  readonly lastHash: string | null;
}

export interface ListAuditVerificationRecordsInput {
  readonly orgId: string;
}

export interface AuditVerificationStore {
  listVerificationRecords(
    input: ListAuditVerificationRecordsInput,
  ): Promise<readonly AuditVerificationRecord[]>;
}

export interface VerifyLatestAuditHashChainInput {
  readonly orgId: string;
  readonly now?: Date | undefined;
}

export interface LatestAuditVerificationStatus extends AuditHashChainVerificationResult {
  readonly orgId: string;
  readonly verifiedAt: string;
  readonly latestRecordId: string | null;
  readonly latestRecordCreatedAt: string | null;
}

export function verifyAuditHashChain(
  records: readonly VerifiableAuditRecord[],
  initialPreviousHash: string | null = null,
): AuditHashChainVerificationResult {
  const issues: AuditHashChainIssue[] = [];
  let expectedPreviousHash = initialPreviousHash;
  let lastHash: string | null = null;

  for (const [index, record] of records.entries()) {
    const actualPreviousHash = record.prevHash ?? record.previousHash ?? null;

    if (actualPreviousHash !== expectedPreviousHash) {
      issues.push(
        issue("prev_hash_mismatch", index, record.id, expectedPreviousHash, actualPreviousHash),
      );
    }

    const expectedThisHash = computeAuditHash(record, actualPreviousHash).thisHash;
    if (record.thisHash !== expectedThisHash) {
      issues.push(issue("this_hash_mismatch", index, record.id, expectedThisHash, record.thisHash));
    }

    expectedPreviousHash = record.thisHash;
    lastHash = record.thisHash;
  }

  return {
    valid: issues.length === 0,
    checkedRecordCount: records.length,
    issues,
    lastHash,
  };
}

export async function verifyLatestAuditHashChain(
  store: AuditVerificationStore,
  input: VerifyLatestAuditHashChainInput,
): Promise<LatestAuditVerificationStatus> {
  const records = await store.listVerificationRecords({ orgId: input.orgId });
  const verification = verifyAuditHashChain(records);
  const latestRecord = records.at(-1);

  return {
    ...verification,
    orgId: input.orgId,
    verifiedAt: (input.now ?? new Date()).toISOString(),
    latestRecordId: latestRecord?.id ?? null,
    latestRecordCreatedAt: latestRecord?.createdAt ?? null,
  };
}

function issue(
  code: AuditHashChainIssueCode,
  index: number,
  id: string | undefined,
  expected: string | null,
  actual: string | null,
): AuditHashChainIssue {
  return {
    code,
    index,
    ...(id === undefined ? {} : { id }),
    expected,
    actual,
  };
}
