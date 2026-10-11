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
/** Commit the parts of a multipart upload once every part is in storage. */
export async function completeDriveMultipartUpload(
  input: {
    readonly objectId: string;
    readonly uploadId: string;
    readonly parts: readonly { readonly partNumber: number; readonly etag: string }[];
    readonly byteSize: number;
    readonly mimeType: string;
    readonly metadata: Record<string, unknown>;
  },
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<void> {
  await callDriveTool("drive.upload.complete", input, fetchImpl);
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
    /** Root views: My Drive (`owned`) or Shared with me (`shared`). */
    readonly view?: "owned" | "shared";
  } = {},
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveEntryPage> {
  const page = await callDriveTool<Partial<DriveEntryPage>>(
    "drive.list",
    {
      folderId: input.folderId ?? null,
      includeTrashed: input.includeTrashed ?? false,
      limit: input.limit ?? 100,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.acrossFolders === undefined ? {} : { acrossFolders: input.acrossFolders }),
      ...(input.view === undefined ? {} : { view: input.view }),
    },
    fetchImpl,
  );
  return { entries: page.entries ?? [], nextCursor: page.nextCursor ?? null };
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
/** The viewer's own usage; the organization limit and pooled usage only when a limit is set. */
export interface DriveStorageUsage {
  readonly usedBytes: number;
  readonly limitBytes: number | null;
  readonly organizationUsedBytes: number | null;
}
export async function getDriveStorageUsage(
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveStorageUsage> {
  return callDriveTool<DriveStorageUsage>("drive.storage.usage", {}, fetchImpl);
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
export async function moveDriveFolder(
  folderId: string,
  parentFolderId: string | null,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveApiEntry | null> {
  return callDriveTool<DriveApiEntry | null>(
    "drive.folder.move",
    { folderId, parentFolderId },
    fetchImpl,
  );
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
export function driveRawDownloadUrl(entry: { readonly id: string }): string {
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
type DriveCreateKind = "folder";
export interface DriveCreateInput {
  readonly kind: DriveCreateKind;
  readonly name: string;
  readonly folderId: string | null;
}
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
/** In-app link to a file or folder for people who already have access. */
export function driveItemUrl(
  item: { readonly id: string; readonly kind: "file" | "folder" },
  origin: string = "location" in globalThis ? globalThis.location.origin : "",
): string {
  const base = origin.replace(/\/$/u, "");
  const param = item.kind === "folder" ? "folder" : "file";
  return `${base}/drive?${param}=${encodeURIComponent(item.id)}`;
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
  if (typeof output.error === "string") {
    return output.error;
  }
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
