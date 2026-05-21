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

  return output as Output;
}

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error === "string" ? output.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
