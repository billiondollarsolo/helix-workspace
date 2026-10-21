import { z } from "zod";
import { ForbiddenError, NotFoundError } from "../../api/api-error.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { MeetStore } from "./store.js";
import type { MeetTranscriptStore } from "./transcript-store.js";

export function registerMeetTranscriptTools(
  registry: RuntimeToolRegistry,
  options: {
    readonly meetings: MeetStore;
    readonly transcripts: MeetTranscriptStore;
    readonly enabled: (orgId: string) => Promise<boolean>;
  },
): void {
  const room = z.object({ roomId: z.string().uuid() }).strict();
  const output = zodToolSchema(z.unknown(), { type: "object" });
  registry.register(
    defineTool({
      id: "meet.transcript.list",
      description:
        "Read meeting transcription status and private Drive artifact references. Access follows meeting membership and Drive sharing.",
      permission: "meet.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(room, { type: "object" }),
      outputSchema: output,
      handler: async (input, ctx) => {
        if (
          !(await options.meetings.getRoomForActor({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            roomId: input.roomId,
          }))
        )
          throw new NotFoundError("Meeting not found.");
        return {
          enabled: await options.enabled(ctx.actor.orgId),
          requested: await options.transcripts.requested(ctx.actor.orgId, input.roomId),
          transcripts: (await options.transcripts.list(ctx.actor.orgId, input.roomId)).map(
            (row) => ({
              id: row.id,
              status: row.status,
              startedAt: row.started_at.toISOString(),
              endedAt: row.ended_at?.toISOString() ?? null,
              error: row.error,
              transcriptObjectId: row.transcript_object_id,
              summaryObjectId: row.summary_object_id,
            }),
          ),
        };
      },
    }),
  );
  registry.register(
    defineTool({
      id: "meet.transcription.set",
      description:
        "Start or stop live transcription as a meeting host. Requires administrator enablement and participant capture consent; stores the finished transcript in the owner's Drive and sends attendees private links.",
      permission: "meet.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(room.extend({ enabled: z.boolean() }), { type: "object" }),
      outputSchema: output,
      handler: async (input, ctx) => {
        if (
          !(await options.meetings.canModerateRoom?.({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            roomId: input.roomId,
          }))
        )
          throw new ForbiddenError("Only a meeting host can control transcription.");
        if (input.enabled && !(await options.enabled(ctx.actor.orgId)))
          throw new ForbiddenError(
            "An administrator must configure and enable Meet transcription first.",
          );
        await options.transcripts.setRequested(
          ctx.actor.orgId,
          input.roomId,
          ctx.actor.id,
          input.enabled,
        );
        return { requested: input.enabled };
      },
    }),
  );
  registry.register(
    defineTool({
      id: "meet.transcript.retry",
      description:
        "Retry failed transcript artifact processing and delivery. Existing completed files and delivery idempotency keys are preserved.",
      permission: "meet.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(room, { type: "object" }),
      outputSchema: output,
      handler: async (input, ctx) => {
        const meeting = await options.meetings.getRoomForActor({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
        });
        if (!meeting || meeting.createdByActorId !== ctx.actor.id)
          throw new ForbiddenError("Only the meeting owner can retry processing.");
        await options.transcripts.retry(ctx.actor.orgId, input.roomId);
        return { queued: true };
      },
    }),
  );
}
