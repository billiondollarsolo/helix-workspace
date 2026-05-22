import { authenticatedFetch } from "@/lib/auth";

export type DriveApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type DriveApiEntryType = "file" | "folder";
export type DriveApiPreviewKind = "text" | "image" | "pdf" | "office" | "unsupported";
export type DriveApiPreviewStatus = "available" | "unsupported";

export interface DriveApiPreview {
  readonly kind: DriveApiPreviewKind;
  readonly status: DriveApiPreviewStatus;
  readonly mimeType: string;
  readonly text?: string;
  readonly url?: string;
  readonly pageCount?: number;
  readonly width?: number;
  readonly height?: number;
  readonly blocker?: string;
  readonly generatedAt?: string;
}

export interface DriveApiEntry {
  readonly id: string;
  readonly type: DriveApiEntryType;
  readonly name: string;
  readonly folderId: string | null;
  readonly ownerActorId: string | null;
  /** Editor app that owns this file: "docs" | "sheets" | "slides" | null (plain upload). */
  readonly app?: string | null;
  readonly mimeType?: string;
  readonly byteSize?: number;
  readonly sha256?: string | null;
  readonly storageKey?: string;
  readonly versionNumber?: number;
  readonly preview?: DriveApiPreview;
  readonly metadata?: Record<string, unknown>;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DriveApiSearchHit {
  readonly objectId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string | null;
  readonly folderId: string | null;
  readonly preview: string;
  readonly previewMetadata?: DriveApiPreview;
  readonly updatedAt: string;
}

export interface DriveShareInput {
  readonly objectId: string;
  readonly actorIds: readonly string[];
  readonly role?: "reader" | "commenter" | "editor" | "owner";
  readonly expiresAt?: string | null;
}

export interface DriveUploadInput {
  readonly name: string;
  readonly folderId?: string | null;
  readonly mimeType?: string;
  readonly byteSize?: number;
  readonly sha256?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface DriveUploadResult {
  readonly objectId: string;
  readonly orgId: string;
  readonly ownerActorId: string;
  readonly name: string;
  readonly folderId: string | null;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string | null;
  readonly status: string;
  readonly uploadUrl: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DriveFinalizeInput {
  readonly objectId: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly mimeType?: string;
  readonly storageKey?: string;
  readonly contentBase64?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface DriveVersionResult {
  readonly id: string;
  readonly orgId: string;
  readonly objectId: string;
  readonly versionNumber: number;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly metadata: Record<string, unknown>;
  readonly createdByActorId: string | null;
  readonly createdAt: string;
}

export async function prepareDriveUpload(
  input: DriveUploadInput,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveUploadResult> {
  return callDriveTool<DriveUploadResult>(
    "drive.upload",
    {
      name: input.name,
      folderId: input.folderId ?? null,
      mimeType: input.mimeType ?? "application/octet-stream",
      ...(input.byteSize === undefined ? {} : { byteSize: input.byteSize }),
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

export async function finalizeDriveUpload(
  input: DriveFinalizeInput,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveVersionResult> {
  return callDriveTool<DriveVersionResult>(
    "drive.finalize",
    {
      objectId: input.objectId,
      byteSize: input.byteSize,
      sha256: input.sha256,
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
      ...(input.storageKey === undefined ? {} : { storageKey: input.storageKey }),
      ...(input.contentBase64 === undefined ? {} : { contentBase64: input.contentBase64 }),
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

/**
 * Full browser upload pipeline: hash the file, `drive.upload` to reserve a
 * storage key, then `drive.finalize` with the base64 content to commit the
 * first immutable version. Returns the prepared object so callers can refresh
 * the listing.
 */
export async function uploadDriveFile(
  input: { readonly file: File; readonly folderId: string | null },
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveUploadResult> {
  const buffer = await input.file.arrayBuffer();
  const sha256 = await sha256Hex(buffer);
  const mimeType = input.file.type.length > 0 ? input.file.type : "application/octet-stream";

  const prepared = await prepareDriveUpload(
    {
      name: input.file.name,
      folderId: input.folderId,
      mimeType,
      byteSize: buffer.byteLength,
      sha256,
      metadata: { source: "web-shell" },
    },
    fetchImpl,
  );

  await finalizeDriveUpload(
    {
      objectId: prepared.objectId,
      byteSize: buffer.byteLength,
      sha256,
      mimeType,
      storageKey: prepared.storageKey,
      contentBase64: base64FromArrayBuffer(buffer),
      metadata: { source: "web-shell" },
    },
    fetchImpl,
  );

  return prepared;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64FromArrayBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function listDrive(
  input: {
    readonly folderId?: string | null;
    readonly includeTrashed?: boolean;
    readonly limit?: number;
  } = {},
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<readonly DriveApiEntry[]> {
  const output = await callDriveTool<{ readonly entries?: readonly DriveApiEntry[] }>(
    "drive.list",
    {
      folderId: input.folderId ?? null,
      includeTrashed: input.includeTrashed ?? false,
      limit: input.limit ?? 100,
    },
    fetchImpl,
  );

  return output.entries ?? [];
}

export async function searchDrive(
  input: { readonly query?: string; readonly folderId?: string | null; readonly limit?: number },
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<readonly DriveApiSearchHit[]> {
  const output = await callDriveTool<{ readonly hits?: readonly DriveApiSearchHit[] }>(
    "drive.search",
    {
      query: input.query,
      folderId: input.folderId ?? null,
      limit: input.limit ?? 50,
    },
    fetchImpl,
  );

  return output.hits ?? [];
}

export async function shareDrive(
  input: DriveShareInput,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<void> {
  await callDriveTool(
    "drive.share",
    {
      objectId: input.objectId,
      actorIds: input.actorIds,
      role: input.role ?? "reader",
      expiresAt: input.expiresAt ?? null,
    },
    fetchImpl,
  );
}

export async function moveDriveObject(
  objectId: string,
  folderId: string | null,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveApiEntry | null> {
  return callDriveTool<DriveApiEntry | null>("drive.move", { objectId, folderId }, fetchImpl);
}

export interface DriveDownloadResult {
  readonly url: string;
  readonly name: string;
  readonly mimeType: string;
}

/**
 * Resolve a downloadable URL for a Drive file. Prefers the entry's preview
 * URL when the backend produced one; otherwise falls back to the WebDAV
 * content path served at `/dav/<objectId>` which streams the latest version.
 */
export function driveDownloadResult(entry: DriveApiEntry): DriveDownloadResult {
  return {
    url: entry.preview?.url ?? `/dav/${entry.id}`,
    name: entry.name,
    mimeType: entry.mimeType ?? entry.preview?.mimeType ?? "application/octet-stream",
  };
}

export async function trashDriveObject(
  objectId: string,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveApiEntry | null> {
  return callDriveTool<DriveApiEntry | null>("drive.trash", { objectId }, fetchImpl);
}

export async function restoreDriveObject(
  objectId: string,
  folderId: string | null = null,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveApiEntry | null> {
  return callDriveTool<DriveApiEntry | null>("drive.restore", { objectId, folderId }, fetchImpl);
}

export type DriveCreateKind = "folder" | "document" | "spreadsheet" | "presentation";

export interface DriveCreateInput {
  readonly kind: DriveCreateKind;
  readonly name: string;
  readonly folderId: string | null;
}

/** Result for doc/sheet/deck kinds — `{ id, app }`. Folder returns a DriveApiEntry. */
export interface DriveCreateResult {
  readonly id: string;
  readonly app?: string;
}

export async function createDriveEntry(
  input: DriveCreateInput,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveCreateResult> {
  return callDriveTool<DriveCreateResult>(
    "drive.create",
    {
      kind: input.kind,
      name: input.name,
      folderId: input.folderId,
    },
    fetchImpl,
  );
}

export async function deleteDriveObject(
  objectId: string,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<void> {
  await callDriveTool("drive.delete", { objectId }, fetchImpl);
}

async function callDriveTool<Output = unknown>(
  toolId: string,
  input: unknown,
  fetchImpl: DriveApiFetch,
): Promise<Output> {
  const response = await fetchImpl(`/api/tools/${toolId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const output: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ?? `${toolId} failed with ${String(response.status)}`,
    );
  }

  // Confirmation-gated tools (`drive.share`, `drive.delete`) reply 202 with a
  // pending action. The Drive surface already gathers explicit user intent
  // before invoking these, so we approve the pending action inline and use
  // the executed output as the tool result.
  if (response.status === 202 && isPendingConfirmation(output)) {
    return approvePendingDriveAction<Output>(output.pending.id, fetchImpl);
  }

  return output as Output;
}

interface PendingConfirmationEnvelope {
  readonly status: "pending_confirmation";
  readonly pending: { readonly id: string };
}

function isPendingConfirmation(output: unknown): output is PendingConfirmationEnvelope {
  return (
    isRecord(output) &&
    output.status === "pending_confirmation" &&
    isRecord(output.pending) &&
    typeof output.pending.id === "string"
  );
}

async function approvePendingDriveAction<Output>(
  pendingId: string,
  fetchImpl: DriveApiFetch,
): Promise<Output> {
  const response = await fetchImpl(
    `/api/tools/pending/${encodeURIComponent(pendingId)}/approve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  const output: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ?? `pending action failed with ${String(response.status)}`,
    );
  }
  if (isRecord(output) && output.status === "executed") {
    return output.output as Output;
  }
  // Still pending (e.g. multi-approver tier) — surface as a soft success.
  return output as Output;
}

function errorMessageFromOutput(output: unknown): string | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  // Legacy `{ error: string }` payloads.
  if (typeof output.error === "string") {
    return output.error;
  }
  // Standard Helix error envelope: `{ error: { code, message, traceId } }`.
  if (isRecord(output.error) && typeof output.error.message === "string") {
    return output.error.message;
  }
  if (typeof output.message === "string") {
    return output.message;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
