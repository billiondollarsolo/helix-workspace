/* Bring-your-own object storage form fields for the tenant settings console. */
export const BYO_STORAGE_PROVIDERS = [
  ["aws-s3", "AWS S3"],
  ["r2", "Cloudflare R2"],
  ["s3-compatible", "S3-compatible"],
] as const;

export const BYO_STORAGE_KINDS = [
  ["helix-default", "Helix default"],
  ["byo", "Customer-owned"],
] as const;

export const BYO_STORAGE_FIELDS = [
  ["endpoint", "Endpoint"],
  ["region", "Region"],
  ["bucket", "Bucket"],
  ["prefix", "Prefix"],
  ["credentials_secret_handle", "Credentials secret handle"],
  ["sse_kms_key_arn", "SSE-KMS key ARN"],
  ["retention_days", "Object-lock retention days"],
] as const;
