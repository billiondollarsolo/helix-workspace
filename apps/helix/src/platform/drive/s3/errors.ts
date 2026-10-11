/**
 * S3 error codes the gateway emits, with their HTTP status. Codes that S3
 * itself defines keep S3's meaning so SDK retry and error handling behave;
 * the `Object*` codes are Helix-specific and explain Drive's malware-scan
 * lifecycle, which S3 has no vocabulary for.
 */
const S3_ERROR_STATUS = {
  AccessDenied: 403,
  AuthorizationHeaderMalformed: 400,
  AuthorizationQueryParametersError: 400,
  BadDigest: 400,
  BucketAlreadyOwnedByYou: 409,
  EntityTooLarge: 400,
  EntityTooSmall: 400,
  IncompleteBody: 400,
  InternalError: 500,
  InvalidAccessKeyId: 403,
  InvalidArgument: 400,
  InvalidBucketName: 400,
  InvalidDigest: 400,
  InvalidObjectName: 400,
  InvalidPart: 400,
  InvalidPartOrder: 400,
  InvalidRange: 416,
  InvalidRequest: 400,
  InvalidURI: 400,
  KeyTooLongError: 400,
  MalformedXML: 400,
  MethodNotAllowed: 405,
  MissingContentLength: 411,
  NoSuchBucket: 404,
  NoSuchKey: 404,
  NoSuchUpload: 404,
  NotImplemented: 501,
  ObjectQuarantined: 403,
  ObjectScanPending: 409,
  OperationAborted: 409,
  PreconditionFailed: 412,
  QuotaExceeded: 403,
  RequestTimeTooSkewed: 403,
  ServiceUnavailable: 503,
  SignatureDoesNotMatch: 403,
  SlowDown: 503,
  XAmzContentSHA256Mismatch: 400,
} as const;

export type S3ErrorCode = keyof typeof S3_ERROR_STATUS;

export class S3Error extends Error {
  readonly statusCode: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    readonly code: S3ErrorCode,
    message: string,
    options: { readonly retryAfterSeconds?: number | undefined } = {},
  ) {
    super(message);
    this.name = "S3Error";
    this.statusCode = S3_ERROR_STATUS[code];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function xmlDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

/**
 * Maps Drive and platform errors onto S3 errors with actionable messages.
 * Drive's own messages are kept: they already say what to do next.
 */
export function toS3Error(error: unknown): S3Error {
  if (error instanceof S3Error) return error;
  const status =
    typeof error === "object" && error !== null && "statusCode" in error
      ? Number((error as { readonly statusCode: unknown }).statusCode)
      : 500;
  const message = error instanceof Error ? error.message : "Internal error.";
  const name = error instanceof Error ? error.name : "";
  if (name === "DriveQuotaExceededError" || name === "DriveStorageQuotaExceededError") {
    return new S3Error("QuotaExceeded", `${message} Ask an admin to raise the storage limit.`);
  }
  if (/quarantined|failed virus scan/iu.test(message)) {
    return new S3Error("ObjectQuarantined", message);
  }
  if (/virus scanning/iu.test(message)) {
    return new S3Error("ObjectScanPending", `${message} Retry after the malware scan completes.`);
  }
  if (/^DLP /u.test(message)) {
    return new S3Error("AccessDenied", `${message} Your organization's data-loss policy applies.`);
  }
  switch (status) {
    case 400:
    case 422:
      return new S3Error("InvalidArgument", message);
    case 401:
    case 403:
    case 423:
      return new S3Error("AccessDenied", message);
    case 404:
      return new S3Error("NoSuchKey", message);
    case 409:
      return new S3Error("OperationAborted", message);
    case 429:
      return new S3Error("SlowDown", message);
    default:
      return new S3Error("InternalError", "We encountered an internal error. Please try again.");
  }
}

export function s3ErrorXml(error: S3Error, resource: string, requestId: string): string {
  return xmlDocument(
    `<Error><Code>${error.code}</Code><Message>${xmlEscape(error.message)}</Message>` +
      `<Resource>${xmlEscape(resource)}</Resource><RequestId>${xmlEscape(requestId)}</RequestId></Error>`,
  );
}
