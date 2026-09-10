import type { StorageObject } from "@helix/sdk-types";
import { createHash } from "node:crypto";
import { DriveConflictError } from "../errors.js";
import {
  resolveEffectiveMime,
  sniffMimeType,
  type VirusScanner,
  type VirusScanResult,
} from "../scanning.js";
import { toUint8Array } from "./storage.js";
export function virusScanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/[\r\n\t]+/gu, " ").slice(0, 500) || "Antivirus scan failed.";
}

export function isMissingStorageObject(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (
      error as {
        readonly status?: unknown;
      }
    ).status === 404
  );
}

export function isQuarantineVerdict(error: unknown): boolean {
  if (!(error instanceof DriveConflictError)) return false;
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    "scanOutcome" in details &&
    details.scanOutcome === "quarantined"
  );
}

const MAX_BUFFERED_DRIVE_SCAN_BYTES = 128 * 1024 * 1024;

export async function inspectAndScanUpload(input: {
  readonly open: () => Promise<StorageObject["body"] | null>;
  readonly declaredByteSize: number;
  readonly declaredMimeType: string;
  readonly scanner: VirusScanner;
}): Promise<{
  readonly actualByteSize: number;
  readonly actualSha256: string;
  readonly mimeType: string;
  readonly scan: VirusScanResult | Error;
  readonly bufferedBytes?: Uint8Array;
}> {
  const first = await input.open();
  if (first === null) {
    throw new DriveConflictError("Drive upload bytes were not found at the reserved key.");
  }
  const inspected = await hashStorageBody(first);
  if (inspected.byteSize !== input.declaredByteSize) {
    throw new DriveConflictError("Drive upload size does not match stored bytes.", {
      details: { expectedByteSize: input.declaredByteSize, actualByteSize: inspected.byteSize },
    });
  }
  const mimeType = resolveEffectiveMime(input.declaredMimeType, sniffMimeType(inspected.head));
  let bufferedBytes = first instanceof Uint8Array ? first : undefined;
  let scan: VirusScanResult | Error;
  try {
    const archive = mimeType === "application/zip" || isGzipHead(inspected.head);
    if (
      bufferedBytes === undefined &&
      (archive || input.scanner.scanStream === undefined) &&
      inspected.byteSize <= MAX_BUFFERED_DRIVE_SCAN_BYTES
    ) {
      const reopened = await input.open();
      if (reopened === null) throw new Error("Drive upload disappeared before virus scanning.");
      bufferedBytes = await toUint8Array(reopened);
    }
    if (bufferedBytes !== undefined) {
      scan = await input.scanner.scan(bufferedBytes);
    } else if (input.scanner.scanStream !== undefined) {
      const reopened = await input.open();
      if (reopened === null) throw new Error("Drive upload disappeared before virus scanning.");
      scan = await input.scanner.scanStream(asAsyncIterable(reopened), inspected.byteSize);
    } else {
      throw new Error("Virus scanner does not support bounded streaming for this file size.");
    }
  } catch (error) {
    scan = error instanceof Error ? error : new Error(String(error));
  }
  return {
    actualByteSize: inspected.byteSize,
    actualSha256: inspected.sha256,
    mimeType,
    scan,
    ...(bufferedBytes === undefined ? {} : { bufferedBytes }),
  };
}

async function hashStorageBody(body: StorageObject["body"]): Promise<{
  readonly byteSize: number;
  readonly sha256: string;
  readonly head: Uint8Array;
}> {
  const hash = createHash("sha256");
  let byteSize = 0;
  const head = new Uint8Array(512);
  let headSize = 0;
  for await (const chunk of asAsyncIterable(body)) {
    byteSize += chunk.byteLength;
    if (!Number.isSafeInteger(byteSize)) throw new Error("Drive object exceeds safe size limits.");
    hash.update(chunk);
    if (headSize < head.byteLength) {
      const copied = Math.min(chunk.byteLength, head.byteLength - headSize);
      head.set(chunk.subarray(0, copied), headSize);
      headSize += copied;
    }
  }
  return { byteSize, sha256: hash.digest("hex"), head: head.subarray(0, headSize) };
}

async function* asAsyncIterable(body: StorageObject["body"]): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  yield* body;
}

function isGzipHead(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
