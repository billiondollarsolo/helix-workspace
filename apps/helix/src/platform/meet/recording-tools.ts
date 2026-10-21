/* meet.recording.start / meet.recording.stop: a host records the meeting through
   LiveKit Egress. Starting needs current recording-notice consent from everyone
   present (authorizeRecordingStart); the file is promoted when Egress finishes. */

import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import { NotFoundError } from "../../api/api-error.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { egressRecordingPath } from "./egress-recording.js";
import type { MeetEgressRecordingStore } from "./egress-store.js";
import type { LiveKitEgress } from "./livekit-egress.js";
import { storageKeySegment } from "./recording-files.js";
import type { MeetStore } from "./store.js";

/** Long enough for any meeting; the record is promoted or dropped when Egress ends. */
const RECORDING_RECORD_TTL_MS = 12 * 60 * 60 * 1000;
const roomSchema = z.object({ roomId: z.string().uuid() }).strict();
const objectSchema = { type: "object", additionalProperties: true } as const;

export interface MeetRecordingToolOptions {
  readonly store: MeetStore;
  readonly recordings?: MeetEgressRecordingStore | undefined;
  readonly egress?: (() => LiveKitEgress) | undefined;
  readonly recordingDir?: string | undefined;
  readonly recordingAvailable?: (() => Promise<boolean>) | undefined;
}

export function createMeetRecordingTools(options: MeetRecordingToolOptions): ToolDefinition[] {
  const configured = () => {
    if (
      options.recordings === undefined ||
      options.egress === undefined ||
      options.recordingDir === undefined
    )
      throw new Error("Meeting recording is unavailable.");
    return {
      recordings: options.recordings,
      egress: options.egress(),
      recordingDir: options.recordingDir,
    };
  };
  return [
    defineTool<z.output<typeof roomSchema>, unknown>({
      id: "meet.recording.start",
      description:
        "Start recording the meeting. Requires a host and current recording consent from everyone present.",
      permission: "meet.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(roomSchema, objectSchema),
      outputSchema: zodToolSchema(z.unknown(), objectSchema),
      handler: async (input, ctx) => {
        if ((await options.recordingAvailable?.()) !== true)
          throw new Error("Meeting recording is unavailable.");
        const { recordings, egress, recordingDir } = configured();
        const { orgId, id: actorId } = ctx.actor;
        const room = await options.store.getRoomForActor({ orgId, actorId, roomId: input.roomId });
        if (room === null) throw new NotFoundError(`Unknown Meet room: ${input.roomId}`);
        if ((await recordings.active({ orgId, roomId: room.id })) !== null)
          throw new Error("A recording is already running.");
        const authorization = await options.store.authorizeRecordingStart({
          orgId,
          actorId,
          roomId: room.id,
        });
        const startedAt = new Date();
        if (
          authorization === null ||
          !(await options.store.claimRecordingStartAuthorization({
            orgId,
            roomId: room.id,
            startedAt,
          }))
        )
          throw new Error(
            "Recording requires an active moderator and current consent from every participant.",
          );
        const id = randomUUID();
        if (
          !(await recordings.prepare({
            id,
            orgId,
            roomId: room.id,
            storageKey: `recordings/${storageKeySegment(room.roomName)}/${id}.mp4`,
            mimeType: "video/mp4",
            expiresAt: new Date(startedAt.getTime() + RECORDING_RECORD_TTL_MS),
          }))
        )
          throw new Error("A recording is already running.");
        try {
          const egressId = await egress.startRoomRecording(
            orgId,
            room.id,
            egressRecordingPath(recordingDir, id),
          );
          // The egress_started webhook may already have claimed it with this id.
          await recordings.setEgressId({ orgId, id, egressId });
        } catch {
          await recordings.abandon({ orgId, id });
          throw new Error("The recording could not be started. Try again in a moment.");
        }
        return { recordingId: id, startedAt: startedAt.toISOString() };
      },
    }),
    defineTool<z.output<typeof roomSchema>, unknown>({
      id: "meet.recording.stop",
      description:
        "Stop the meeting's recording. The file is added to the meeting when it is ready.",
      permission: "meet.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(roomSchema, objectSchema),
      outputSchema: zodToolSchema(z.unknown(), objectSchema),
      handler: async (input, ctx) => {
        const { recordings, egress } = configured();
        const { orgId, id: actorId } = ctx.actor;
        if (
          (await options.store.canModerateRoom?.({ orgId, actorId, roomId: input.roomId })) !== true
        )
          throw new Error("Only a host can stop the recording.");
        const recording = await recordings.active({ orgId, roomId: input.roomId });
        if (recording === null || recording.egressId === null) return { stopped: false };
        await egress.stopRecording(orgId, input.roomId, recording.egressId);
        return { stopped: true };
      },
    }),
  ];
}
