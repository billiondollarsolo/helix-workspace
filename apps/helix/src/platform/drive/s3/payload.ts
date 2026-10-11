import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { S3Error } from "./errors.js";
import {
  EMPTY_SHA256,
  headerValue,
  sha256Hex,
  signatureFor,
  signaturesMatch,
  STREAMING_SIGNED_PAYLOAD,
  STREAMING_SIGNED_PAYLOAD_TRAILER,
  STREAMING_UNSIGNED_PAYLOAD_TRAILER,
  UNSIGNED_PAYLOAD,
  type SigV4Headers,
  type VerifiedSigV4,
} from "./sigv4.js";

/**
 * Turns a raw request body into the object bytes the client meant to send:
 * decodes aws-chunked framing, verifies chunk and trailer signatures, checks
 * the signed payload hash, and validates Content-MD5 and x-amz-checksum-*
 * digests. Any mismatch fails closed before a byte reaches Drive.
 */
export interface DecodedPayload {
  readonly body: Buffer;
  readonly md5Hex: string;
  readonly sha256Hex: string;
}

export function decodeRequestPayload(input: {
  readonly raw: Buffer;
  readonly headers: SigV4Headers;
  readonly auth: VerifiedSigV4;
}): DecodedPayload {
  const payloadHash = input.auth.parsed.payloadHash;
  let body: Buffer;
  let trailers = new Map<string, string>();
  if (
    payloadHash === STREAMING_SIGNED_PAYLOAD ||
    payloadHash === STREAMING_SIGNED_PAYLOAD_TRAILER ||
    payloadHash === STREAMING_UNSIGNED_PAYLOAD_TRAILER
  ) {
    const decoded = decodeAwsChunked(input.raw, {
      signed: payloadHash !== STREAMING_UNSIGNED_PAYLOAD_TRAILER,
      trailer: payloadHash !== STREAMING_SIGNED_PAYLOAD,
      auth: input.auth,
    });
    body = decoded.body;
    trailers = decoded.trailers;
    const declared = headerValue(input.headers, "x-amz-decoded-content-length");
    if (declared !== undefined && Number(declared) !== body.byteLength) {
      throw new S3Error(
        "IncompleteBody",
        "The decoded body length does not match x-amz-decoded-content-length.",
      );
    }
  } else if (payloadHash === UNSIGNED_PAYLOAD) {
    body = input.raw;
  } else if (/^[0-9a-f]{64}$/u.test(payloadHash)) {
    body = input.raw;
    if (sha256Hex(body) !== payloadHash) {
      throw new S3Error(
        "XAmzContentSHA256Mismatch",
        "The provided x-amz-content-sha256 header does not match what was computed.",
      );
    }
  } else {
    throw new S3Error(
      "InvalidArgument",
      "x-amz-content-sha256 must be UNSIGNED-PAYLOAD, a SHA-256 hex digest, or a supported STREAMING-* value.",
    );
  }
  const md5 = createHash("md5").update(body).digest();
  verifyContentMd5(headerValue(input.headers, "content-md5"), md5);
  verifyChecksums(input.headers, trailers, body);
  return {
    body,
    md5Hex: md5.toString("hex"),
    sha256Hex: payloadHash.length === 64 ? payloadHash : sha256Hex(body),
  };
}

function verifyContentMd5(header: string | undefined, md5: Buffer): void {
  if (header === undefined) return;
  const expected = Buffer.from(header.trim(), "base64");
  if (expected.byteLength !== 16) {
    throw new S3Error("InvalidDigest", "The Content-MD5 you specified is not valid.");
  }
  if (!expected.equals(md5)) {
    throw new S3Error(
      "BadDigest",
      "The Content-MD5 you specified did not match what was received.",
    );
  }
}

const CHECKSUMS: Readonly<Record<string, ((body: Buffer) => Buffer) | null>> = {
  "x-amz-checksum-crc32": (body) => uint32Bytes(crc32(body)),
  "x-amz-checksum-crc32c": (body) => uint32Bytes(crc32c(body)),
  "x-amz-checksum-sha1": (body) => createHash("sha1").update(body).digest(),
  "x-amz-checksum-sha256": (body) => createHash("sha256").update(body).digest(),
  // Accepted without verification; the signed transport and Drive's SHA-256
  // still protect the bytes. Documented in docs/drive-s3-api.md.
  "x-amz-checksum-crc64nvme": null,
};

