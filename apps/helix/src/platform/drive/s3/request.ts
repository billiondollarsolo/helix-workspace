import type { Actor } from "@helix/sdk-types";
import type { FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import type { WebDavRateLimiter } from "../webdav-security.js";
import {
  restrictDriveS3Actor,
  type AuthenticatedDriveS3Key,
  type DriveS3AccessKeyStore,
  type DriveS3KeyScope,
} from "./access-keys.js";
import { S3Error } from "./errors.js";
import {
  headerValue,
  parseQueryPairs,
  parseSigV4,
  verifySigV4,
  type SigV4Headers,
  type VerifiedSigV4,
} from "./sigv4.js";

/** Gateway route prefix inside the versioned API (`/v1/s3`). */
export const DRIVE_S3_ROUTE_PREFIX = "/s3";
const WINDOW_MS = 60_000;
/** Failed signatures per client IP per minute (brute-force guard). */
const DRIVE_S3_AUTH_FAILURE_LIMIT = 30;
/** Authenticated requests per access key per minute; sized for parallel sync. */
const DRIVE_S3_KEY_REQUEST_LIMIT = 3_000;

export interface DriveS3Target {
  readonly path: string;
  readonly query: string;
  readonly queryMap: ReadonlyMap<string, string>;
  readonly bucket?: string;
  /** Decoded object key; empty for bucket-level requests. */
  readonly key: string;
}

function decodePathComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new S3Error("InvalidURI", "Couldn't parse the specified URI.");
  }
}

/** Parses `/s3/<bucket>/<key>` (after the version prefix has been removed). */
export function parseDriveS3Target(url: string): DriveS3Target {
  const queryIndex = url.indexOf("?");
  const path = queryIndex < 0 ? url : url.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : url.slice(queryIndex + 1);
  const queryMap = new Map(parseQueryPairs(query));
  const rest = path.slice(DRIVE_S3_ROUTE_PREFIX.length).replace(/^\//u, "");
  if (rest.length === 0) return { path, query, queryMap, key: "" };
  const separator = rest.indexOf("/");
  const bucket = decodePathComponent(separator < 0 ? rest : rest.slice(0, separator));
  const key = separator < 0 ? "" : decodePathComponent(rest.slice(separator + 1));
  return { path, query, queryMap, bucket, key };
}

/**
 * The path a client may have signed: the full public path (`/v1/s3/...`), or
 * the bucket-relative path when a dedicated S3 host rewrites `/` to `/v1/s3/`.
 */
function signedPathCandidates(path: string, publicPrefix: string): readonly string[] {
  const relative = path.slice(DRIVE_S3_ROUTE_PREFIX.length);
  return [`${publicPrefix}${path}`, relative.length === 0 ? "/" : relative];
}

export interface DriveS3Authentication {
  readonly authenticated: AuthenticatedDriveS3Key;
  readonly verified: VerifiedSigV4;
}

/** Verifies the SigV4 signature and resolves the access key; charges failures to the IP. */
export async function authenticateDriveS3Request(input: {
  readonly method: string;
  readonly target: DriveS3Target;
  readonly headers: SigV4Headers;
  readonly ip: string;
  readonly publicPrefix: string;
  readonly accessKeys: DriveS3AccessKeyStore;
  readonly rateLimiter: WebDavRateLimiter;
  readonly now: Date;
}): Promise<DriveS3Authentication> {
  const ipKey = `s3-auth:${input.ip}`;
  const budget = input.rateLimiter.peek(ipKey, DRIVE_S3_AUTH_FAILURE_LIMIT, WINDOW_MS);
  if (!budget.allowed) {
    throw new S3Error("SlowDown", "Too many failed S3 authentication attempts; slow down.", {
      retryAfterSeconds: budget.retryAfterSeconds,
    });
  }
  const fail = (error: S3Error): never => {
    input.rateLimiter.consume(ipKey, DRIVE_S3_AUTH_FAILURE_LIMIT, WINDOW_MS);
    throw error;
  };
  const candidates = signedPathCandidates(input.target.path, input.publicPrefix);
  const signed = { method: input.method, query: input.target.query, headers: input.headers };
  const parsed = parseSigV4({ ...signed, path: candidates[0] ?? input.target.path });
  if (parsed === null) {
    throw new S3Error(
      "AccessDenied",
      "Anonymous access is not allowed. Sign requests with a Helix S3 access key (Settings → S3 access keys).",
    );
  }
  const authenticated = await input.accessKeys.authenticate(parsed.accessKeyId);
  if (authenticated === null) {
    return fail(
      new S3Error(
        "InvalidAccessKeyId",
        "The access key ID you provided does not exist, was revoked, or has expired.",
      ),
    );
  }
  let mismatch: S3Error | undefined;
  for (const path of candidates) {
    try {
      const verified = verifySigV4(
        { ...signed, path },
        parsed,
        authenticated.secretAccessKey,
        input.now,
      );
      await input.accessKeys.recordUse(authenticated.key);
      return { authenticated, verified };
    } catch (error) {
      if (!(error instanceof S3Error) || error.code !== "SignatureDoesNotMatch") throw error;
      mismatch = error;
    }
  }
  return fail(mismatch ?? new S3Error("SignatureDoesNotMatch", "Signature mismatch."));
}

/** Narrows the key to the operation's scope and charges the key's request budget. */
export function authorizeDriveS3Scope(
  authentication: DriveS3Authentication,
  scope: DriveS3KeyScope,
  rateLimiter: WebDavRateLimiter,
): Actor {
  const { key } = authentication.authenticated;
  const budget = rateLimiter.consume(
    `s3-key:${key.orgId}:${key.id}`,
    DRIVE_S3_KEY_REQUEST_LIMIT,
    WINDOW_MS,
  );
  if (!budget.allowed) {
    throw new S3Error("SlowDown", "S3 request rate limit exceeded for this access key.", {
      retryAfterSeconds: budget.retryAfterSeconds,
    });
  }
  const actor = restrictDriveS3Actor(authentication.authenticated, scope);
  if (actor === null) {
    throw new S3Error(
      "AccessDenied",
      `This access key or its user lacks the "${scope}" scope required for this operation. Create a key with that scope in Settings → S3 access keys.`,
    );
  }
  return actor;
}

/** Reads the raw request body (still aws-chunked if so encoded), bounded by `limit`. */
export async function readRawBody(request: FastifyRequest, limit: number): Promise<Buffer> {
  const declared = headerValue(request.headers, "content-length");
  if (declared !== undefined && Number(declared) > limit) {
    throw new S3Error(
      "EntityTooLarge",
      `Your proposed upload exceeds the maximum allowed size of ${String(limit)} bytes. Use a multipart upload with smaller parts.`,
    );
  }
  const stream = isReadable(request.body) ? request.body : request.raw;
  if (request.body === undefined && request.raw.readableEnded) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > limit) {
      stream.destroy();
      throw new S3Error(
        "EntityTooLarge",
        `Your upload exceeds the maximum allowed size of ${String(limit)} bytes. Use a multipart upload with smaller parts.`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function isReadable(value: unknown): value is Readable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}
