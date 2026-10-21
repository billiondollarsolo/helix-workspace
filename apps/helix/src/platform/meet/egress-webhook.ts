/* LiveKit's egress_started / egress_ended webhooks for Helix-started recordings.
   The recording is looked up by its egress id within the organization named in
   the LiveKit room name; anything Helix did not start is ignored. */

import {
  discardEgressRecording,
  promoteEgressRecording,
  type EgressRecordingDeps,
} from "./egress-recording.js";
import { parseLiveKitRoomName } from "./livekit.js";
import { parseEgressInfo } from "./livekit-egress.js";

export interface EgressWebhookDeps extends EgressRecordingDeps {
  readonly now: () => Date;
  readonly onError?: ((error: unknown) => void) | undefined;
}

export type EgressWebhookResult =
  | { readonly handled: false }
  | { readonly handled: true; readonly body: Readonly<Record<string, unknown>> };

export async function handleEgressWebhook(
  deps: EgressWebhookDeps,
  body: { readonly event?: unknown; readonly id?: unknown; readonly egressInfo?: unknown },
): Promise<EgressWebhookResult> {
  if (body.event !== "egress_started" && body.event !== "egress_ended") return { handled: false };
  const info = parseEgressInfo(body.egressInfo);
  const room = info === null ? null : parseLiveKitRoomName(info.roomName);
  if (info === null || room === null || typeof body.id !== "string")
    return { handled: true, body: { ok: true, ignored: true } };
  const recording =
    (await deps.recordings.byEgressId({ orgId: room.orgId, egressId: info.egressId })) ??
    (await claimPendingRecording(deps, room.orgId, room.roomId, info.egressId));
  if (recording === null || recording.roomId !== room.roomId)
    return { handled: true, body: { ok: true, ignored: true } };

  const started = body.event === "egress_started";
  const lifecycle = await deps.store.applyMediaEvent({
    eventId: `livekit:${body.id.slice(0, 200)}`,
    orgId: room.orgId,
    roomId: room.roomId,
    event: started ? "recording.started" : "recording.ended",
    occurredAt: (started ? info.startedAt : info.endedAt) ?? deps.now(),
  });
  // A redelivered webhook must not promote (or discard) the recording twice.
  if (started || lifecycle?.duplicate === true) return { handled: true, body: { ok: true } };

  if (egressProducedFile(info.status)) {
    // Copying, scanning and attaching can take a while; answer LiveKit first.
    void promoteEgressRecording(deps, recording, {
      startedAt: info.startedAt ?? recording.startedAt,
      endedAt: info.endedAt ?? deps.now(),
    })
      .then((result) => {
        if ("error" in result)
          deps.onError?.(new Error(`Meet recording was not saved: ${result.error}`));
      })
      .catch((error: unknown) => deps.onError?.(error));
    return { handled: true, body: { ok: true, promoting: true } };
  }
  await discardEgressRecording(deps, recording);
  deps.onError?.(
    new Error(
      `Meet recording failed in LiveKit Egress (${info.status}): ${info.error ?? "no detail"}`,
    ),
  );
  return { handled: true, body: { ok: true, discarded: true } };
}

/** A recording stopped by its time limit is still a complete file. */
export function egressProducedFile(status: string): boolean {
  return status === "EGRESS_COMPLETE" || status === "EGRESS_LIMIT_REACHED";
}

/** egress_started can arrive before the start tool has stored the egress id. */
async function claimPendingRecording(
  deps: EgressWebhookDeps,
  orgId: string,
  roomId: string,
  egressId: string,
) {
  const pending = await deps.recordings.active({ orgId, roomId });
  if (pending === null || pending.egressId !== null) return null;
  return (await deps.recordings.setEgressId({ orgId, id: pending.id, egressId }))
    ? { ...pending, egressId }
    : deps.recordings.byEgressId({ orgId, egressId });
}
