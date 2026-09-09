import type { Readable } from "node:stream";

export const API_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
export const API_REQUEST_TIMEOUT_MS = 30_000;
export const WEBSOCKET_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const INBOUND_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;
export const MEET_WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;
export const OAUTH_BODY_LIMIT_BYTES = 32 * 1024;
export const SCIM_BODY_LIMIT_BYTES = 1024 * 1024;
export const SIGNUP_BODY_LIMIT_BYTES = 64 * 1024;
export const DAV_BODY_LIMIT_BYTES = 512 * 1024;

export class RequestBodyTooLargeError extends Error {
  readonly statusCode = 413;
  readonly code = "FST_ERR_CTP_BODY_TOO_LARGE";

  constructor(readonly limitBytes: number) {
    super(`Request body exceeds the ${String(limitBytes)} byte limit.`);
    this.name = "RequestBodyTooLargeError";
  }
}

/** Collect a signature-sensitive control-plane body while enforcing its aggregate byte limit. */
export async function readBoundedRequestBody(
  payload: Readable,
  limitBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of payload as AsyncIterable<Buffer | string | Uint8Array>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limitBytes) {
      throw new RequestBodyTooLargeError(limitBytes);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}
