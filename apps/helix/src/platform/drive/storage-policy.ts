export interface DriveStorageEncryptionPolicy {
  readonly mode: "AES256" | "aws:kms";
  readonly kmsKeyId?: string;
}

export interface DriveStorageEncryptionEvidence {
  readonly byteSize: number | null;
  readonly serverSideEncryption: string | null;
  readonly serverSideEncryptionAwsKmsKeyId: string | null;
}

export function assertDriveStorageEncryption(
  policy: DriveStorageEncryptionPolicy,
  evidence: DriveStorageEncryptionEvidence | null,
): void {
  if (evidence === null) {
    throw new Error("Drive storage provider returned no post-finalize object metadata.");
  }
  if (evidence.serverSideEncryption !== policy.mode) {
    throw new Error(
      `Drive storage encryption mismatch: required ${policy.mode}, received ${evidence.serverSideEncryption ?? "none"}.`,
    );
  }
  if (
    policy.mode === "aws:kms" &&
    (policy.kmsKeyId === undefined || evidence.serverSideEncryptionAwsKmsKeyId !== policy.kmsKeyId)
  ) {
    throw new Error("Drive storage KMS key evidence does not match the tenant policy.");
  }
}