function verifyChecksums(
  headers: SigV4Headers,
  trailers: ReadonlyMap<string, string>,
  body: Buffer,
): void {
  for (const [name, compute] of Object.entries(CHECKSUMS)) {
    const value = trailers.get(name) ?? headerValue(headers, name);
    if (value === undefined || compute === null) continue;
    if (!compute(body).equals(Buffer.from(value.trim(), "base64"))) {
      throw new S3Error(
        "BadDigest",
        `The ${name.slice("x-amz-checksum-".length).toUpperCase()} checksum you specified did not match the received body.`,
      );
    }
  }
}

function uint32Bytes(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
}

let crc32cTable: Uint32Array | undefined;

function crc32c(body: Buffer): number {
  if (crc32cTable === undefined) {
    crc32cTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1;
      }
      crc32cTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of body) {
    crc = (crc32cTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Decodes aws-chunked framing, verifying each chunk signature when signed. */
function decodeAwsChunked(
  raw: Buffer,
  options: {
    readonly signed: boolean;
    readonly trailer: boolean;
    readonly auth: VerifiedSigV4;
  },
): { readonly body: Buffer; readonly trailers: Map<string, string> } {
  const chunks: Buffer[] = [];
  const trailers = new Map<string, string>();
  let offset = 0;
  let previousSignature = options.auth.parsed.signature;
  const readLine = (): string => {
    const end = raw.indexOf("\r\n", offset, "latin1");
    if (end < 0) throw new S3Error("IncompleteBody", "The aws-chunked body is truncated.");
    const line = raw.toString("latin1", offset, end);
    offset = end + 2;
    return line;
  };
  for (;;) {
    const header = readLine();
    const [sizeText = "", ...extensions] = header.split(";");
    if (!/^[0-9a-fA-F]{1,16}$/u.test(sizeText)) {
      throw new S3Error("IncompleteBody", "The aws-chunked chunk header is malformed.");
    }
    const size = Number.parseInt(sizeText, 16);
    if (offset + size > raw.byteLength) {
      throw new S3Error("IncompleteBody", "The aws-chunked body is truncated.");
    }
    const data = raw.subarray(offset, offset + size);
    offset += size;
    if (options.signed) {
      const signature = extensions
        .map((extension) => extension.trim())
        .find((extension) => extension.startsWith("chunk-signature="))
        ?.slice("chunk-signature=".length);
      const expected = signatureFor(
        options.auth.signingKey,
        [
          "AWS4-HMAC-SHA256-PAYLOAD",
          options.auth.parsed.amzDate,
          options.auth.scope,
          previousSignature,
          EMPTY_SHA256,
          sha256Hex(data),
        ].join("\n"),
      );
      if (signature === undefined || !signaturesMatch(expected, signature)) {
        throw new S3Error(
          "SignatureDoesNotMatch",
          "The chunk signature we calculated does not match the signature you provided.",
        );
      }
      previousSignature = signature;
    }
    if (size === 0) break;
    chunks.push(data);
    if (raw.toString("latin1", offset, offset + 2) !== "\r\n") {
      throw new S3Error("IncompleteBody", "The aws-chunked chunk is not terminated by CRLF.");
    }
    offset += 2;
  }
  const trailerLines: string[] = [];
  let trailerSignature: string | undefined;
  while (offset < raw.byteLength) {
    const line = readLine();
    if (line.length === 0) break;
    const separator = line.indexOf(":");
    if (separator <= 0)
      throw new S3Error("IncompleteBody", "The aws-chunked trailer is malformed.");
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === "x-amz-trailer-signature") {
      trailerSignature = value;
    } else {
      trailers.set(name, value);
      trailerLines.push(`${name}:${value}\n`);
    }
  }
  if (options.trailer && options.signed) {
    const expected = signatureFor(
      options.auth.signingKey,
      [
        "AWS4-HMAC-SHA256-TRAILER",
        options.auth.parsed.amzDate,
        options.auth.scope,
        previousSignature,
        sha256Hex(trailerLines.join("")),
      ].join("\n"),
    );
    if (trailerSignature === undefined || !signaturesMatch(expected, trailerSignature)) {
      throw new S3Error(
        "SignatureDoesNotMatch",
        "The trailer signature we calculated does not match the signature you provided.",
      );
    }
  }
  return { body: Buffer.concat(chunks), trailers };
}
