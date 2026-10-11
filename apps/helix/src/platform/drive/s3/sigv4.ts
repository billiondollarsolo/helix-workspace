import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { S3Error } from "./errors.js";

/**
 * AWS Signature Version 4 verification for the S3-compatible Drive gateway.
 *
 * Supports the Authorization header and presigned query strings, signed and
 * UNSIGNED-PAYLOAD hashes, and the aws-chunked streaming encodings
 * (STREAMING-AWS4-HMAC-SHA256-PAYLOAD[-TRAILER] and
 * STREAMING-UNSIGNED-PAYLOAD-TRAILER) used by the AWS CLI and SDKs.
 */
const SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const STREAMING_SIGNED_PAYLOAD = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD";
export const STREAMING_SIGNED_PAYLOAD_TRAILER = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER";
export const STREAMING_UNSIGNED_PAYLOAD_TRAILER = "STREAMING-UNSIGNED-PAYLOAD-TRAILER";
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Maximum clock skew accepted between the client and the gateway. */
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;
/** Longest presigned URL lifetime AWS accepts (seven days). */
const MAX_PRESIGN_EXPIRES_SECONDS = 604_800;

export type SigV4Headers = Readonly<Record<string, string | string[] | undefined>>;

export interface SigV4RequestInput {
  readonly method: string;
  /** Path exactly as the client addressed it, without the query string. */
  readonly path: string;
  /** Raw query string without the leading `?`. */
  readonly query: string;
  readonly headers: SigV4Headers;
}

export interface ParsedSigV4 {
  readonly kind: "header" | "query";
  readonly accessKeyId: string;
  readonly scopeDate: string;
  readonly region: string;
  readonly service: string;
  readonly signedHeaders: readonly string[];
  readonly signature: string;
  readonly amzDate: string;
  readonly payloadHash: string;
  readonly expiresSeconds?: number;
}

export interface VerifiedSigV4 {
  readonly parsed: ParsedSigV4;
  /** Request headers the signature vouches for; see {@link trustedRequestHeaders}. */
  readonly headers: SigV4Headers;
  readonly signingKey: Buffer;
  readonly scope: string;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

export function deriveSigningKey(
  secretAccessKey: string,
  scopeDate: string,
  region: string,
  service: string,
): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, scopeDate);
  return hmac(hmac(hmac(dateKey, region), service), "aws4_request");
}

/** RFC 3986 encoding with the S3 rules: everything but unreserved characters. */
export function s3UriEncode(value: string, encodeSlash: boolean): string {
  let output = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      char === "-" ||
      char === "_" ||
      char === "." ||
      char === "~" ||
      (char === "/" && !encodeSlash)
    ) {
      output += char;
    } else {
      output += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return output;
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new S3Error("InvalidURI", "Couldn't parse the specified URI.");
  }
}

function canonicalUri(path: string): string {
  const decoded = path
    .split("/")
    .map((segment) => decodeComponent(segment))
    .join("/");
  return s3UriEncode(decoded.length === 0 ? "/" : decoded, false);
}

export function parseQueryPairs(query: string): readonly (readonly [string, string])[] {
  if (query.length === 0) return [];
  return query
    .split("&")
    .filter((part) => part.length > 0)
    .map((part) => {
      const separator = part.indexOf("=");
      const name = separator < 0 ? part : part.slice(0, separator);
      const value = separator < 0 ? "" : part.slice(separator + 1);
      return [
        decodeComponent(name.replaceAll("+", "%20")),
        decodeComponent(value.replaceAll("+", "%20")),
      ] as const;
    });
}

