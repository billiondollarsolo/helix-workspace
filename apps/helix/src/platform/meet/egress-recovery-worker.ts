/* Finishes Egress recordings whose save was interrupted, for example by a
   restart or a lost webhook. Each unfinished recording is checked with LiveKit:
   a finished one is saved, a failed or expired one is dropped, a running one is
   left alone. Leftover files with no recording behind them are removed. */

import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  discardEgressRecording,
  egressRecordingPath,
  promoteEgressRecording,
  type EgressRecordingDeps,
} from "./egress-recording.js";
import type { MeetEgressRecoveryStore, PendingMeetEgressRecording } from "./egress-store.js";
import { egressProducedFile } from "./egress-webhook.js";
import type { LiveKitEgress } from "./livekit-egress.js";

const RUNNING = new Set(["EGRESS_STARTING", "EGRESS_ACTIVE", "EGRESS_ENDING"]);
const BATCH = 500;
const RECORDING_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/;

export interface MeetEgressRecoveryResult {
  readonly saved: number;
  readonly dropped: number;
  readonly orphanFilesRemoved: number;
}

export interface MeetEgressRecoveryWorkerOptions {
  readonly deps: EgressRecordingDeps;
  readonly recovery: MeetEgressRecoveryStore;
  readonly egress: () => LiveKitEgress;
  readonly intervalMs?: number;
  /** Leave new recordings to the webhook for this long. */
  readonly graceMs?: number;
  readonly now?: () => Date;
  readonly onResult?: (result: MeetEgressRecoveryResult) => void;
  readonly onError?: (error: unknown) => void;
}

export class MeetEgressRecoveryWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<MeetEgressRecoveryResult> | undefined;

  constructor(private readonly options: MeetEgressRecoveryWorkerOptions) {}

  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    await this.runOnce().catch(() => undefined);
    this.timer = setInterval(
      () => void this.runOnce().catch(() => undefined),
      this.options.intervalMs ?? 5 * 60_000,
    );
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  runOnce(): Promise<MeetEgressRecoveryResult> {
    this.running ??= this.sweep()
      .then((result) => {
        this.options.onResult?.(result);
        return result;
      })
      .catch((error: unknown) => {
        this.options.onError?.(error);
        throw error;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async sweep(): Promise<MeetEgressRecoveryResult> {
    const now = (this.options.now ?? (() => new Date()))();
    const pending = await this.options.recovery.listPending(BATCH);
    let saved = 0;
    let dropped = 0;
    for (const recording of pending) {
      try {
        const outcome = await this.recover(recording, now);
        if (outcome === "saved") saved += 1;
        if (outcome === "dropped") dropped += 1;
      } catch (error) {
        // One recording (or a LiveKit hiccup) must not stop the rest.
        this.options.onError?.(error);
      }
    }
    // Only a complete list tells which files have no recording behind them.
    const orphanFilesRemoved =
      pending.length < BATCH
        ? await this.removeOrphanFiles(new Set(pending.map((r) => r.id)), now)
        : 0;
    return { saved, dropped, orphanFilesRemoved };
  }

  private async recover(
    recording: PendingMeetEgressRecording,
    now: Date,
  ): Promise<"saved" | "dropped" | "left"> {
    const { deps } = this.options;
    if ((recording.promotingUntil?.getTime() ?? 0) > now.getTime()) return "left";
    if (now.getTime() - recording.startedAt.getTime() < (this.options.graceMs ?? 5 * 60_000))
      return "left";
    const egress = this.options.egress();
    const drop = async () => {
      await discardEgressRecording(deps, recording);
      await this.markEnded(recording, now);
      return "dropped" as const;
    };

    // Starting never finished: there is no recording in LiveKit to wait for.
    if (recording.egressId === null) return drop();
    if (recording.expiresAt.getTime() <= now.getTime()) {
      await egress
        .stopRecording(recording.orgId, recording.roomId, recording.egressId)
        .catch(() => undefined);
      return drop();
    }

    const info = await egress.getRecording(recording.orgId, recording.roomId, recording.egressId);
    if (info !== null && RUNNING.has(info.status)) return "left";
    const file = await stat(egressRecordingPath(deps.recordingDir, recording.id)).catch(() => null);
    // LiveKit forgets finished recordings after a while; a file on disk is still worth saving.
    const finished = info === null ? file !== null : egressProducedFile(info.status);
    if (!finished) return drop();

    await this.markEnded(recording, info?.endedAt ?? file?.mtime ?? now);
    const result = await promoteEgressRecording(deps, recording, {
      startedAt: info?.startedAt ?? recording.startedAt,
      endedAt: info?.endedAt ?? file?.mtime ?? now,
    });
    if (result.ok) return "saved";
    if ("error" in result) {
      this.options.onError?.(new Error(`Meet recording was not recovered: ${result.error}`));
      return "dropped";
    }
    return "left";
  }

  /** Clears the meeting's REC indicator in case the egress_ended webhook was lost. */
  private async markEnded(recording: PendingMeetEgressRecording, at: Date) {
    await this.options.deps.store.applyMediaEvent({
      eventId: `helix:recording-recovered:${recording.id}`,
      orgId: recording.orgId,
      roomId: recording.roomId,
      event: "recording.ended",
      occurredAt: at,
    });
  }

  private async removeOrphanFiles(pending: ReadonlySet<string>, now: Date): Promise<number> {
    const dir = this.options.deps.recordingDir;
    const names = await readdir(dir).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names) {
      if (!RECORDING_FILE.test(name) || pending.has(name.slice(0, -4))) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      // A file that is still being written, or was just saved, is not an orphan yet.
      if (info === null || now.getTime() - info.mtime.getTime() < 60 * 60_000) continue;
      await unlink(path)
        .then(() => (removed += 1))
        .catch(() => undefined);
    }
    return removed;
  }
}
