/* Promotes a finished Egress recording: the file Egress wrote to the shared
   recordings directory is copied into the organization's storage with the
   upload's metadata, then goes through the same validation, antivirus scan and
   attachment as any recording upload. The local file is always removed. */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
import { toJsonObject } from "../util/json.js";
import type { MeetEgressRecording, MeetEgressRecordingStore } from "./egress-store.js";
import { validatePreparedRecordingObject, type MeetRecordingScanner } from "./recording-files.js";
import type { MeetMediaWebhookStore, MeetStore } from "./store.js";

export interface EgressRecordingDeps {
  readonly store: MeetStore & MeetMediaWebhookStore;
  readonly recordings: MeetEgressRecordingStore;
  readonly storageResolver: TenantStorageResolver | undefined;
  readonly scanner?: MeetRecordingScanner | undefined;
  readonly requireScanner?: boolean | undefined;
  /** Refuse to save into storage that does not encrypt objects at rest. */
  readonly requireEncryption?: boolean | undefined;
  /** Directory Egress writes into, mounted at the same path in Helix. */
  readonly recordingDir: string;
}

/** Where Egress writes a recording; derived from Helix's own upload id only. */
export function egressRecordingPath(recordingDir: string, uploadId: string): string {
  return join(recordingDir, `${uploadId}.mp4`);
}

/** Recording is available when the shared directory is configured and usable. */
export async function recordingDirectoryReady(recordingDir: string | undefined): Promise<boolean> {
  if (recordingDir === undefined || recordingDir === "") return false;
  try {
    await access(recordingDir, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Long enough to copy, scan and attach a long meeting; a crashed save's claim runs out. */
export const EGRESS_PROMOTION_LEASE_MS = 2 * 60 * 60 * 1000;

export type EgressPromotion =
  | { readonly ok: true; readonly objectId: string }
  | { readonly ok: false; readonly error: string }
  /** Another save holds the recording; nothing was touched. */
  | { readonly ok: false; readonly busy: true };

export async function promoteEgressRecording(
  deps: EgressRecordingDeps,
  recording: MeetEgressRecording,
  times: { readonly startedAt: Date; readonly endedAt: Date },
): Promise<EgressPromotion> {
  const path = egressRecordingPath(deps.recordingDir, recording.id);
  if (
    !(await deps.recordings.claimPromotion({
      orgId: recording.orgId,
      id: recording.id,
      leaseMs: EGRESS_PROMOTION_LEASE_MS,
    }))
  )
    return { ok: false, busy: true };
  const fail = async (error: string): Promise<EgressPromotion> => {
    await deps.recordings.abandon({ orgId: recording.orgId, id: recording.id });
    return { ok: false, error };
  };
  try {
    if (deps.storageResolver === undefined)
      return await fail("Recording storage is not configured.");
    if (deps.requireScanner === true && deps.scanner === undefined)
      return await fail("Recording antivirus scanning is unavailable.");
    const size = (await stat(path).catch(() => null))?.size ?? 0;
    if (size === 0) return await fail("The recording produced no file.");
    const sha256 = await fileSha256(path);
    const storage = await deps.storageResolver({ orgId: recording.orgId });
    if (storage === undefined) return await fail("Recording storage is not configured.");
    if (deps.requireEncryption === true && storage.encryptionAtRest === undefined)
      return await fail("Encrypted recording storage is not configured.");

    await storage.client.put({
      key: recording.storageKey,
      body: createReadStream(path),
      contentType: recording.mimeType,
      metadata: { uploadId: recording.id, orgId: recording.orgId, roomId: recording.roomId },
    });
    const removeObject = () => storage.client.delete(recording.storageKey).catch(() => undefined);
    if (
      !(await deps.recordings.setDigest({
        orgId: recording.orgId,
        id: recording.id,
        byteSize: size,
        sha256,
      }))
    ) {
      await removeObject();
      return await fail("The recording is no longer pending.");
    }
    const prepared = await deps.store.getRecordingUpload(recording.id);
    if (prepared === null) {
      await removeObject();
      return await fail("The recording is no longer pending.");
    }
    const validation = await validatePreparedRecordingObject({
      storage: storage.client,
      prepared,
      scanner: deps.scanner,
    });
    if (!validation.ok) {
      await removeObject();
      return await fail(validation.error);
    }
    if (!(await deps.store.markRecordingUploadReady(recording.id, validation.evidence))) {
      await removeObject();
      return await fail("The recording could not be promoted.");
    }
    const attachment = await deps.store.attachRecording({
      orgId: recording.orgId,
      roomId: recording.roomId,
      storageKey: recording.storageKey,
      mimeType: recording.mimeType,
      byteSize: size,
      sha256,
      startedAt: times.startedAt,
      endedAt: times.endedAt,
      metadata: toJsonObject({
        source: "livekit-egress",
        uploadId: recording.id,
        egressId: recording.egressId,
        durationSeconds: Math.max(
          0,
          Math.floor((times.endedAt.getTime() - times.startedAt.getTime()) / 1_000),
        ),
        validation: validation.evidence,
      }),
    });
    if (attachment === null) {
      await removeObject();
      return { ok: false, error: "The meeting for this recording is unavailable." };
    }
    await deps.store.completeRecordingUpload(recording.id);
    return { ok: true, objectId: attachment.objectId };
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

/** Removes the local file of a recording that failed in Egress. */
export async function discardEgressRecording(
  deps: Pick<EgressRecordingDeps, "recordings" | "recordingDir">,
  recording: MeetEgressRecording,
): Promise<void> {
  await deps.recordings.abandon({ orgId: recording.orgId, id: recording.id });
  await unlink(egressRecordingPath(deps.recordingDir, recording.id)).catch(() => undefined);
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
