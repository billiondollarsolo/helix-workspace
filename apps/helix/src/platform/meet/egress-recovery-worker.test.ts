import { existsSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mp4, orgId, roomId, setupEgressRecording } from "../../test-support/meet-egress.js";
import { egressRecordingPath, promoteEgressRecording } from "./egress-recording.js";
import { MeetEgressRecoveryWorker } from "./egress-recovery-worker.js";
import type { LiveKitEgress, LiveKitEgressInfo } from "./livekit-egress.js";

const recordingId = "77777777-7777-4777-8777-777777777777";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "meet-egress-recovery-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeEgress(info: Partial<LiveKitEgressInfo> | null) {
  return {
    startRoomRecording: vi.fn(),
    stopRecording: vi.fn(async () => undefined),
    getRecording: vi.fn(async () =>
      info === null
        ? null
        : {
            egressId: "EG_1",
            roomName: `${orgId}.${roomId}`,
            status: "EGRESS_COMPLETE",
            startedAt: new Date("2026-10-21T07:00:00.000Z"),
            endedAt: new Date("2026-10-21T07:30:00.000Z"),
            error: null,
            ...info,
          },
    ),
  } satisfies LiveKitEgress;
}

async function run(
  info: Partial<LiveKitEgressInfo> | null,
  options: { readonly minutesLater?: number; readonly file?: boolean } = {},
) {
  const setup = await setupEgressRecording(dir);
  if (options.file !== false) await writeFile(setup.file, mp4);
  const egress = fakeEgress(info);
  const worker = new MeetEgressRecoveryWorker({
    deps: setup.deps,
    recovery: setup.recordings,
    egress: () => egress,
    now: () => new Date(Date.now() + (options.minutesLater ?? 10) * 60_000),
  });
  const result = await worker.runOnce();
  return { ...setup, egress, result };
}

describe("Meet recording recovery", () => {
  it("saves a recording that finished while nobody was saving it", async () => {
    const { result, attached, recordings, events, file, store } = await run({});
    expect(result).toEqual({ saved: 1, dropped: 0, orphanFilesRemoved: 0 });
    expect(attached).toMatchObject([
      { orgId, roomId, startedAt: new Date("2026-10-21T07:00:00.000Z") },
    ]);
    expect(store.completeRecordingUpload).toHaveBeenCalledWith(recordingId);
    // The REC indicator is cleared even if egress_ended never arrived.
    expect(events).toMatchObject([{ event: "recording.ended", orgId, roomId }]);
    expect(existsSync(file)).toBe(false);
    // The in-memory store keeps completed rows; the Postgres one stops listing them.
    expect(recordings.recordings.has(recordingId)).toBe(true);
  });

  it("saves a recording stopped by its time limit", async () => {
    const { result } = await run({ status: "EGRESS_LIMIT_REACHED" });
    expect(result.saved).toBe(1);
  });

  it("leaves running and brand-new recordings alone", async () => {
    const running = await run({ status: "EGRESS_ACTIVE" });
    expect(running.result).toEqual({ saved: 0, dropped: 0, orphanFilesRemoved: 0 });
    expect(existsSync(running.file)).toBe(true);
    await rm(running.file);

    const fresh = await run({}, { minutesLater: 1 });
    expect(fresh.result.saved).toBe(0);
    expect(fresh.egress.getRecording).not.toHaveBeenCalled();
  });

  it("drops failed recordings and their files", async () => {
    const { result, recordings, file, attached } = await run({ status: "EGRESS_FAILED" });
    expect(result.dropped).toBe(1);
    expect(recordings.recordings.size).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(attached).toEqual([]);
  });

  it("saves a file LiveKit has forgotten, and drops a record with no file", async () => {
    const forgotten = await run(null);
    expect(forgotten.result.saved).toBe(1);
    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), "meet-egress-recovery-"));
    const empty = await run(null, { file: false });
    expect(empty.result.dropped).toBe(1);
  });

  it("stops and drops a recording past its expiry", async () => {
    const { result, egress } = await run({ status: "EGRESS_ACTIVE" }, { minutesLater: 120 });
    // setupEgressRecording expires the record an hour after it starts.
    expect(result.dropped).toBe(1);
    expect(egress.stopRecording).toHaveBeenCalledWith(orgId, roomId, "EG_1");
  });

  it("does not save a recording another save is working on", async () => {
    const setup = await setupEgressRecording(dir);
    await writeFile(setup.file, mp4);
    await setup.recordings.claimPromotion({ orgId, id: recordingId, leaseMs: 60 * 60_000 });
    const egress = fakeEgress({});
    const worker = new MeetEgressRecoveryWorker({
      deps: setup.deps,
      recovery: setup.recordings,
      egress: () => egress,
      now: () => new Date(Date.now() + 10 * 60_000),
    });
    expect((await worker.runOnce()).saved).toBe(0);
    const [recording] = await setup.recordings.listPending(1);
    if (recording === undefined) throw new Error("expected a pending recording");
    await expect(
      promoteEgressRecording(setup.deps, recording, {
        startedAt: new Date(),
        endedAt: new Date(),
      }),
    ).resolves.toEqual({ ok: false, busy: true });
    // A busy save must not delete the file the other save is reading.
    expect(existsSync(setup.file)).toBe(true);
  });

  it("removes old files that no recording owns", async () => {
    const setup = await setupEgressRecording(dir);
    const orphan = egressRecordingPath(dir, "99999999-9999-4999-8999-999999999999");
    const recent = egressRecordingPath(dir, "88888888-8888-4888-8888-888888888888");
    await writeFile(orphan, mp4);
    await writeFile(recent, mp4);
    await writeFile(join(dir, "notes.txt"), "keep");
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    await utimes(orphan, old, old);
    const worker = new MeetEgressRecoveryWorker({
      deps: setup.deps,
      recovery: setup.recordings,
      egress: () => fakeEgress({ status: "EGRESS_ACTIVE" }),
    });
    expect((await worker.runOnce()).orphanFilesRemoved).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });
});
