import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolved AWS credentials. `sessionToken` is present for temporary
 * credentials (IAM role / instance profile / SSO).
 */
export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/**
 * A credential provider returns AWS credentials or `null` when the provider
 * is not applicable in the current environment. Providers are tried in
 * standard AWS SDK precedence order.
 */
export type AwsCredentialProvider = () => Promise<AwsCredentials | null>;

export interface AwsCredentialResolverOptions {
  /** Static credentials supplied directly via configuration. */
  readonly static?: AwsCredentials | undefined;
  /** Process environment, defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** AWS shared-credentials file path override. */
  readonly sharedCredentialsFile?: string | undefined;
  /** Fetch implementation for IMDS calls, defaults to global `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  /** IMDS endpoint override (for tests). */
  readonly imdsEndpoint?: string | undefined;
  /** Timeout in ms for each IMDS request. */
  readonly imdsTimeoutMs?: number | undefined;
}

const DEFAULT_IMDS_ENDPOINT = "http://169.254.169.254";
const DEFAULT_IMDS_TIMEOUT_MS = 1000;
const IMDS_TOKEN_TTL_SECONDS = 21600;

/**
 * Resolves AWS credentials following the standard SDK precedence:
 *
 *   1. Explicit static credentials (from config)
 *   2. Environment variables (`AWS_ACCESS_KEY_ID` / ...)
 *   3. Shared credentials file (`~/.aws/credentials`, profile `AWS_PROFILE`)
 *   4. EC2 instance metadata / IAM role (IMDSv2)
 *
 * The first provider that yields credentials wins. Throws if none succeed.
 */
export async function resolveAwsCredentials(
  options: AwsCredentialResolverOptions = {},
): Promise<AwsCredentials> {
  const env = options.env ?? process.env;
  const providers: readonly AwsCredentialProvider[] = [
    () => Promise.resolve(staticCredentialProvider(options.static)),
    () => Promise.resolve(envCredentialProvider(env)),
    () => sharedConfigCredentialProvider(env, options.sharedCredentialsFile),
    () => instanceMetadataCredentialProvider(options),
  ];

  for (const provider of providers) {
    const credentials = await provider();
    if (credentials !== null) {
      return credentials;
    }
  }
  throw new Error(
    "Unable to resolve AWS credentials: no static, environment, profile, or instance-profile credentials are available.",
  );
}

export function staticCredentialProvider(
  credentials: AwsCredentials | undefined,
): AwsCredentials | null {
  if (
    credentials === undefined ||
    credentials.accessKeyId.length === 0 ||
    credentials.secretAccessKey.length === 0
  ) {
    return null;
  }
  return credentials;
}

export function envCredentialProvider(env: NodeJS.ProcessEnv): AwsCredentials | null {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (
    accessKeyId === undefined ||
    accessKeyId.length === 0 ||
    secretAccessKey === undefined ||
    secretAccessKey.length === 0
  ) {
    return null;
  }
  const sessionToken = env.AWS_SESSION_TOKEN;
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken === undefined || sessionToken.length === 0 ? {} : { sessionToken }),
  };
}

export async function sharedConfigCredentialProvider(
  env: NodeJS.ProcessEnv,
  credentialsFileOverride?: string,
): Promise<AwsCredentials | null> {
  const profile = env.AWS_PROFILE ?? "default";
  const credentialsFile =
    credentialsFileOverride ??
    env.AWS_SHARED_CREDENTIALS_FILE ??
    join(homedir(), ".aws", "credentials");

  let contents: string;
  try {
    contents = await readFile(credentialsFile, "utf8");
  } catch {
    return null;
  }

  const section = parseIniSection(contents, profile);
  if (section === null) {
    return null;
  }
  const accessKeyId = section.aws_access_key_id;
  const secretAccessKey = section.aws_secret_access_key;
  if (
    accessKeyId === undefined ||
    accessKeyId.length === 0 ||
    secretAccessKey === undefined ||
    secretAccessKey.length === 0
  ) {
    return null;
  }
  const sessionToken = section.aws_session_token;
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken === undefined || sessionToken.length === 0 ? {} : { sessionToken }),
  };
}

/**
 * Resolves credentials from the EC2 Instance Metadata Service using IMDSv2
 * (token-protected). Returns `null` when IMDS is unreachable (i.e. the
 * process is not running on EC2/ECS with an attached instance profile).
 */
export async function instanceMetadataCredentialProvider(
  options: AwsCredentialResolverOptions,
): Promise<AwsCredentials | null> {
  const fetchImpl = options.fetch ?? fetch;
  const endpoint = options.imdsEndpoint ?? DEFAULT_IMDS_ENDPOINT;
  const timeoutMs = options.imdsTimeoutMs ?? DEFAULT_IMDS_TIMEOUT_MS;

  const token = await imdsRequest(fetchImpl, `${endpoint}/latest/api/token`, timeoutMs, {
    method: "PUT",
    headers: { "x-aws-ec2-metadata-token-ttl-seconds": String(IMDS_TOKEN_TTL_SECONDS) },
  });
  if (token === null || token.length === 0) {
    return null;
  }
  const tokenHeaders = { "x-aws-ec2-metadata-token": token };

  const roleName = await imdsRequest(
    fetchImpl,
    `${endpoint}/latest/meta-data/iam/security-credentials/`,
    timeoutMs,
    { headers: tokenHeaders },
  );
  if (roleName === null || roleName.length === 0) {
    return null;
  }

  const firstRole = roleName.split("\n")[0]?.trim();
  if (firstRole === undefined || firstRole.length === 0) {
    return null;
  }

  const body = await imdsRequest(
    fetchImpl,
    `${endpoint}/latest/meta-data/iam/security-credentials/${encodeURIComponent(firstRole)}`,
    timeoutMs,
    { headers: tokenHeaders },
  );
  if (body === null) {
    return null;
  }
  return parseInstanceProfileCredentials(body);
}

export function parseInstanceProfileCredentials(body: string): AwsCredentials | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const accessKeyId = record.AccessKeyId;
  const secretAccessKey = record.SecretAccessKey;
  const sessionToken = record.Token;
  if (typeof accessKeyId !== "string" || typeof secretAccessKey !== "string") {
    return null;
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(typeof sessionToken === "string" && sessionToken.length > 0 ? { sessionToken } : {}),
  };
}

async function imdsRequest(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  init: RequestInit,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Parses a single section out of an AWS INI-format credentials file. */
export function parseIniSection(
  contents: string,
  section: string,
): Record<string, string> | null {
  const lines = contents.split(/\r?\n/u);
  const result: Record<string, string> = {};
  let inSection = false;
  let found = false;

  for (const rawLine of lines) {
    const line = stripIniComment(rawLine).trim();
    if (line.length === 0) {
      continue;
    }
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch !== null) {
      const name = sectionMatch[1]?.trim();
      inSection = name === section || name === `profile ${section}`;
      if (inSection) {
        found = true;
      }
      continue;
    }
    if (!inSection) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key.length > 0) {
      result[key] = value;
    }
  }

  return found ? result : null;
}

function stripIniComment(line: string): string {
  const hashIndex = line.indexOf("#");
  const semicolonIndex = line.indexOf(";");
  const indices = [hashIndex, semicolonIndex].filter((index) => index >= 0);
  if (indices.length === 0) {
    return line;
  }
  return line.slice(0, Math.min(...indices));
}
