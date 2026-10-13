import { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { resolveFileBackedEnvironment } from "../config/env.js";
import {
  provisionAuditBucket,
  provisionPlatformBucket,
} from "../platform/storage/provision-bucket.js";

// One-shot process: it receives only the object-store settings, never the
// database or provider credentials of an application replica. A private CA for
// the endpoint is trusted through NODE_EXTRA_CA_CERTS.
const schema = z.object({
  NODE_ENV: z.string().optional(),
  RUSTFS_ENDPOINT: z.string().url(),
  RUSTFS_REGION: z.string().min(1).default("us-east-1"),
  RUSTFS_BUCKET: z.string().min(3).default("helix-objects"),
  RUSTFS_ACCESS_KEY: z.string().min(1),
  RUSTFS_SECRET_KEY: z.string().min(1),
  RUSTFS_SSE_KMS_KEY_ID: z.string().min(1),
  RUSTFS_OBJECT_LOCK_MODE: z.enum(["GOVERNANCE", "COMPLIANCE"]),
  RUSTFS_OBJECT_LOCK_RETENTION_DAYS: z.coerce.number().int().positive(),
  /** When set, also provision the immutable audit bucket on the same store. */
  AUDIT_IMMUTABLE_S3_BUCKET: z.string().min(3).optional(),
});

const parsed = schema.safeParse(
  resolveFileBackedEnvironment(process.env, {
    RUSTFS_ACCESS_KEY_FILE: "RUSTFS_ACCESS_KEY",
    RUSTFS_SECRET_KEY_FILE: "RUSTFS_SECRET_KEY",
  }),
);
if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid object-store provisioning configuration:\n${details}`);
}
const config = parsed.data;
if (config.NODE_ENV === "production" && new URL(config.RUSTFS_ENDPOINT).protocol !== "https:") {
  throw new Error("Production object storage requires an HTTPS RUSTFS_ENDPOINT.");
}

const client = new S3Client({
  endpoint: config.RUSTFS_ENDPOINT,
  region: config.RUSTFS_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.RUSTFS_ACCESS_KEY,
    secretAccessKey: config.RUSTFS_SECRET_KEY,
  },
});
try {
  const result = await provisionPlatformBucket(client, {
    bucket: config.RUSTFS_BUCKET,
    kmsKeyId: config.RUSTFS_SSE_KMS_KEY_ID,
    objectLockMode: config.RUSTFS_OBJECT_LOCK_MODE,
    retentionDays: config.RUSTFS_OBJECT_LOCK_RETENTION_DAYS,
  });
  console.log(
    `Object store bucket ${config.RUSTFS_BUCKET} ${result.created ? "created" : "verified"}: ` +
      `versioning on, SSE-KMS key ${config.RUSTFS_SSE_KMS_KEY_ID}, ` +
      `${config.RUSTFS_OBJECT_LOCK_MODE} retention ${String(result.retentionDays)} days.`,
  );
  if (config.AUDIT_IMMUTABLE_S3_BUCKET !== undefined) {
    const audit = await provisionAuditBucket(client, {
      bucket: config.AUDIT_IMMUTABLE_S3_BUCKET,
      kmsKeyId: config.RUSTFS_SSE_KMS_KEY_ID,
    });
    console.log(
      `Audit bucket ${config.AUDIT_IMMUTABLE_S3_BUCKET} ${audit.created ? "created" : "verified"}: object lock on, SSE-KMS key ${config.RUSTFS_SSE_KMS_KEY_ID}.`,
    );
  }
} finally {
  client.destroy();
}
