/* Browser uploads straight to tenant storage. Files stream from the Blob
   (never read into JS memory); large files go up as resumable multipart
   slices. Storage PUTs use XMLHttpRequest because fetch() cannot report
   request-body progress, so callers get byte-level progress. */
import { authenticatedFetch } from "@/lib/auth";
import {
  completeDriveMultipartUpload,
  finalizeDriveUpload,
  prepareDriveUpload,
  type DriveApiFetch,
  type DriveUploadResult,
} from "./api";

/** Bytes sent so far out of the file's size. */
export type DriveUploadProgress = (loaded: number, total: number) => void;

export interface StoragePutRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Blob;
  readonly signal?: AbortSignal | undefined;
  /** Request-body bytes sent so far in this attempt. */
  readonly onProgress: (loaded: number) => void;
}

export interface StoragePutResponse {
  readonly status: number;
  readonly etag: string | null;
}

export type StoragePut = (request: StoragePutRequest) => Promise<StoragePutResponse>;

const MULTIPART_RESUME_PREFIX = "helix.drive.multipart.v1:";
const MULTIPART_CONCURRENCY = 3;
const UPLOAD_ATTEMPTS = 3;
type CompletedPart = {
  readonly partNumber: number;
  readonly etag: string;
};
interface MultipartResumeRecord {
  readonly version: 1;
  readonly fingerprint: string;
  readonly prepared: DriveUploadResult;
  readonly completed: readonly CompletedPart[];
}
type MultipartPlan = NonNullable<DriveUploadResult["multipart"]>;

/** PUT one Blob to a presigned storage URL, reporting upload progress. */
function xhrStoragePut(request: StoragePutRequest): Promise<StoragePutResponse> {
  return new Promise((resolve, reject) => {
    request.signal?.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => {
      xhr.abort();
    };
    const settle = () => {
      request.signal?.removeEventListener("abort", abort);
    };
    xhr.open("PUT", request.url);
    for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.addEventListener("progress", (event) => {
      request.onProgress(event.loaded);
    });
    xhr.addEventListener("load", () => {
      settle();
      resolve({ status: xhr.status, etag: xhr.getResponseHeader("etag") });
    });
    xhr.addEventListener("error", () => {
      settle();
      reject(new TypeError("The storage upload could not reach the server."));
    });
    xhr.addEventListener("abort", () => {
      settle();
      reject(request.signal?.reason ?? new DOMException("The upload was canceled.", "AbortError"));
    });
    request.signal?.addEventListener("abort", abort, { once: true });
    xhr.send(request.body);
  });
}

/**
 * Upload a file to Drive storage and finalize it. `onProgress` reports bytes
 * sent (including parts resumed from an earlier attempt) out of the file size.
 */
