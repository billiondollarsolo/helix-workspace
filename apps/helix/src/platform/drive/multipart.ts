/**
 * Thin multipart-upload helpers for resumable Drive uploads.
 * Full S3 CreateMultipartUpload / UploadPart / Complete wiring is a follow-up;
 * these pure helpers plan part boundaries and shape complete-upload payloads.
 */

export const DEFAULT_MULTIPART_PART_SIZE = 8 * 1024 * 1024; // 8 MiB
export const DEFAULT_MULTIPART_THRESHOLD = 8 * 1024 * 1024;

export interface MultipartPartPlan {
  readonly partNumber: number;
  readonly start: number;
  readonly end: number;
  readonly size: number;
}

export interface MultipartUploadPlan {
  readonly partSize: number;
  readonly partCount: number;
  readonly parts: readonly MultipartPartPlan[];
}

export interface CompletedMultipartPart {
  readonly partNumber: number;
  readonly etag: string;
}

/**
 * Whether a prepared upload should use multipart based on declared size.
 */
export function shouldUseMultipartUpload(
  byteSize: number | undefined,
  threshold: number = DEFAULT_MULTIPART_THRESHOLD,
): boolean {
  return typeof byteSize === "number" && byteSize > threshold;
}

/**
 * Split a total byte size into contiguous part ranges for parallel PUTs.
 */
export function planMultipartParts(
  byteSize: number,
  partSize: number = DEFAULT_MULTIPART_PART_SIZE,
): MultipartUploadPlan {
  if (byteSize <= 0) {
    return { partSize, partCount: 0, parts: [] };
  }
  const safePartSize = Math.max(1, partSize);
  const parts: MultipartPartPlan[] = [];
  let offset = 0;
  let partNumber = 1;
  while (offset < byteSize) {
    const end = Math.min(offset + safePartSize, byteSize);
    parts.push({
      partNumber,
      start: offset,
      end,
      size: end - offset,
    });
    offset = end;
    partNumber += 1;
  }
  return {
    partSize: safePartSize,
    partCount: parts.length,
    parts,
  };
}

/**
 * Validate that completed parts form a contiguous 1..N sequence with etags.
 */
export function validateCompletedParts(
  parts: readonly CompletedMultipartPart[],
  expectedPartCount: number,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (parts.length !== expectedPartCount) {
    return {
      ok: false,
      reason: `Expected ${String(expectedPartCount)} parts, got ${String(parts.length)}.`,
    };
  }
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  for (let i = 0; i < sorted.length; i += 1) {
    const part = sorted[i];
    if (part === undefined) {
      return { ok: false, reason: "Missing part entry." };
    }
    if (part.partNumber !== i + 1) {
      return {
        ok: false,
        reason: `Expected part number ${String(i + 1)}, got ${String(part.partNumber)}.`,
      };
    }
    if (part.etag.trim().length === 0) {
      return { ok: false, reason: `Part ${String(part.partNumber)} is missing ETag.` };
    }
  }
  return { ok: true };
}
