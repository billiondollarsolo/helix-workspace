/* Drive byte fetcher for the universal loader.
 *
 * Provides one helper to grab the raw body of a Drive object together with the
 * server-asserted name + mime type, sniffed from response headers. Used by
 * every per-format parser in `./parsers/*`.
 */

import { authenticatedFetch } from "@/lib/auth";

export interface DriveBlob {
  /** The Drive object's logical filename (parsed from Content-Disposition). */
  readonly name: string;
  /** Server-asserted content type, or `application/octet-stream` if unknown. */
  readonly mimeType: string;
  /** The raw bytes. */
  readonly bytes: ArrayBuffer;
  /** Byte length (mirror of bytes.byteLength for convenience). */
  readonly byteLength: number;
}

export class DriveBlobNotFoundError extends Error {
  constructor(readonly objectId: string) {
    super(`Drive object not found: ${objectId}`);
    this.name = "DriveBlobNotFoundError";
  }
}

export async function fetchDriveBlob(
  objectId: string,
  fetchImpl: typeof fetch = authenticatedFetch,
): Promise<DriveBlob> {
  const res = await fetchImpl(`/api/drive/objects/${objectId}/content`, {
    method: "GET",
    headers: { accept: "*/*" },
  });

  if (res.status === 404) throw new DriveBlobNotFoundError(objectId);
  if (!res.ok) {
    throw new Error(`Drive content fetch failed: HTTP ${res.status}`);
  }

  const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
  const name = parseFilenameFromDisposition(res.headers.get("content-disposition")) ?? objectId;
  const bytes = await res.arrayBuffer();

  return { name, mimeType, bytes, byteLength: bytes.byteLength };
}

/** Decode the RFC 5987 `filename*=UTF-8''…` form, falling back to ASCII `filename=`. */
function parseFilenameFromDisposition(value: string | null): string | null {
  if (value === null) return null;

  const rfc5987 = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (rfc5987) {
    try {
      return decodeURIComponent(rfc5987[1]!);
    } catch {
      // fall through to the ASCII fallback
    }
  }

  const ascii = /filename="((?:[^"\\]|\\.)*)"/i.exec(value);
  if (ascii) return ascii[1]!.replace(/\\(.)/g, "$1");

  return null;
}