export async function uploadDriveFile(
  input: {
    readonly file: File;
    readonly folderId: string | null;
    readonly signal?: AbortSignal;
    readonly onProgress?: DriveUploadProgress;
  },
  fetchImpl: DriveApiFetch = authenticatedFetch,
  put: StoragePut = xhrStoragePut,
): Promise<DriveUploadResult> {
  input.signal?.throwIfAborted();
  const total = input.file.size;
  let reported = -1;
  const report = (loaded: number) => {
    const bytes = Math.min(total, Math.max(0, Math.round(loaded)));
    if (bytes === reported) return;
    reported = bytes;
    input.onProgress?.(bytes, total);
  };
  const mimeType = input.file.type.length > 0 ? input.file.type : "application/octet-stream";
  const resumeKey = multipartResumeKey(input.file, input.folderId);
  const resumed = loadMultipartResume(resumeKey, input.file, input.folderId, mimeType);
  const prepared =
    resumed?.prepared ??
    (await prepareDriveUpload(
      {
        name: input.file.name,
        folderId: input.folderId,
        mimeType,
        byteSize: total,
        metadata: { source: "web-shell" },
      },
      fetchImpl,
    ));
  if (prepared.multipart !== undefined) {
    assertMultipartPlan(prepared.multipart, total);
    const record: MultipartResumeRecord = resumed ?? {
      version: 1,
      fingerprint: multipartFingerprint(input.file, input.folderId),
      prepared,
      completed: [],
    };
    saveMultipartResume(resumeKey, record);
    const parts = await uploadMultipartParts(put, input.file, prepared.multipart, mimeType, {
      resumedParts: record.completed,
      onPartsCompleted: (completed) => {
        saveMultipartResume(resumeKey, { ...record, completed });
      },
      onBytes: report,
      signal: input.signal,
    });
    input.signal?.throwIfAborted();
    await completeDriveMultipartUpload(
      {
        objectId: prepared.objectId,
        uploadId: prepared.multipart.uploadId,
        parts,
        byteSize: total,
        mimeType,
        metadata: { source: "web-shell" },
      },
      fetchImpl,
    );
    clearMultipartResume(resumeKey);
    return prepared;
  }
  if (prepared.uploadUrl === null || prepared.uploadUrl.length === 0) {
    throw new Error("Drive storage did not provide an upload URL.");
  }
  report(0);
  await putWithRetry(
    put,
    {
      url: prepared.uploadUrl,
      headers: { ...prepared.uploadHeaders, "content-type": mimeType },
      body: input.file,
      signal: input.signal,
      onProgress: report,
    },
    "Direct upload to storage",
  );
  report(total);
  input.signal?.throwIfAborted();
  await finalizeDriveUpload(
    {
      objectId: prepared.objectId,
      byteSize: total,
      mimeType,
      idempotencyKey: `upload:${prepared.objectId}`,
      metadata: { source: "web-shell" },
    },
    fetchImpl,
  );
  return prepared;
}

async function uploadMultipartParts(
  put: StoragePut,
  file: File,
  multipart: MultipartPlan,
  mimeType: string,
  options: {
    readonly resumedParts: readonly CompletedPart[];
    readonly onPartsCompleted: (completed: readonly CompletedPart[]) => void;
    readonly onBytes: (loaded: number) => void;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<readonly CompletedPart[]> {
  const partBytes = (index: number) =>
    Math.max(0, Math.min(multipart.partSize, file.size - index * multipart.partSize));
  const completed = new Map(options.resumedParts.map((part) => [part.partNumber, part.etag]));
  let completedBytes = [...completed.keys()].reduce(
    (sum, partNumber) => sum + partBytes(partNumber - 1),
    0,
  );
  const inFlight = new Map<number, number>();
  const reportBytes = () => {
    let sending = 0;
    for (const bytes of inFlight.values()) sending += bytes;
    options.onBytes(completedBytes + sending);
  };
  reportBytes();
  const pending = multipart.partUrls
    .map((url, index) => ({ url, index }))
    .filter(({ index }) => !completed.has(index + 1));
  let next = 0;
  async function worker(): Promise<void> {
    while (next < pending.length) {
      const index = next;
      next += 1;
      const part = pending[index];
      if (part === undefined) continue;
      const partNumber = part.index + 1;
      const start = part.index * multipart.partSize;
      const response = await putWithRetry(
        put,
        {
          url: part.url,
          headers: { "content-type": mimeType },
          body: file.slice(start, start + partBytes(part.index)),
          signal: options.signal,
          onProgress: (loaded) => {
            inFlight.set(partNumber, Math.min(loaded, partBytes(part.index)));
            reportBytes();
          },
        },
        `Multipart part ${String(partNumber)}`,
      );
      inFlight.delete(partNumber);
      const etag = response.etag?.trim();
      if (etag === undefined || etag.length === 0) {
        throw new Error(`Multipart part ${String(partNumber)} did not return an ETag.`);
      }
      completed.set(partNumber, etag);
      completedBytes += partBytes(part.index);
      reportBytes();
      options.onPartsCompleted(sortedCompletedParts(completed));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MULTIPART_CONCURRENCY, pending.length) }, () => worker()),
  );
  return sortedCompletedParts(completed);
}

