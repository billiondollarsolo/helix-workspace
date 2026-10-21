/* Recording file checks shared by Meet's recording pipeline: storage keys,
   supported media types, and validation/scanning of an uploaded recording object. */

import { createHash } from "node:crypto";
import type { JsonObject } from "@helix/sdk-types";
import { toJsonObject } from "../util/json.js";
import type { TenantStorageClient } from "../storage/tenant-resolver.js";
import type { MeetRecordingUploadRecord } from "./store.js";

export interface MeetRecordingScanner {
  scan(bytes: Buffer): Promise<MeetRecordingScanResult>;
  scanStream(bytes: AsyncIterable<Uint8Array>, byteSize: number): Promise<MeetRecordingScanResult>;
}

interface MeetRecordingScanResult {
  readonly infected: boolean;
  readonly signature: string | null;
  readonly scanned: boolean;
  readonly evidence: JsonObject;
}

export function storageKeySegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/^\/+|\/+$/gu, "")
    .replace(/[^A-Za-z0-9_.-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return normalized.length === 0 || normalized.includes("..") ? "recording" : normalized;
}

export function extensionForMimeType(mimeType: string): "mp4" | "webm" {
  return normalizedMimeType(mimeType) === "video/webm" ? "webm" : "mp4";
}

export function validateRecordingMedia(input: {
  readonly mimeType: string;
  readonly byteSize: number;
}): string | null {
  if (!isSupportedRecordingMimeType(input.mimeType)) {
    return "Meet recording media must be video/mp4 or video/webm.";
  }
  return input.byteSize <= 0 ? "Meet recording media byteSize must be greater than zero." : null;
}

function isSupportedRecordingMimeType(mimeType: string): boolean {
  const normalized = normalizedMimeType(mimeType);
  return normalized === "video/mp4" || normalized === "video/webm";
}

export async function validatePreparedRecordingObject(input: {
  readonly storage: TenantStorageClient;
  readonly prepared: MeetRecordingUploadRecord;
  readonly scanner?: MeetRecordingScanner | undefined;
}): Promise<
  | { readonly ok: true; readonly evidence: JsonObject }
  | { readonly ok: false; readonly error: string; readonly unavailable?: boolean }
> {
  const object = await input.storage.get(input.prepared.storageKey);
  if (object === null) {
    return { ok: false, error: "Prepared Meet recording object was not found in tenant storage." };
  }
  if (
    object.contentType !== undefined &&
    normalizedMimeType(object.contentType) !== normalizedMimeType(input.prepared.mimeType)
  ) {
    return {
      ok: false,
      error: "Prepared Meet recording object content type does not match the prepared upload.",
    };
  }
  const body = await inspectStorageObjectBody(object.body, input.scanner, input.prepared.byteSize);
  const mediaError = validateMediaSignature(body.prefix, input.prepared.mimeType);
  if (mediaError !== null) {
    return { ok: false, error: mediaError };
  }
  if (body.byteLength !== input.prepared.byteSize) {
    return {
      ok: false,
      error: "Prepared Meet recording object byte size does not match the prepared upload.",
    };
  }
  if (body.sha256 !== input.prepared.sha256) {
    return {
      ok: false,
      error: "Prepared Meet recording object sha256 does not match the prepared upload.",
    };
  }
  const metadata = normalizeMetadata(object.metadata);
  if (metadata.uploadid !== input.prepared.id) {
    return {
      ok: false,
      error: "Prepared Meet recording object metadata does not match the uploadId.",
    };
  }
  if (metadata.orgid !== input.prepared.orgId) {
    return {
      ok: false,
      error: "Prepared Meet recording object metadata does not match the org id.",
    };
  }
  if (metadata.roomid !== input.prepared.roomId) {
    return {
      ok: false,
      error: "Prepared Meet recording object metadata does not match the room id.",
    };
  }
  if (body.scan?.infected === true) {
    return {
      ok: false,
      error: `Prepared Meet recording failed antivirus scanning${body.scan.signature === null ? "." : `: ${body.scan.signature}.`}`,
    };
  }
  if (body.scan?.scanned === false) {
    return {
      ok: false,
      unavailable: true,
      error: "Meet recording antivirus scanner did not scan the complete object.",
    };
  }
  return {
    ok: true,
    evidence: toJsonObject({
      status: "ready",
      byteSize: body.byteLength,
      sha256: body.sha256,
      mimeType: normalizedMimeType(input.prepared.mimeType),
      antivirus: body.scan?.evidence ?? { required: false },
    }),
  };
}

async function inspectStorageObjectBody(
  body: AsyncIterable<Uint8Array> | Uint8Array,
  scanner: MeetRecordingScanner | undefined,
  expectedByteSize: number,
): Promise<{
  readonly byteLength: number;
  readonly prefix: Buffer;
  readonly sha256: string;
  readonly scan: MeetRecordingScanResult | undefined;
}> {
  const hash = createHash("sha256");
  const prefixChunks: Uint8Array[] = [];
  let prefixLength = 0;
  let byteLength = 0;
  const observe = (chunk: Uint8Array): void => {
    byteLength += chunk.byteLength;
    hash.update(chunk);
    if (prefixLength < 12) {
      const slice = chunk.subarray(0, Math.min(chunk.byteLength, 12 - prefixLength));
      prefixChunks.push(slice);
      prefixLength += slice.byteLength;
    }
  };
  let scan: MeetRecordingScanResult | undefined;
  if (body instanceof Uint8Array) {
    observe(body);
    scan = await scanner?.scan(Buffer.from(body));
  } else if (scanner !== undefined) {
    const observed = (async function* (): AsyncIterable<Uint8Array> {
      for await (const chunk of body) {
        observe(chunk);
        yield chunk;
      }
    })();
    scan = await scanner.scanStream(observed, expectedByteSize);
  } else {
    for await (const chunk of body) {
      observe(chunk);
    }
  }
  return {
    byteLength,
    prefix: Buffer.concat(prefixChunks.map((chunk) => Buffer.from(chunk))),
    sha256: hash.digest("hex"),
    scan,
  };
}

function normalizeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

export function normalizedMimeType(mimeType: string): string {
  return mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
}

function validateMediaSignature(bytes: Buffer, mimeType: string): string | null {
  const mismatch = "Prepared Meet recording object bytes do not match the declared media type.";
  switch (normalizedMimeType(mimeType)) {
    case "video/webm":
      return bytes.byteLength >= 4 &&
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3
        ? null
        : mismatch;
    case "video/mp4":
      return bytes.byteLength >= 8 && bytes.subarray(4, 8).toString("ascii") === "ftyp"
        ? null
        : mismatch;
    default:
      return null;
  }
}
