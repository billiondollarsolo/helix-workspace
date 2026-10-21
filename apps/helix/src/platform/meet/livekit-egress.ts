/* LiveKit Egress: Helix starts and stops room recordings itself. Egress writes an
   MP4 to a directory shared with Helix; Helix validates it and promotes it into
   the organization's storage when the egress_ended webhook arrives. */

import { liveKitRoomName, liveKitServerToken, type LiveKitOptions } from "./livekit.js";
import { LiveKitRoomError } from "./livekit-rooms.js";

export interface LiveKitEgress {
  /** Starts a grid recording of the room into `filepath` (a path Egress can write). */
  startRoomRecording(orgId: string, roomId: string, filepath: string): Promise<string>;
  stopRecording(orgId: string, roomId: string, egressId: string): Promise<void>;
}

export function createLiveKitEgress(
  options: LiveKitOptions,
  fetcher: typeof fetch = fetch,
): LiveKitEgress {
  async function call(method: string, room: string, body: object): Promise<unknown> {
    const response = await fetcher(
      new URL(`/twirp/livekit.Egress/${method}`, options.internalUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${liveKitServerToken(options, room)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new LiveKitRoomError(method, response.status);
    return (await response.json()) as unknown;
  }

  return {
    async startRoomRecording(orgId, roomId, filepath) {
      const room = liveKitRoomName(orgId, roomId);
      const info = (await call("StartRoomCompositeEgress", room, {
        room_name: room,
        layout: "grid",
        file_outputs: [{ file_type: "MP4", filepath }],
      })) as { egressId?: string; egress_id?: string };
      const egressId = info.egressId ?? info.egress_id;
      if (typeof egressId !== "string" || egressId.length === 0)
        throw new Error("LiveKit did not return an egress id.");
      return egressId;
    },
    async stopRecording(orgId, roomId, egressId) {
      await call("StopEgress", liveKitRoomName(orgId, roomId), { egress_id: egressId });
    },
  };
}

/** The parts of an Egress webhook Helix uses. */
export interface LiveKitEgressInfo {
  readonly egressId: string;
  readonly roomName: string;
  readonly status: string;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly error: string | null;
}

export function parseEgressInfo(value: unknown): LiveKitEgressInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const info = value as Record<string, unknown>;
  const egressId = info.egressId ?? info.egress_id;
  const roomName = info.roomName ?? info.room_name;
  if (typeof egressId !== "string" || typeof roomName !== "string") return null;
  return {
    egressId,
    roomName,
    status: typeof info.status === "string" ? info.status : "EGRESS_UNKNOWN",
    startedAt: nanosToDate(info.startedAt ?? info.started_at),
    endedAt: nanosToDate(info.endedAt ?? info.ended_at),
    error: typeof info.error === "string" && info.error !== "" ? info.error.slice(0, 500) : null,
  };
}

/** Egress timestamps are int64 nanoseconds, sent as strings. */
function nanosToDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const millis = Number(BigInt(value) / 1_000_000n);
    return millis > 0 ? new Date(millis) : null;
  } catch {
    return null;
  }
}
