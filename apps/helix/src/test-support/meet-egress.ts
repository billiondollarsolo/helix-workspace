/* Shared setup for the Meet Egress recording tests: an in-memory recording
   store, storage and Meet store wired the way the webhook and the recovery
   worker use them. */

import type { StorageObject } from "@helix/sdk-types";
import { vi } from "vitest";
import { egressRecordingPath } from "../platform/meet/egress-recording.js";
import { InMemoryMeetEgressRecordingStore } from "../platform/meet/egress-store.js";
import type { EgressWebhookDeps } from "../platform/meet/egress-webhook.js";
import type { MeetRecordingScanner } from "../platform/meet/recording-files.js";
import type { MeetMediaEventInput } from "../platform/meet/store.js";
import type { TenantStorageClient } from "../platform/storage/tenant-resolver.js";

export const orgId = "22222222-2222-4222-8222-222222222222";
export const roomId = "33333333-3333-4333-8333-333333333333";
export const roomName = `${orgId}.${roomId}`;
// Smallest bytes that pass the MP4 signature check: a box header with "ftyp".
export const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.alloc(32),
]);

export class MemoryStorage implements TenantStorageClient {
  readonly objects = new Map<string, StorageObject & { bytes: Buffer }>();
  async put(object: StorageObject) {
    const chunks: Buffer[] = [];
    if (object.body instanceof Uint8Array) chunks.push(Buffer.from(object.body));
    else for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
    this.objects.set(object.key, { ...object, bytes: Buffer.concat(chunks) });
  }
  async get(key: string) {
    const object = this.objects.get(key);
    return object === undefined ? null : { ...object, body: object.bytes };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

export async function setupEgressRecording(
  dir: string,
  options: { readonly scanner?: MeetRecordingScanner } = {},
) {
  const recordings = new InMemoryMeetEgressRecordingStore();
  const storage = new MemoryStorage();
  const events: MeetMediaEventInput[] = [];
  const attached: unknown[] = [];
  const store = {
    applyMediaEvent: vi.fn(async (input: MeetMediaEventInput) => {
      const duplicate = events.some((event) => event.eventId === input.eventId);
      events.push(input);
      return {
        roomId,
        status: "active" as const,
        version: events.length,
        activeParticipantCount: 1,
        duplicate,
      };
    }),
    getRecordingUpload: vi.fn(async (id: string) => {
      const recording = recordings.recordings.get(id);
      return recording?.byteSize === undefined || recording.sha256 === undefined
        ? null
        : {
            ...recording,
            roomName: "Launch Review",
            byteSize: recording.byteSize,
            sha256: recording.sha256,
            completedAt: null,
          };
    }),
    markRecordingUploadReady: vi.fn(async () => true),
    attachRecording: vi.fn(async (input: unknown) => {
      attached.push(input);
      return { roomId, threadId: "t", objectId: "object-1", messageId: "m", storageKey: "k" };
    }),
    completeRecordingUpload: vi.fn(async () => true),
  };
  await recordings.prepare({
    id: "77777777-7777-4777-8777-777777777777",
    orgId,
    roomId,
    storageKey: "recordings/Launch-Review/77777777-7777-4777-8777-777777777777.mp4",
    mimeType: "video/mp4",
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await recordings.setEgressId({
    orgId,
    id: "77777777-7777-4777-8777-777777777777",
    egressId: "EG_1",
  });
  const errors: unknown[] = [];
  const deps = {
    store,
    recordings,
    storageResolver: () => ({ client: storage, managedBy: "helix-default", prefix: "" }),
    scanner: options.scanner,
    recordingDir: dir,
    now: () => new Date("2026-10-21T08:00:00.000Z"),
    onError: (error: unknown) => errors.push(error),
  } as unknown as EgressWebhookDeps;
  const file = egressRecordingPath(dir, "77777777-7777-4777-8777-777777777777");
  return { deps, recordings, storage, events, attached, errors, store, file };
}
