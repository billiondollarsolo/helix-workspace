import { callTool, type CallToolOptions } from "@/lib/tool-call";

/** Drive scopes an S3 access key may carry. */
export const S3_KEY_SCOPES = ["drive.read", "drive.write", "drive.delete"] as const;
export type S3KeyScope = (typeof S3_KEY_SCOPES)[number];

export interface S3AccessKey {
  readonly id: string;
  readonly accessKeyId: string;
  readonly label: string;
  readonly scopes: readonly S3KeyScope[];
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface S3AccessKeyCreated {
  readonly accessKey: S3AccessKey;
  readonly secretAccessKey: string;
  readonly endpointPath: string;
}

export async function listS3AccessKeys(options?: CallToolOptions): Promise<readonly S3AccessKey[]> {
  const output = await callTool<{ readonly accessKeys: readonly S3AccessKey[] }>(
    "drive.s3-keys.list",
    {},
    options,
  );
  return output.accessKeys;
}

export function createS3AccessKey(
  input: { readonly label: string; readonly scopes: readonly S3KeyScope[] },
  options?: CallToolOptions,
): Promise<S3AccessKeyCreated> {
  return callTool<S3AccessKeyCreated>("drive.s3-keys.create", input, options);
}

export async function revokeS3AccessKey(keyId: string, options?: CallToolOptions): Promise<void> {
  await callTool("drive.s3-keys.revoke", { keyId }, options);
}

/** The gateway endpoint for this deployment, e.g. `https://helix.example.com/v1/s3`. */
export function s3EndpointUrl(origin: string, endpointPath = "/v1/s3"): string {
  return `${origin.replace(/\/+$/u, "")}${endpointPath}`;
}

export function awsCliExample(endpoint: string): string {
  return [
    "aws configure --profile helix   # paste the access key ID and secret",
    `aws --profile helix --endpoint-url ${endpoint} s3 ls s3://my-drive/`,
    `aws --profile helix --endpoint-url ${endpoint} s3 sync ./photos s3://my-drive/photos`,
  ].join("\n");
}

export function rcloneExample(endpoint: string, accessKeyId: string): string {
  return [
    "[helix]",
    "type = s3",
    "provider = Other",
    `access_key_id = ${accessKeyId}`,
    "secret_access_key = <your secret>",
    `endpoint = ${endpoint}`,
    "region = us-east-1",
    "force_path_style = true",
  ].join("\n");
}