function sortedCompletedParts(parts: ReadonlyMap<number, string>): readonly CompletedPart[] {
  return [...parts]
    .map(([partNumber, etag]) => ({ partNumber, etag }))
    .sort((a, b) => a.partNumber - b.partNumber);
}

async function putWithRetry(
  put: StoragePut,
  request: StoragePutRequest,
  label: string,
): Promise<StoragePutResponse> {
  for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt += 1) {
    request.signal?.throwIfAborted();
    // A retried attempt sends the body again from the start.
    request.onProgress(0);
    let response: StoragePutResponse;
    try {
      response = await put(request);
    } catch (error) {
      if (request.signal?.aborted === true || attempt === UPLOAD_ATTEMPTS - 1) throw error;
      continue;
    }
    if (response.status >= 200 && response.status < 300) return response;
    if (!isRetryableUploadStatus(response.status) || attempt === UPLOAD_ATTEMPTS - 1) {
      throw new Error(`${label} failed: HTTP ${String(response.status)}`);
    }
  }
  throw new Error(`${label} failed.`);
}

function isRetryableUploadStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function assertMultipartPlan(multipart: MultipartPlan, byteSize: number): void {
  if (
    multipart.partUrls.length !== multipart.partCount ||
    Math.ceil(byteSize / multipart.partSize) !== multipart.partCount
  ) {
    throw new Error("Drive storage returned an invalid multipart upload plan.");
  }
}

function multipartResumeKey(file: File, folderId: string | null): string {
  return `${MULTIPART_RESUME_PREFIX}${encodeURIComponent(multipartFingerprint(file, folderId))}`;
}

function multipartFingerprint(file: File, folderId: string | null): string {
  return JSON.stringify([folderId, file.name, file.size, file.type, file.lastModified]);
}

function loadMultipartResume(
  key: string,
  file: File,
  folderId: string | null,
  mimeType: string,
): MultipartResumeRecord | null {
  const raw = readLocalStorage(key);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<MultipartResumeRecord>;
    const prepared = value.prepared;
    const multipart = prepared?.multipart;
    const completed = Array.isArray(value.completed) ? (value.completed as unknown[]) : null;
    const valid =
      value.version === 1 &&
      value.fingerprint === multipartFingerprint(file, folderId) &&
      prepared?.name === file.name &&
      prepared.folderId === folderId &&
      prepared.byteSize === file.size &&
      prepared.mimeType === mimeType &&
      multipart !== undefined &&
      Date.parse(multipart.expiresAt) > Date.now() &&
      multipart.partUrls.length === multipart.partCount &&
      Math.ceil(file.size / multipart.partSize) === multipart.partCount &&
      completed !== null &&
      completed.every((part): part is CompletedPart =>
        validCompletedPart(part, multipart.partCount),
      ) &&
      new Set(completed.map((part) => part.partNumber)).size === completed.length;
    if (valid) {
      return {
        version: 1,
        fingerprint: multipartFingerprint(file, folderId),
        prepared,
        completed,
      };
    }
  } catch {
    // A partial/corrupt browser write is not a resumable session.
  }
  clearMultipartResume(key);
  return null;
}

function validCompletedPart(value: unknown, partCount: number): value is CompletedPart {
  return (
    isRecord(value) &&
    Number.isInteger(value.partNumber) &&
    typeof value.partNumber === "number" &&
    value.partNumber > 0 &&
    value.partNumber <= partCount &&
    typeof value.etag === "string" &&
    value.etag.trim().length > 0
  );
}

function saveMultipartResume(key: string, record: MultipartResumeRecord): void {
  try {
    globalThis.localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // Upload remains functional when storage is unavailable or full.
  }
}

function readLocalStorage(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function clearMultipartResume(key: string): void {
  try {
    globalThis.localStorage.removeItem(key);
  } catch {
    // Nothing else is required; the server expires abandoned sessions.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
