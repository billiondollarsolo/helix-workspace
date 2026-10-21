import type { StorageObject } from "@helix/sdk-types";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantStorageClient } from "../storage/tenant-resolver.js";
import { egressRecordingPath } from "./egress-recording.js";
import { InMemoryMeetEgressRecordingStore } from "./egress-store.js";
import { handleEgressWebhook, type EgressWebhookDeps } from "./egress-webhook.js";
import type { MeetRecordingScanner } from "./recording-files.js";
import type { MeetMediaEventInput } from "./store.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const roomName = `${orgId}.${roomId}`;
// Smallest bytes that pass the MP4 signature check: a box header with "ftyp".
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(32)]);

class MemoryStorage implements TenantStorageClient {
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

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "meet-egress-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setup(options: { readonly scanner?: MeetRecordingScanner } = {}) {
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

const ended = (status = "EGRESS_COMPLETE", id = "EV_end") => ({
  event: "egress_ended",
  id,
  egressInfo: {
    egressId: "EG_1",
    roomName,
    status,
    startedAt: "1792569600000000000",
    endedAt: "1792569660000000000",
  },
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("Egress recordings", () => {
  it("marks the room recording when Egress starts", async () => {
    const { deps, events } = await setup();
    await expect(
      handleEgressWebhook(deps, {
        event: "egress_started",
        id: "EV_start",
        egressInfo: { egressId: "EG_1", roomName, status: "EGRESS_STARTING" },
      }),
    ).resolves.toEqual({ handled: true, body: { ok: true } });
    expect(events).toMatchObject([{ event: "recording.started", orgId, roomId }]);
  });

  it("promotes a finished recording into the organization's storage and removes the file", async () => {
    const { deps, storage, attached, file, errors } = await setup();
    await writeFile(file, mp4);
    await expect(handleEgressWebhook(deps, ended())).resolves.toMatchObject({
      body: { promoting: true },
    });
    await settle();
    expect(errors).toEqual([]);
    const stored = storage.objects.get(
      "recordings/Launch-Review/77777777-7777-4777-8777-777777777777.mp4",
    );
    expect(stored?.bytes.equals(mp4)).toBe(true);
    expect(stored?.metadata).toEqual({
      uploadId: "77777777-7777-4777-8777-777777777777",
      orgId,
      roomId,
    });
    expect(attached).toMatchObject([
      {
        orgId,
        roomId,
        byteSize: mp4.byteLength,
        sha256: createHash("sha256").update(mp4).digest("hex"),
        startedAt: new Date(1_792_569_600_000),
        endedAt: new Date(1_792_569_660_000),
        metadata: { source: "livekit-egress", egressId: "EG_1", durationSeconds: 60 },
      },
    ]);
    expect(existsSync(file)).toBe(false);
  });

  it("promotes only once when LiveKit redelivers egress_ended", async () => {
    const { deps, file, store } = await setup();
    await writeFile(file, mp4);
    await handleEgressWebhook(deps, ended());
    await settle();
    await expect(handleEgressWebhook(deps, ended())).resolves.toEqual({
      handled: true,
      body: { ok: true },
    });
    await settle();
    expect(store.attachRecording).toHaveBeenCalledTimes(1);
  });

  it("drops a recording that fails scanning or isn't a recording, keeping nothing", async () => {
    const scanner: MeetRecordingScanner = {
      scan: async () => ({ infected: true, signature: "Eicar", scanned: true, evidence: {} }),
      scanStream: async () => ({ infected: true, signature: "Eicar", scanned: true, evidence: {} }),
    };
    const { deps, storage, recordings, file, errors, attached } = await setup({ scanner });
    await writeFile(file, mp4);
    await handleEgressWebhook(deps, ended());
    await settle();
    expect(attached).toEqual([]);
    expect(storage.objects.size).toBe(0);
    expect(recordings.recordings.size).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(String(errors[0])).toContain("antivirus");
  });

  it("discards the file when Egress reports a failure", async () => {
    const { deps, recordings, file, errors } = await setup();
    await writeFile(file, mp4);
    await expect(handleEgressWebhook(deps, ended("EGRESS_FAILED"))).resolves.toMatchObject({
      body: { discarded: true },
    });
    expect(existsSync(file)).toBe(false);
    expect(recordings.recordings.size).toBe(0);
    expect(String(errors[0])).toContain("EGRESS_FAILED");
  });

  it("ignores egress Helix did not start and events for other rooms", async () => {
    const { deps, events } = await setup();
    const other = {
      event: "egress_ended",
      id: "EV_x",
      egressInfo: { egressId: "EG_other", roomName, status: "EGRESS_COMPLETE" },
    };
    await expect(handleEgressWebhook(deps, other)).resolves.toMatchObject({
      body: { ignored: true },
    });
    await expect(handleEgressWebhook(deps, { event: "room_started" })).resolves.toEqual({
      handled: false,
    });
    expect(events).toEqual([]);
  });
});
