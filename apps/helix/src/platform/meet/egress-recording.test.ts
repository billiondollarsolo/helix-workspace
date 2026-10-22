import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleEgressWebhook } from "./egress-webhook.js";
import type { MeetRecordingScanner } from "./recording-files.js";
import {
  mp4,
  orgId,
  roomId,
  roomName,
  setupEgressRecording,
} from "../../test-support/meet-egress.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "meet-egress-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const setup = (options: { readonly scanner?: MeetRecordingScanner } = {}) =>
  setupEgressRecording(dir, options);

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

  it("announces a saved recording, and a failed announcement doesn't undo the save", async () => {
    const { deps, file, store, errors } = await setup();
    await writeFile(file, mp4);
    const saved: unknown[] = [];
    const onSaved = async (recording: unknown) => {
      saved.push(recording);
      throw new Error("mail is down");
    };
    await handleEgressWebhook({ ...deps, onSaved }, ended());
    await settle();
    expect(saved).toEqual([
      {
        orgId,
        roomId,
        objectId: "object-1",
        startedAt: new Date(1_792_569_600_000),
        endedAt: new Date(1_792_569_660_000),
      },
    ]);
    expect(store.completeRecordingUpload).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
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

  it("refuses to save into unencrypted storage when encryption is required", async () => {
    const { deps, storage, recordings, file, errors } = await setup();
    await writeFile(file, mp4);
    await handleEgressWebhook({ ...deps, requireEncryption: true }, ended());
    await settle();
    expect(storage.objects.size).toBe(0);
    expect(recordings.recordings.size).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(String(errors[0])).toContain("Encrypted recording storage");
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
