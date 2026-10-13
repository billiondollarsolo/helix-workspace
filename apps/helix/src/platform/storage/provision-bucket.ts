/* One-shot provisioning of the platform object-store bucket.

   Production refuses to start unless the bucket enforces versioning, a default
   SSE-KMS key, and an object-lock retention (see `checkHealth` in
   s3-compatible.ts). This creates a missing bucket with object lock and applies
   those settings. It never lowers an existing retention, and it fails with an
   actionable message when an existing bucket was created without object lock,
   which cannot be enabled afterwards. */

import {
  CreateBucketCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketVersioningCommand,
  PutObjectLockConfigurationCommand,
  type GetObjectLockConfigurationCommandOutput,
} from "@aws-sdk/client-s3";

export interface BucketProvisionPolicy {
  readonly bucket: string;
  readonly kmsKeyId: string;
  readonly objectLockMode: "GOVERNANCE" | "COMPLIANCE";
  readonly retentionDays: number;
}

export interface BucketProvisionResult {
  readonly created: boolean;
  readonly retentionDays: number;
}

/** The subset of `S3Client` this needs; injected in tests. */
export interface BucketProvisionClient {
  send(command: object): Promise<unknown>;
}

export async function provisionPlatformBucket(
  client: BucketProvisionClient,
  policy: BucketProvisionPolicy,
): Promise<BucketProvisionResult> {
  const Bucket = policy.bucket;
  let created = false;
  try {
    await client.send(new HeadBucketCommand({ Bucket }));
  } catch (error) {
    if (!isMissingBucket(error)) throw error;
    await client.send(new CreateBucketCommand({ Bucket, ObjectLockEnabledForBucket: true }));
    created = true;
  }

  await client.send(
    new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: "Enabled" } }),
  );
  await client.send(
    new PutBucketEncryptionCommand({
      Bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [
          {
            ApplyServerSideEncryptionByDefault: {
              SSEAlgorithm: "aws:kms",
              KMSMasterKeyID: policy.kmsKeyId,
            },
          },
        ],
      },
    }),
  );

  const existing = await currentRetention(client, Bucket);
  if (existing === "not-enabled") {
    throw new Error(
      `Bucket ${Bucket} exists without object lock, which cannot be enabled after creation. ` +
        "Create a new bucket with object lock (or let this command create it) and point RUSTFS_BUCKET at it.",
    );
  }
  if (
    existing !== undefined &&
    existing.mode === policy.objectLockMode &&
    existing.days >= policy.retentionDays
  ) {
    return { created, retentionDays: existing.days };
  }
  if (
    existing !== undefined &&
    existing.mode === "COMPLIANCE" &&
    policy.objectLockMode !== "COMPLIANCE"
  ) {
    throw new Error(
      `Bucket ${Bucket} already enforces COMPLIANCE retention; set RUSTFS_OBJECT_LOCK_MODE=COMPLIANCE.`,
    );
  }
  await client.send(
    new PutObjectLockConfigurationCommand({
      Bucket,
      ObjectLockConfiguration: {
        ObjectLockEnabled: "Enabled",
        Rule: {
          DefaultRetention: {
            Mode: policy.objectLockMode,
            Days: Math.max(policy.retentionDays, existing?.days ?? 0),
          },
        },
      },
    }),
  );
  return { created, retentionDays: Math.max(policy.retentionDays, existing?.days ?? 0) };
}

/**
 * The immutable audit bucket: object lock on (each audit object carries its own
 * retain-until date, so no default retention) and the same default SSE-KMS key.
 */
export async function provisionAuditBucket(
  client: BucketProvisionClient,
  input: { readonly bucket: string; readonly kmsKeyId: string },
): Promise<{ readonly created: boolean }> {
  const Bucket = input.bucket;
  let created = false;
  try {
    await client.send(new HeadBucketCommand({ Bucket }));
  } catch (error) {
    if (!isMissingBucket(error)) throw error;
    await client.send(new CreateBucketCommand({ Bucket, ObjectLockEnabledForBucket: true }));
    created = true;
  }
  await client.send(
    new PutBucketEncryptionCommand({
      Bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [
          {
            ApplyServerSideEncryptionByDefault: {
              SSEAlgorithm: "aws:kms",
              KMSMasterKeyID: input.kmsKeyId,
            },
          },
        ],
      },
    }),
  );
  if ((await currentRetention(client, Bucket)) === "not-enabled") {
    throw new Error(
      `Audit bucket ${Bucket} exists without object lock, which cannot be enabled after creation. ` +
        "Point AUDIT_IMMUTABLE_S3_BUCKET at a new bucket name.",
    );
  }
  return { created };
}

async function currentRetention(
  client: BucketProvisionClient,
  Bucket: string,
): Promise<{ mode: string; days: number } | "not-enabled" | undefined> {
  let output: GetObjectLockConfigurationCommandOutput;
  try {
    output = (await client.send(
      new GetObjectLockConfigurationCommand({ Bucket }),
    )) as GetObjectLockConfigurationCommandOutput;
  } catch (error) {
    if (errorName(error) === "ObjectLockConfigurationNotFoundError") return "not-enabled";
    throw error;
  }
  if (output.ObjectLockConfiguration?.ObjectLockEnabled !== "Enabled") return "not-enabled";
  const retention = output.ObjectLockConfiguration.Rule?.DefaultRetention;
  return retention?.Mode === undefined || retention.Days === undefined
    ? undefined
    : { mode: retention.Mode, days: retention.Days };
}

function isMissingBucket(error: unknown): boolean {
  const name = errorName(error);
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return name === "NotFound" || name === "NoSuchBucket" || status === 404;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}
