import { SANDBOXED_CONTENT_CSP } from "./content-security.js";
/* HTTP Range request support for Drive content streaming.
 *
 * HTML5 `<audio>` and `<video>` elements seek by issuing `Range: bytes=N-M`
 * requests; without 206 Partial Content responses the player can play through
 * but the scrub bar is dead. Same goes for PDF.js range-fetching.
 *
 * This helper centralizes the response logic: parses the Range header,
 * validates it against the buffer length, and sends either:
 *   - 206 with the sliced bytes + `Content-Range` header (range hit)
 *   - 200 with the full bytes + `Accept-Ranges: bytes` advertisement
 *   - 416 Range Not Satisfiable + `Content-Range: bytes * /<total>` (invalid)
 *
 * Caller already authenticated the request; this function only deals with
 * the response framing.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

export interface SendBytesWithRangeOptions {
  readonly reply: FastifyReply;
  readonly request: FastifyRequest;
  readonly bytes: Buffer;
  readonly mimeType: string;
  readonly disposition: string;
  readonly lastModified?: Date | undefined;
}

export function sendBytesWithRangeSupport(opts: SendBytesWithRangeOptions): FastifyReply {
  const { reply, request, bytes, mimeType, disposition } = opts;
  const total = bytes.byteLength;
  const rangeHeader = request.headers["range"];
  const etag = `"sha256-${createHash("sha256").update(bytes).digest("base64url")}"`;

  reply.header("content-disposition", disposition);
  reply.header("accept-ranges", "bytes");
  reply.header("etag", etag);
  if (opts.lastModified !== undefined) {
    reply.header("last-modified", opts.lastModified.toUTCString());
  }
  reply.type(mimeType);

  if (!matchesIfMatch(request.headers["if-match"], etag)) {
    return reply.code(412).send();
  }
  if (matchesIfNoneMatch(request.headers["if-none-match"], etag)) {
    return reply.code(304).send();
  }

  if (
    typeof rangeHeader !== "string" ||
    rangeHeader.length === 0 ||
    !matchesIfRange(request.headers["if-range"], etag, opts.lastModified)
  ) {
    reply.header("content-length", String(total));
    return reply.send(bytes);
  }

  const parsed = parseRangeHeader(rangeHeader, total);
  if (parsed === null) {
    // Empty body: Content-Range header is the contract for 416.
    return reply
      .code(416)
      .header("content-range", `bytes */${String(total)}`)
      .send();
  }
  const { start, end } = parsed;
  const slice = bytes.subarray(start, end + 1);
  reply.header("content-range", `bytes ${String(start)}-${String(end)}/${String(total)}`);
  reply.header("content-length", String(slice.byteLength));
  return reply.code(206).send(slice);
}

export interface SendStreamWithRangeOptions {
  readonly reply: FastifyReply;
  readonly request: FastifyRequest;
  readonly byteSize: number;
  readonly etag: string;
  readonly mimeType: string;
  readonly disposition: string;
  readonly lastModified?: Date | undefined;
  readonly open: (range?: {
    readonly start: number;
    readonly end: number;
  }) => Promise<AsyncIterable<Uint8Array> | Uint8Array | null>;
}

/** Sends an object without materializing it. Storage is opened only after
 * conditional and Range validation, so HEAD/304/416 read zero object bytes. */
export async function sendStreamWithRangeSupport(
  opts: SendStreamWithRangeOptions,
): Promise<FastifyReply> {
  const { reply, request } = opts;
  if (!Number.isSafeInteger(opts.byteSize) || opts.byteSize < 0) {
    throw new TypeError("Drive stream byteSize must be a non-negative safe integer");
  }
  reply.header("content-disposition", opts.disposition);
  reply.header("content-security-policy", SANDBOXED_CONTENT_CSP);
  reply.header("x-content-type-options", "nosniff");
  reply.header("accept-ranges", "bytes");
  reply.header("etag", opts.etag);
  if (opts.lastModified !== undefined) {
    reply.header("last-modified", opts.lastModified.toUTCString());
  }
  reply.type(opts.mimeType);

  if (!matchesIfMatch(request.headers["if-match"], opts.etag)) {
    return reply.code(412).send();
  }
  if (matchesIfNoneMatch(request.headers["if-none-match"], opts.etag)) {
    return reply.code(304).send();
  }

  const requestedRange = request.headers.range;
  const useRange =
    typeof requestedRange === "string" &&
    requestedRange.length > 0 &&
    matchesIfRange(request.headers["if-range"], opts.etag, opts.lastModified);
  let range: { readonly start: number; readonly end: number } | undefined;
  if (useRange) {
    const parsed = parseRangeHeader(requestedRange, opts.byteSize);
    if (parsed === null) {
      return reply
        .code(416)
        .header("content-range", `bytes */${String(opts.byteSize)}`)
        .send();
    }
    range = parsed;
  }

  const contentLength = range === undefined ? opts.byteSize : range.end - range.start + 1;
  reply.header("content-length", String(contentLength));
  if (range !== undefined) {
    reply.header(
      "content-range",
      `bytes ${String(range.start)}-${String(range.end)}/${String(opts.byteSize)}`,
    );
  }
  if (request.method === "HEAD") {
    return reply.code(range === undefined ? 200 : 206).send();
  }
  const body = await opts.open(range);
  if (body === null) return reply.code(404).send();
  const stream = body instanceof Uint8Array ? Readable.from([body]) : Readable.from(body);
  request.raw.once("aborted", () => stream.destroy());
  return reply.code(range === undefined ? 200 : 206).send(stream);
}

function matchesIfMatch(value: string | string[] | undefined, etag: string): boolean {
  if (value === undefined) return true;
  const header = Array.isArray(value) ? value.join(",") : value;
  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === etag);
}

type ParsedRange = { readonly start: number; readonly end: number } | null;

const SIMPLE_BYTES_RANGE_RE = /^bytes=(\d*)-(\d*)$/u;

/** Parses one RFC byte range. Unsupported multi-ranges fail closed instead of
 * expanding a tiny request into a full-object response. */
export function parseRangeHeader(header: string, total: number): ParsedRange {
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  const match = SIMPLE_BYTES_RANGE_RE.exec(header.trim());
  if (match === null) return null;
  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;

  if (rawStart === "" && rawEnd !== "") {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else if (rawStart !== "" && rawEnd === "") {
    start = Number(rawStart);
    if (!Number.isSafeInteger(start)) return null;
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = Number(rawEnd);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    if (end >= total) end = total - 1;
  }

  if (start >= total) return null;
  return { start, end };
}

function matchesIfNoneMatch(value: string | string[] | undefined, etag: string): boolean {
  if (typeof value !== "string") return false;
  const normalizedEtag = etag.replace(/^W\//u, "");
  return value
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate.replace(/^W\//u, "") === normalizedEtag);
}

function matchesIfRange(
  value: string | string[] | undefined,
  etag: string,
  lastModified: Date | undefined,
): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string" || value.startsWith("W/")) return false;
  if (value.startsWith('"')) return value === etag;
  if (lastModified === undefined) return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    Math.floor(lastModified.getTime() / 1000) <= Math.floor(timestamp / 1000)
  );
}
