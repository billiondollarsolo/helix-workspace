import { authenticatedFetch } from "@/lib/auth";
import { callDriveTool, type DriveApiFetch } from "./api";

/* Drive for the people an item is shared with: asking for access to something
   you cannot open, the owner's answer, and hiding a shared item. */

export async function hideDriveShare(
  objectId: string,
  hidden: boolean,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<void> {
  await callDriveTool("drive.hide.set", { objectId, hidden }, fetchImpl);
}

export async function requestDriveAccess(
  objectId: string,
  message: string,
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<void> {
  await callDriveTool(
    "drive.access.request",
    { objectId, ...(message.trim() === "" ? {} : { message: message.trim() }) },
    fetchImpl,
  );
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

/** Open requests for access to items the signed-in person owns. */
export async function listDriveAccessRequests(
  fetchImpl: DriveApiFetch = authenticatedFetch,
): Promise<readonly DriveAccessRequest[]> {
  const output = await callDriveTool<{ readonly requests?: readonly DriveAccessRequest[] }>(
    "drive.access.requests",
    {},
    fetchImpl,
  );
  return output.requests ?? [];
}
