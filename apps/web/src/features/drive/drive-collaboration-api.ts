import { authenticatedFetch } from "@/lib/auth";
import { callDriveTool, type DriveApiEntry, type DriveApiFetch } from "./api";

export async function hideDriveShare(
  objectId: string,
  hidden: boolean,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<void> {
  await callDriveTool("drive.hide.set", { objectId, hidden }, fetchImpl);
}

export async function requestDriveAccess(
  objectId: string,
  message?: string,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<{ readonly requestId: string }> {
  return callDriveTool("drive.access.request", { objectId, message }, fetchImpl);
}

export async function decideDriveAccess(
  requestId: string,
  approve: boolean,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<void> {
  await callDriveTool("drive.access.decide", { requestId, approve }, fetchImpl);
}

export interface DriveAccessRequest {
  readonly id: string;
  readonly objectId: string;
  readonly requesterActorId: string;
  readonly requesterDisplayName: string | null;
  readonly requesterEmail: string | null;
  readonly objectName: string;
  readonly message: string | null;
  readonly createdAt: string;
}

export async function listDriveAccessRequests(
  objectId?: string,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<readonly DriveAccessRequest[]> {
  const output = await callDriveTool<{
    readonly requests?: readonly {
      readonly id: string;
      readonly objectId: string;
      readonly requesterActorId: string;
      readonly requesterDisplayName?: string | null;
      readonly requesterEmail?: string | null;
      readonly objectName?: string;
      readonly message: string | null;
      readonly createdAt: Date | string;
    }[];
  }>("drive.access.requests", { ...(objectId === undefined ? {} : { objectId }) }, fetchImpl);
  return (output.requests ?? []).map((request) => ({
    id: request.id,
    objectId: request.objectId,
    requesterActorId: request.requesterActorId,
    requesterDisplayName: request.requesterDisplayName ?? null,
    requesterEmail: request.requesterEmail ?? null,
    objectName: request.objectName ?? "Drive item",
    message: request.message,
    createdAt:
      typeof request.createdAt === "string" ? request.createdAt : request.createdAt.toISOString(),
  }));
}

export async function moveDriveFolder(
  folderId: string,
  parentFolderId: string | null,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveApiEntry> {
  return callDriveTool("drive.folder.move", { folderId, parentFolderId }, fetchImpl);
}

export async function copyDriveObject(
  objectId: string,
  folderId?: string | null,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<DriveApiEntry> {
  return callDriveTool("drive.copy", { objectId, folderId: folderId ?? null }, fetchImpl);
}

export async function getDriveQuotaUsage(fetchImpl: DriveApiFetch = authenticatedFetch): Promise<{
  readonly usedBytes: number;
  readonly limitBytes: number | null;
  readonly unlimited: boolean;
  readonly percentUsed: number | null;
}> {
  return callDriveTool("drive.quota.usage", {}, fetchImpl);
}
