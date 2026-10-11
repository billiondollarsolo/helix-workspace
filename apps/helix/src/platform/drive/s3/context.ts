import type { JsonObject, StorageClient } from "@helix/sdk-types";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DriveS3Access } from "./drive-access.js";
import { S3Error } from "./errors.js";
import type { DriveS3MultipartStore } from "./multipart-store.js";
import { decodeRequestPayload, type DecodedPayload } from "./payload.js";
import { readRawBody, type DriveS3Authentication, type DriveS3Target } from "./request.js";
import type { SigV4Headers } from "./sigv4.js";

export interface DriveS3Limits {
  /** Largest object a single PUT, copy, or completed multipart upload may write. */
  readonly maxObjectBytes: number;
  /** Smallest non-final multipart part, as in S3. */
  readonly minPartBytes: number;
  /** Lifetime of an unfinished multipart upload. */
  readonly multipartTtlMs: number;
  /** Unfinished multipart uploads one user may hold at once. */
  readonly maxOpenMultipartUploads: number;
}

export interface DriveS3Context extends DriveS3Access {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly target: DriveS3Target;
  readonly authentication: DriveS3Authentication;
  /** Headers the signature covers (`VerifiedSigV4.headers`); act on these, not `request.headers`. */
  readonly headers: SigV4Headers;
  readonly limits: DriveS3Limits;
  readonly region: string;
  readonly multipart: DriveS3MultipartStore;
  readonly resolveStorage: (orgId: string) => Promise<StorageClient | undefined>;
}

/** What an operation reports for the audit trail. */
export interface DriveS3OperationResult {
  readonly objectId?: string | null;
  readonly detail?: JsonObject;
}

/** Reads, de-chunks, and verifies the request payload against its signature and digests. */
export async function readDriveS3Payload(context: DriveS3Context): Promise<DecodedPayload> {
  const max = context.limits.maxObjectBytes;
  // aws-chunked framing adds ~90 bytes per chunk (64 KiB or larger in practice).
  const raw = await readRawBody(context.request, max + Math.ceil(max / 512) + 65_536);
  const payload = decodeRequestPayload({
    raw,
    headers: context.headers,
    auth: context.authentication.verified,
  });
  if (payload.body.byteLength > max) {
    throw new S3Error(
      "EntityTooLarge",
      `Objects written through the S3 API are limited to ${String(max)} bytes.`,
    );
  }
  return payload;
}
