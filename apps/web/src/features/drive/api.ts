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
  /** Owner's display name, resolved server-side via `actors.display_name`.
   *  When present, the UI should show this instead of the raw owner UUID. */
  readonly ownerDisplayName?: string;
  /** Owner's email, when known. */
  readonly ownerEmail?: string;
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
  readonly ownerActorId: string | null;
  readonly ownerDisplayName?: string;
  readonly ownerEmail?: string;
  readonly app?: string | null;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string | null;
  readonly folderId: string | null;
  readonly preview: string;
  readonly previewMetadata?: DriveApiPreview;
  readonly metadata?: Record<string, unknown>;
  readonly updatedAt: string;
}

export interface DriveShareInput {
  readonly objectId: string;
  readonly actorIds?: readonly string[];
  readonly actorRefs?: readonly string[];
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
  readonly uploadHeaders?: Record<string, string>;
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
    /** Filter to entries owned by a specific editor app: "docs" | "sheets" | "slides". */
    readonly app?: string | null;
    /** Filter by object kind. Defaults server-side to 'file'; pass
     *  'recording' for the Recordings drive scope. */
    readonly kind?: "file" | "recording";
    /** When true, return every visible file across all folders. Folder
     *  rows are suppressed (the result is a flat file list). Used by
     *  /docs, /sheets, /slides which present app-shaped cross-folder lists. */
    readonly acrossFolders?: boolean;
  } = {},
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<readonly DriveApiEntry[]> {
  const output = await callDriveTool<{ readonly entries?: readonly DriveApiEntry[] }>(
    "drive.list",
    {
      folderId: input.folderId ?? null,
      includeTrashed: input.includeTrashed ?? false,
      limit: input.limit ?? 100,
      ...(input.app === undefined || input.app === null ? {} : { app: input.app }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.acrossFolders === undefined ? {} : { acrossFolders: input.acrossFolders }),
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
      actorIds: input.actorIds ?? [],
      actorRefs: input.actorRefs ?? [],
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
 * Resolve where the "Open" / "Download" buttons should point for a Drive
 * entry. Native editor files (docs / sheets / slides) and PDFs open in their
 * in-app surfaces; other raw binaries stream through the browser preview path.
 *
 * (The historical `/dav/<id>` URL never existed as a backend route —
 * `/dav/*` is reserved for CalDAV / CardDAV / WebDAV with app-password
 * Basic Auth, not the in-browser SPA.)
 */
export function driveDownloadResult(entry: DriveApiEntry): DriveDownloadResult {
  const editorUrl = inAppEditorUrl(entry);
  // For non-native raw files, point "Open" at the browser-renderable preview endpoint
  // (`/preview`) — it returns HTML for DOCX/XLSX, forwards PDFs / images
  // / text directly, and shows a friendly placeholder + download link for
  // formats the browser can't display.
  const url = editorUrl ?? entry.preview?.url ?? `/api/drive/objects/${entry.id}/preview`;
  return {
    url,
    name: entry.name,
    mimeType: entry.mimeType ?? entry.preview?.mimeType ?? "application/octet-stream",
  };
}

/** Resolve the in-app editor URL for a drive entry, or null when the file
 *  isn't natively editable.
 *
 *  Priority:
 *   1. Native Helix editors (.helixdoc / .helixsheet / .helixdeck) — these
 *      use the in-app Tiptap / sheets / slides surfaces.
 *   2. Plain PDFs — open in the in-app PDF viewer shell.
 *   3. OOXML (DOCX / XLSX / PPTX) — opens in the OnlyOffice editor
 *      at `/edit/:objectId`.
 *   4. Everything else — return null so the caller falls back to the
 *      read-only preview endpoint. */
function inAppEditorUrl(entry: DriveApiEntry): string | null {
  if (entry.app === "docs") {
    return `/docs/${encodeURIComponent(entry.id)}`;
  }
  if (entry.app === "sheets") {
    return `/sheets?sheet=${encodeURIComponent(entry.id)}`;
  }
  if (entry.app === "slides") {
    return `/slides?deck=${encodeURIComponent(entry.id)}`;
  }
  const mime = entry.mimeType ?? "";
  const name = entry.name.toLowerCase();
  if (mime === "application/pdf" || (mime.length === 0 && name.endsWith(".pdf"))) {
    const sourceFolder =
      entry.folderId === null ? "" : `?folder=${encodeURIComponent(entry.folderId)}`;
    return `/pdf/${encodeURIComponent(entry.id)}${sourceFolder}`;
  }
  // OOXML formats — opened via OnlyOffice Document Server (Phase 3).
  const isOoxml =
    mime.includes("wordprocessingml") ||
    mime.includes("spreadsheetml") ||
    mime.includes("presentationml") ||
    name.endsWith(".docx") ||
    name.endsWith(".xlsx") ||
    name.endsWith(".pptx") ||
    name.endsWith(".doc") ||
    name.endsWith(".xls") ||
    name.endsWith(".ppt");
  if (isOoxml) {
    return `/edit/${encodeURIComponent(entry.id)}`;
  }
  return null;
}

/**
 * Distinct URL specifically for the "Download" button — always streams the
 * raw bytes, never opens the editor. For native editor docs the bytes are
 * the Yjs state, which the API will return with the
 * `application/vnd.helix.*` mime type so the browser saves it as a file.
 */
export function driveRawDownloadUrl(entry: DriveApiEntry): string {
  return `/api/drive/objects/${entry.id}/content?download=1`;
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
  const response = await fetchImpl(`/api/tools/pending/${encodeURIComponent(pendingId)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
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
