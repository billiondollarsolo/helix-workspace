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

export interface SendBytesWithRangeOptions {
  readonly reply: FastifyReply;
  readonly request: FastifyRequest;
  readonly bytes: Buffer;
  readonly mimeType: string;
  readonly disposition: string;
}

export function sendBytesWithRangeSupport(opts: SendBytesWithRangeOptions): FastifyReply {
  const { reply, request, bytes, mimeType, disposition } = opts;
  const total = bytes.byteLength;
  const rangeHeader = request.headers["range"];

  reply.header("content-disposition", disposition);
  reply.header("accept-ranges", "bytes");
  reply.type(mimeType);

  if (typeof rangeHeader !== "string" || rangeHeader.length === 0) {
    reply.header("content-length", String(total));
    return reply.send(bytes);
  }

  const parsed = parseRangeHeader(rangeHeader, total);
  if (parsed === "invalid") {
    // Empty body: Content-Range header is the contract for 416.
    return reply.code(416).header("content-range", `bytes */${total}`).send();
  }
  if (parsed === "unsupported") {
    // Multi-range or syntactically valid but not a simple "bytes=N-M". Fall
    // back to serving the full body; browsers tolerate this gracefully.
    reply.header("content-length", String(total));
    return reply.send(bytes);
  }

  const { start, end } = parsed;
  const slice = bytes.subarray(start, end + 1);
  reply.header("content-range", `bytes ${start}-${end}/${total}`);
  reply.header("content-length", String(slice.byteLength));
  return reply.code(206).send(slice);
}

type ParsedRange =
  | { readonly start: number; readonly end: number }
  | "invalid"
  | "unsupported";

const BYTES_PREFIX_RE = /^bytes=(.+)$/u;

/** Parses `Range: bytes=N-M`, `bytes=N-` (open-ended), and `bytes=-N` (suffix).
 *  Multi-range (`bytes=0-100,200-300`) returns "unsupported" — we'd need
 *  multipart/byteranges to honor it and HTML5 players don't issue those. */
export function parseRangeHeader(header: string, total: number): ParsedRange {
  if (total === 0) return "invalid";
  const trimmed = header.trim();
  const matched = BYTES_PREFIX_RE.test(trimmed) ? trimmed.match(BYTES_PREFIX_RE) : null;
  if (matched === null) return "invalid";
  const spec = matched[1]!;
  if (spec.includes(",")) return "unsupported";

  const dash = spec.indexOf("-");
  if (dash === -1) return "invalid";

  const rawStart = spec.slice(0, dash);
  const rawEnd = spec.slice(dash + 1);

  let start: number;
  let end: number;

  if (rawStart === "" && rawEnd !== "") {
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else if (rawStart !== "" && rawEnd === "") {
    start = Number.parseInt(rawStart, 10);
    if (!Number.isFinite(start) || start < 0) return "invalid";
    end = total - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
    if (start < 0 || end < start) return "invalid";
    if (end >= total) end = total - 1;
  }

  if (start >= total) return "invalid";
  return { start, end };
}
