import { authenticatedFetch } from "@/lib/auth";
import type {
  DriveAccessGrant,
  DriveEntry,
  DriveEntryPage,
  DriveRenameInput,
  DriveRole,
  DriveSearchHit,
  DriveShareLink,
  DriveUploadResult as DriveUploadResultContract,
  DriveUploadStatus,
  DriveVersion,
} from "@helix/contracts";
export type DriveApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
/** Wire DTO for a Drive list/detail entry — sourced from @helix/contracts. */
export type DriveApiEntry = DriveEntry;
export type DriveApiSearchHit = DriveSearchHit;
export type { DriveAccessGrant, DriveShareLink, DriveVersion };
export type DriveVersionResult = DriveVersion;
export type DriveDocumentSurfaceView = "grid" | "list";
export type DriveWorkflowKind =
  | "shortcut"
  | "file_request"
  | "approval"
  | "ownership_transfer"
  | "shared_drive"
  | "classification"
  | "hold"
  | "investigation";
export interface DriveWorkflow {
  readonly id: string;
  readonly kind: DriveWorkflowKind;
  readonly resourceType: "object" | "folder";
  readonly resourceId: string;
  readonly requestedByActorId: string;
  readonly assignedToActorId: string | null;
  readonly state: "open" | "approved" | "rejected" | "cancelled" | "completed";
  readonly version: string;
  readonly payload: Record<string, unknown>;
  readonly policySnapshot: Record<string, unknown>;
  readonly dueAt: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface DriveShareInput {
  readonly objectId: string;
  readonly actorIds?: readonly string[];
  readonly actorRefs?: readonly string[];
  readonly role?: DriveRole;
  readonly expiresAt?: string | null;
}
export type DriveAccessRole = Exclude<DriveRole, "owner">;
export interface DriveUploadInput {
  readonly name: string;
  readonly folderId?: string | null;
  readonly mimeType?: string;
  readonly byteSize?: number;
  readonly sha256?: string;
  readonly metadata?: Record<string, unknown>;
}
export type DriveUploadResult = DriveUploadResultContract;
export type { DriveUploadStatus };
export interface DriveFinalizeInput {
  readonly objectId: string;
  readonly byteSize: number;
  readonly sha256?: string;
  readonly mimeType?: string;
  readonly idempotencyKey?: string;
  readonly metadata?: Record<string, unknown>;
}
export interface DriveShareLinkCreateInput {
  readonly objectId: string;
  readonly password?: string;
  readonly expiresAt?: string | null;
  readonly oneTime?: boolean;
  readonly allowedDomains?: readonly string[];
  readonly allowDownload?: boolean;
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
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}
export async function getDriveUploadStatus(
  objectId: string,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveUploadStatus> {
  return callDriveTool<DriveUploadStatus>("drive.upload.status", { objectId }, fetchImpl);
}
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
/** Upload directly to tenant storage without materializing the file in JS memory. */
export async function uploadDriveFile(
  input: {
    readonly file: File;
    readonly folderId: string | null;
    readonly signal?: AbortSignal;
  },
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveUploadResult> {
  input.signal?.throwIfAborted();
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
        byteSize: input.file.size,
        metadata: { source: "web-shell" },
      },
      fetchImpl,
    ));
  if (prepared.multipart !== undefined) {
    assertMultipartPlan(prepared.multipart, input.file.size);
    const record: MultipartResumeRecord = resumed ?? {
      version: 1,
      fingerprint: multipartFingerprint(input.file, input.folderId),
      prepared,
      completed: [],
    };
    saveMultipartResume(resumeKey, record);
    const parts = await uploadMultipartParts(
      input.file,
      prepared.multipart,
      mimeType,
      record.completed,
      (completed) => {
        saveMultipartResume(resumeKey, { ...record, completed });
      },
      input.signal,
    );
    input.signal?.throwIfAborted();
    await callDriveTool(
      "drive.upload.complete",
      {
        objectId: prepared.objectId,
        uploadId: prepared.multipart.uploadId,
        parts,
        byteSize: input.file.size,
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
  await putWithRetry(
    prepared.uploadUrl,
    {
      headers: { ...prepared.uploadHeaders, "content-type": mimeType },
      body: input.file,
    },
    "Direct upload to storage",
    input.signal,
  );
  input.signal?.throwIfAborted();
  await finalizeDriveUpload(
    {
      objectId: prepared.objectId,
      byteSize: input.file.size,
      mimeType,
      idempotencyKey: `upload:${prepared.objectId}`,
      metadata: { source: "web-shell" },
    },
    fetchImpl,
  );
  return prepared;
}
async function uploadMultipartParts(
  file: File,
  multipart: NonNullable<DriveUploadResult["multipart"]>,
  mimeType: string,
  resumedParts: readonly CompletedPart[],
  onProgress: (completed: readonly CompletedPart[]) => void,
  signal?: AbortSignal,
): Promise<readonly CompletedPart[]> {
  const completed = new Map(resumedParts.map((part) => [part.partNumber, part.etag]));
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
        part.url,
        {
          headers: { "content-type": mimeType },
          body: file.slice(start, Math.min(start + multipart.partSize, file.size)),
        },
        `Multipart part ${String(partNumber)}`,
        signal,
      );
      const etag = response.headers.get("etag")?.trim();
      if (etag === undefined || etag.length === 0) {
        throw new Error(`Multipart part ${String(partNumber)} did not return an ETag.`);
      }
      completed.set(partNumber, etag);
      onProgress(sortedCompletedParts(completed));
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
  url: string,
  init: Omit<RequestInit, "method" | "signal">,
  label: string,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        method: "PUT",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted || attempt === UPLOAD_ATTEMPTS - 1) throw error;
      continue;
    }
    if (response.ok) return response;
    if (!isRetryableUploadStatus(response.status) || attempt === UPLOAD_ATTEMPTS - 1) {
      throw new Error(`${label} failed: HTTP ${String(response.status)}`);
    }
  }
  throw new Error(`${label} failed.`);
}
function isRetryableUploadStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
function assertMultipartPlan(
  multipart: NonNullable<DriveUploadResult["multipart"]>,
  byteSize: number,
): void {
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
export async function listDrive(
  input: {
    readonly folderId?: string | null;
    readonly includeTrashed?: boolean;
    readonly limit?: number;
    readonly cursor?: string;
    /** Filter by object kind. Defaults server-side to 'file'; pass
     *  'recording' for the Recordings drive scope. */
    readonly kind?: "file" | "recording";
    /** When true, return every visible file across all folders. Folder
     *  rows are suppressed (the result is a flat file list). */
    readonly acrossFolders?: boolean;
  } = {},
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveEntryPage> {
  return callDriveTool<DriveEntryPage>(
    "drive.list",
    {
      folderId: input.folderId ?? null,
      includeTrashed: input.includeTrashed ?? false,
      limit: input.limit ?? 100,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.acrossFolders === undefined ? {} : { acrossFolders: input.acrossFolders }),
    },
    fetchImpl,
  );
}
export async function searchDrive(
  input: {
    readonly query?: string;
    readonly folderId?: string | null;
    readonly limit?: number;
  },
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<readonly DriveApiSearchHit[]> {
  const output = await callDriveTool<{
    readonly hits?: readonly DriveApiSearchHit[];
  }>(
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
export async function createDriveWorkflow(
  input: {
    readonly kind: DriveWorkflowKind;
    readonly resourceType: "object" | "folder";
    readonly resourceId: string;
    readonly assignedToActorId?: string;
    readonly assignedToActorRef?: string;
    readonly payload?: Record<string, unknown>;
    readonly dueAt?: string;
  },
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveWorkflow> {
  return callDriveTool(
    "drive.workflow.create",
    { ...input, payload: input.payload ?? {} },
    fetchImpl,
  );
}
export async function listDriveWorkflows(
  state?: DriveWorkflow["state"],
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<readonly DriveWorkflow[]> {
  const output = await callDriveTool<{
    readonly workflows?: readonly DriveWorkflow[];
  }>("drive.workflow.list", { ...(state === undefined ? {} : { state }), limit: 100 }, fetchImpl);
  return output.workflows ?? [];
}
export async function transitionDriveWorkflow(
  workflow: Pick<DriveWorkflow, "id" | "version">,
  state: "approved" | "rejected" | "cancelled" | "completed",
  payload: Record<string, unknown> = {},
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveWorkflow> {
  return callDriveTool(
    "drive.workflow.transition",
    { workflowId: workflow.id, expectedVersion: workflow.version, state, payload },
    fetchImpl,
  );
}
export async function listDriveAccess(
  objectId: string,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<readonly DriveAccessGrant[]> {
  const output = await callDriveTool<{
    readonly grants?: readonly DriveAccessGrant[];
  }>("drive.access.list", { objectId }, fetchImpl);
  return output.grants ?? [];
}
export async function removeDriveAccess(
  objectId: string,
  actorId: string,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<{
  readonly objectId: string;
  readonly actorId: string;
  readonly removed: boolean;
}> {
  return callDriveTool("drive.access.remove", { objectId, actorId }, fetchImpl);
}
export async function updateDriveAccessRole(
  objectId: string,
  actorId: string,
  role: DriveAccessRole,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<{
  readonly objectId: string;
  readonly actorId: string;
  readonly grant: DriveAccessGrant | null;
}> {
  return callDriveTool(
    "drive.access.update",
    { objectId, actorId, role, expiresAt: null },
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
export async function setDriveObjectStarred(
  objectId: string,
  starred: boolean,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveApiEntry | null> {
  return callDriveTool<DriveApiEntry | null>("drive.star.set", { objectId, starred }, fetchImpl);
}
export async function getDriveDocumentSurfaceView(
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveDocumentSurfaceView> {
  const output = await callDriveTool<{
    readonly view: DriveDocumentSurfaceView;
  }>("drive.view.get", {}, fetchImpl);
  return parseDriveDocumentSurfaceView(output.view);
}
export async function setDriveDocumentSurfaceView(
  view: DriveDocumentSurfaceView,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveDocumentSurfaceView> {
  const output = await callDriveTool<{
    readonly view: DriveDocumentSurfaceView;
  }>("drive.view.set", { view }, fetchImpl);
  return parseDriveDocumentSurfaceView(output.view);
}
function parseDriveDocumentSurfaceView(value: unknown): DriveDocumentSurfaceView {
  if (value !== "grid" && value !== "list") {
    throw new Error("Drive returned an invalid document surface view preference.");
  }
  return value;
}
export interface DriveDownloadResult {
  readonly url: string;
  readonly name: string;
  readonly mimeType: string;
}
export function driveDownloadResult(entry: DriveApiEntry): DriveDownloadResult {
  return {
    url: driveRawDownloadUrl(entry),
    name: entry.name,
    mimeType: entry.mimeType ?? "application/octet-stream",
  };
}

export function driveRawDownloadUrl(entry: DriveApiEntry): string {
  return `/v1/api/drive/objects/${encodeURIComponent(entry.id)}/content?download=1`;
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
export type DriveCreateKind = "folder";
export interface DriveCreateInput {
  readonly kind: DriveCreateKind;
  readonly name: string;
  readonly folderId: string | null;
}
/** Result for doc/sheet/deck kinds — `{ id, app }`. Folder returns a DriveApiEntry. */
export interface DriveCreateResult {
  readonly id: string;
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
export async function renameDriveObject(
  input: DriveRenameInput,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveApiEntry> {
  return callDriveTool<DriveApiEntry>(
    "drive.rename",
    { objectId: input.objectId, name: input.name },
    fetchImpl,
  );
}
export async function listDriveVersions(
  objectId: string,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<readonly DriveVersion[]> {
  const output = await callDriveTool<{
    readonly versions?: readonly DriveVersion[];
  }>("drive.versions.list", { objectId }, fetchImpl);
  return output.versions ?? [];
}
export async function revertDriveVersion(
  objectId: string,
  versionNumber: number,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveVersion> {
  return callDriveTool<DriveVersion>(
    "drive.versions.revert",
    { objectId, versionNumber },
    fetchImpl,
  );
}
export async function createDriveShareLink(
  input: DriveShareLinkCreateInput,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveShareLink> {
  return callDriveTool<DriveShareLink>(
    "drive.link.create",
    {
      objectId: input.objectId,
      ...(input.password === undefined ? {} : { password: input.password }),
      expiresAt: input.expiresAt ?? null,
      oneTime: input.oneTime ?? false,
      allowedDomains: input.allowedDomains ?? [],
      allowDownload: input.allowDownload ?? true,
    },
    fetchImpl,
  );
}
export async function listDriveShareLinks(
  objectId: string,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<readonly DriveShareLink[]> {
  const output = await callDriveTool<{
    readonly links?: readonly DriveShareLink[];
  }>("drive.link.list", { objectId }, fetchImpl);
  return output.links ?? [];
}
export async function revokeDriveShareLink(
  linkId: string,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<{
  readonly id: string;
  readonly revoked: boolean;
}> {
  return callDriveTool("drive.link.revoke", { linkId }, fetchImpl);
}
/** Public unauthenticated URL for a share-link token. */
export function drivePublicShareUrl(
  token: string,
  origin: string = "location" in globalThis ? globalThis.location.origin : "",
): string {
  const base = origin.replace(/\/$/u, "");
  return `${base}/v1/api/drive/share/${encodeURIComponent(token)}`;
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
  readonly pending: {
    readonly id: string;
  };
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