function canonicalQueryString(query: string, omit?: string): string {
  return parseQueryPairs(query)
    .filter(([name]) => name !== omit)
    .map(([name, value]) => [s3UriEncode(name, true), s3UriEncode(value, true)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName
        ? compareAscii(leftValue, rightValue)
        : compareAscii(leftName, rightName),
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function compareAscii(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function headerValue(headers: SigV4Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(",") : value;
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ");
}

export function canonicalRequest(
  input: SigV4RequestInput,
  signedHeaders: readonly string[],
  payloadHash: string,
  omitQuery?: string,
): string {
  const headerLines = signedHeaders.map((name) => {
    const value = headerValue(input.headers, name);
    if (value === undefined) {
      throw new S3Error(
        "AccessDenied",
        `There were headers present in the request which were not signed: ${name} is missing.`,
      );
    }
    return `${name}:${canonicalHeaderValue(value)}\n`;
  });
  return [
    input.method.toUpperCase(),
    canonicalUri(input.path),
    canonicalQueryString(input.query, omitQuery),
    headerLines.join(""),
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");
}

export function stringToSign(amzDate: string, scope: string, canonical: string): string {
  return [SIGV4_ALGORITHM, amzDate, scope, sha256Hex(canonical)].join("\n");
}

export function signatureFor(signingKey: Buffer, value: string): string {
  return createHmac("sha256", signingKey).update(value, "utf8").digest("hex");
}

export function signaturesMatch(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

const CREDENTIAL_RE =
  /^(?<accessKeyId>[A-Za-z0-9]{3,128})\/(?<date>\d{8})\/(?<region>[a-z0-9-]{1,64})\/(?<service>[a-z0-9-]{1,32})\/aws4_request$/u;
const AMZ_DATE_RE = /^\d{8}T\d{6}Z$/u;
const SIGNATURE_RE = /^[0-9a-f]{64}$/u;

function parseCredential(value: string): {
  readonly accessKeyId: string;
  readonly scopeDate: string;
  readonly region: string;
  readonly service: string;
} {
  const match = CREDENTIAL_RE.exec(value);
  if (match?.groups === undefined) {
    throw new S3Error(
      "AuthorizationQueryParametersError",
      "The credential must be <access-key-id>/<YYYYMMDD>/<region>/s3/aws4_request.",
    );
  }
  const { accessKeyId, date, region, service } = match.groups as Record<string, string>;
  return { accessKeyId, scopeDate: date, region, service } as {
    readonly accessKeyId: string;
    readonly scopeDate: string;
    readonly region: string;
    readonly service: string;
  };
}

function parseSignedHeaders(value: string): readonly string[] {
  const names = value.split(";").map((name) => name.trim().toLowerCase());
  if (names.length === 0 || names.some((name) => !/^[a-z0-9-]+$/u.test(name))) {
    throw new S3Error("AuthorizationHeaderMalformed", "SignedHeaders is malformed.");
  }
  if (!names.includes("host")) {
    throw new S3Error("AccessDenied", "The host header must be signed.");
  }
  return names;
}

/** Parses SigV4 credentials from the request, or returns null when none are present. */
export function parseSigV4(input: SigV4RequestInput): ParsedSigV4 | null {
  const authorization = headerValue(input.headers, "authorization");
  const query = new Map(parseQueryPairs(input.query));
  if (authorization !== undefined && authorization.length > 0) {
    return parseHeaderAuth(authorization, input.headers);
  }
  if (query.has("X-Amz-Algorithm") || query.has("X-Amz-Signature")) {
    return parseQueryAuth(query);
  }
  if (query.has("AWSAccessKeyId") || query.has("Signature")) {
    throw new S3Error(
      "AuthorizationQueryParametersError",
      "Signature Version 2 is not supported; sign requests with AWS Signature Version 4.",
    );
  }
  return null;
}

function parseHeaderAuth(authorization: string, headers: SigV4Headers): ParsedSigV4 {
  if (authorization.startsWith("AWS ")) {
    throw new S3Error(
      "InvalidRequest",
      "Signature Version 2 is not supported; sign requests with AWS Signature Version 4.",
    );
  }
  if (!authorization.startsWith(`${SIGV4_ALGORITHM} `)) {
    throw new S3Error(
      "AuthorizationHeaderMalformed",
      "Only AWS4-HMAC-SHA256 authorization is supported.",
    );
  }
  const fields = new Map<string, string>();
  for (const part of authorization.slice(SIGV4_ALGORITHM.length + 1).split(",")) {
    const separator = part.indexOf("=");
    if (separator > 0)
      fields.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  const credential = fields.get("Credential");
  const signedHeaders = fields.get("SignedHeaders");
  const signature = fields.get("Signature");
  if (credential === undefined || signedHeaders === undefined || signature === undefined) {
    throw new S3Error(
      "AuthorizationHeaderMalformed",
      "The authorization header requires Credential, SignedHeaders and Signature.",
    );
  }
  if (!SIGNATURE_RE.test(signature)) {
    throw new S3Error("AuthorizationHeaderMalformed", "The signature is malformed.");
  }
  const amzDate = headerValue(headers, "x-amz-date") ?? amzDateFromHttpDate(headers);
  if (amzDate === undefined || !AMZ_DATE_RE.test(amzDate)) {
    throw new S3Error(
      "AccessDenied",
      "AWS authentication requires a valid Date or x-amz-date header.",
    );
  }
  const payloadHash = headerValue(headers, "x-amz-content-sha256");
  if (payloadHash === undefined) {
    throw new S3Error(
      "InvalidRequest",
      "Missing required header for this request: x-amz-content-sha256.",
    );
  }
  return {
    kind: "header",
    ...parseCredential(credential),
    signedHeaders: parseSignedHeaders(signedHeaders),
    signature,
    amzDate,
    payloadHash,
  };
}

function amzDateFromHttpDate(headers: SigV4Headers): string | undefined {
  const value = headerValue(headers, "date");
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed
    .toISOString()
    .replaceAll(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");
}

function parseQueryAuth(query: ReadonlyMap<string, string>): ParsedSigV4 {
  if (query.get("X-Amz-Algorithm") !== SIGV4_ALGORITHM) {
    throw new S3Error(
      "AuthorizationQueryParametersError",
      "X-Amz-Algorithm only supports AWS4-HMAC-SHA256.",
    );
  }
  const credential = query.get("X-Amz-Credential");
  const amzDate = query.get("X-Amz-Date");
  const signedHeaders = query.get("X-Amz-SignedHeaders");
  const signature = query.get("X-Amz-Signature");
  const expires = query.get("X-Amz-Expires");
  if (
    credential === undefined ||
    amzDate === undefined ||
    signedHeaders === undefined ||
    signature === undefined ||
    expires === undefined
  ) {
    throw new S3Error(
      "AuthorizationQueryParametersError",
      "Query-string authentication requires X-Amz-Credential, X-Amz-Date, X-Amz-Expires, X-Amz-SignedHeaders and X-Amz-Signature.",
    );
  }
  if (!AMZ_DATE_RE.test(amzDate) || !SIGNATURE_RE.test(signature)) {
    throw new S3Error(
      "AuthorizationQueryParametersError",
      "X-Amz-Date or X-Amz-Signature is malformed.",
    );
  }
  const expiresSeconds = Number(expires);
  if (
    !Number.isSafeInteger(expiresSeconds) ||
    expiresSeconds < 1 ||
    expiresSeconds > MAX_PRESIGN_EXPIRES_SECONDS
  ) {
    throw new S3Error(
      "AuthorizationQueryParametersError",
      "X-Amz-Expires must be between 1 and 604800 seconds.",
    );
  }
  return {
    kind: "query",
    ...parseCredential(credential),
    signedHeaders: parseSignedHeaders(signedHeaders),
    signature,
    amzDate,
    payloadHash: query.get("X-Amz-Content-Sha256") ?? UNSIGNED_PAYLOAD,
    expiresSeconds,
  };
}

function amzDateToMillis(amzDate: string): number {
  return Date.UTC(
    Number(amzDate.slice(0, 4)),
    Number(amzDate.slice(4, 6)) - 1,
    Number(amzDate.slice(6, 8)),
    Number(amzDate.slice(9, 11)),
    Number(amzDate.slice(11, 13)),
    Number(amzDate.slice(13, 15)),
  );
}

/** Verifies the request signature with the access key's secret. */
export function verifySigV4(
  input: SigV4RequestInput,
  parsed: ParsedSigV4,
  secretAccessKey: string,
  now: Date = new Date(),
): VerifiedSigV4 {
  if (parsed.service !== "s3") {
    throw new S3Error("AuthorizationHeaderMalformed", "The credential scope service must be s3.");
  }
  assertAmzHeadersSigned(input.headers, parsed);
  if (parsed.amzDate.slice(0, 8) !== parsed.scopeDate) {
    throw new S3Error(
      "AuthorizationHeaderMalformed",
      "The credential scope date does not match the request date.",
    );
  }
  const signedAt = amzDateToMillis(parsed.amzDate);
  if (parsed.kind === "header") {
    if (Math.abs(now.getTime() - signedAt) > MAX_CLOCK_SKEW_MS) {
      throw new S3Error(
        "RequestTimeTooSkewed",
        "The difference between the request time and the server's time is too large (more than 15 minutes). Check the client clock.",
      );
    }
  } else {
    if (signedAt - now.getTime() > MAX_CLOCK_SKEW_MS) {
      throw new S3Error("AccessDenied", "The presigned URL is not valid yet.");
    }
    if (now.getTime() > signedAt + (parsed.expiresSeconds ?? 0) * 1000) {
      throw new S3Error("AccessDenied", "Request has expired.");
    }
  }
  const scope = `${parsed.scopeDate}/${parsed.region}/${parsed.service}/aws4_request`;
  const signingKey = deriveSigningKey(
    secretAccessKey,
    parsed.scopeDate,
    parsed.region,
    parsed.service,
  );
  const canonical = canonicalRequest(
    input,
    parsed.signedHeaders,
    parsed.payloadHash,
    parsed.kind === "query" ? "X-Amz-Signature" : undefined,
  );
  const expected = signatureFor(signingKey, stringToSign(parsed.amzDate, scope, canonical));
  if (!signaturesMatch(expected, parsed.signature)) {
    throw new S3Error(
      "SignatureDoesNotMatch",
      "The request signature we calculated does not match the signature you provided. Check your key and signing method.",
    );
  }
  return { parsed, signingKey, scope, headers: trustedRequestHeaders(input.headers, parsed) };
}

/** Header auth carries these two outside SignedHeaders; both are bound by the string to sign. */
const HEADER_AUTH_UNSIGNED_AMZ = new Set(["x-amz-content-sha256", "x-amz-date"]);

/**
 * Every `x-amz-*` header changes what S3 does (copy source, metadata,
 * checksums), so, as in S3, each one must be signed. Otherwise the holder of a
 * presigned PUT URL could turn it into a CopyObject or inject metadata.
 */
function assertAmzHeadersSigned(headers: SigV4Headers, parsed: ParsedSigV4): void {
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith("x-amz-") &&
      !parsed.signedHeaders.includes(lower) &&
      !(parsed.kind === "header" && HEADER_AUTH_UNSIGNED_AMZ.has(lower))
    ) {
      throw new S3Error(
        "AccessDenied",
        `There were headers present in the request which were not signed: ${lower}.`,
      );
    }
  }
}

/** Content headers a presigned URL's holder may not choose unless the signer did. */
const PRESIGNED_UNSIGNED_IGNORED = ["content-type", "content-md5"] as const;

/** The headers to act on: presigned requests drop unsigned content headers. */
function trustedRequestHeaders(headers: SigV4Headers, parsed: ParsedSigV4): SigV4Headers {
  if (parsed.kind !== "query") return headers;
  const ignored = new Set<string>(
    PRESIGNED_UNSIGNED_IGNORED.filter((name) => !parsed.signedHeaders.includes(name)),
  );
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !ignored.has(name)));
}
