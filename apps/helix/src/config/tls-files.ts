import type { Buffer } from "node:buffer";

/**
 * Shared loading rules for the PEM files backing PostgreSQL and Redis TLS.
 *
 * Both connections pin a CA (and optionally a client certificate/key pair) from
 * on-disk paths rather than inline environment values, so certificate material
 * never reaches URLs, logs, or process listings. The `subject` argument keeps
 * each caller's operator-facing error wording intact.
 */

/** Upper bound on a PEM file, so a mistyped path cannot read a huge blob into memory. */
export const MAX_TLS_FILE_BYTES = 1024 * 1024;

export type TlsFileReader = (path: string) => Buffer;

/** Normalize a configured TLS file path, rejecting relative or NUL-bearing values. */
export function tlsPathValue(value: string | undefined, subject: string): string | undefined {
  const path = value?.trim();
  if (path === undefined || path.length === 0) return undefined;
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error(`${subject} TLS files must use absolute paths.`);
  }
  return path;
}

/** Read a PEM file, collapsing every read/size failure into one opaque error. */
export function readTlsPem(path: string, readFile: TlsFileReader, subject: string): Buffer {
  // Only the read itself is guarded: the size check below must not have its own
  // failure re-reported as an unreadable file by an over-broad catch.
  let contents: Buffer;
  try {
    contents = readFile(path);
  } catch {
    throw new Error(`${subject} TLS file is unreadable or invalid.`);
  }
  if (contents.byteLength === 0 || contents.byteLength > MAX_TLS_FILE_BYTES) {
    throw new Error(`${subject} TLS file is unreadable or invalid.`);
  }
  return contents;
}
