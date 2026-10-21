/* Host tools for the Meet lobby: see who is waiting, let them in or turn them
   away, and allow or block guests for the meeting. */

import type { ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { MeetLobbyStore } from "./lobby-store.js";
import type { MeetStore } from "./store.js";

const roomSchema = z.object({ roomId: z.string().uuid() }).strict();
const decisionSchema = z
  .object({ roomId: z.string().uuid(), participantSubject: z.string().min(1).max(200) })
  .strict();
const guestsSchema = z.object({ roomId: z.string().uuid(), allowed: z.boolean() }).strict();
const objectSchema = { type: "object", additionalProperties: true } as const;

export interface MeetLobbyToolOptions {
  readonly store: MeetStore;
  readonly lobby?: MeetLobbyStore | undefined;
}

export function createMeetLobbyTools(options: MeetLobbyToolOptions): ToolDefinition[] {
  const lobby = () => {
    if (options.lobby === undefined) throw new Error("The meeting lobby is unavailable.");
    return options.lobby;
  };
  const requireModerator = async (orgId: string, actorId: string, roomId: string) => {
    if ((await options.store.canModerateRoom?.({ orgId, actorId, roomId })) !== true)
      throw new Error("Only a host or co-host can manage the lobby.");
  };
  return [
    defineTool<z.output<typeof roomSchema>, unknown>({
      id: "meet.lobby.list",
      description: "List guests waiting in the meeting lobby.",
      permission: "meet.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(roomSchema, objectSchema),
      outputSchema: zodToolSchema(z.unknown(), objectSchema),
      handler: async (input, ctx) => {
        await requireModerator(ctx.actor.orgId, ctx.actor.id, input.roomId);
        const waiting = await lobby().listWaiting({ orgId: ctx.actor.orgId, roomId: input.roomId });
        return {
          waiting: waiting.map((request) => ({
            ...request,
            requestedAt: request.requestedAt.toISOString(),
          })),
        };
      },
    }),
    defineTool<z.output<typeof decisionSchema>, unknown>({
      id: "meet.lobby.admit",
      description: "Let a waiting guest into the meeting.",
      permission: "meet.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(decisionSchema, objectSchema),
      outputSchema: zodToolSchema(z.unknown(), objectSchema),
      handler: async (input, ctx) => {
        const { orgId, id: actorId } = ctx.actor;
        // Admitting is a host control: it checks the moderator and bans, and is audited.
        const result = await options.store.applyControl?.({
          orgId,
          actorId,
          roomId: input.roomId,
          control: {
            action: "admit",
            participantSubject: input.participantSubject,
            mediaParticipantId: input.participantSubject,
          },
        });
        if (result === null || result === undefined)
          throw new Error("Only a host or co-host can let people in.");
        await lobby().decide({
          orgId,
          roomId: input.roomId,
          participantSubject: input.participantSubject,
          actorId,
          decision: "admitted",
        });
        return { admitted: true };
      },
    }),
    defineTool<z.output<typeof decisionSchema>, unknown>({
      id: "meet.lobby.deny",
      description: "Turn away a guest waiting in the meeting lobby.",
      permission: "meet.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(decisionSchema, objectSchema),
      outputSchema: zodToolSchema(z.unknown(), objectSchema),
      handler: async (input, ctx) => {
        await requireModerator(ctx.actor.orgId, ctx.actor.id, input.roomId);
        const denied = await lobby().decide({
          orgId: ctx.actor.orgId,
          roomId: input.roomId,
          participantSubject: input.participantSubject,
          actorId: ctx.actor.id,
          decision: "denied",
        });
        return { denied };
      },
    }),
    defineTool<z.output<typeof guestsSchema>, unknown>({
      id: "meet.guests.set-allowed",
      description:
        "Allow or block guests for a meeting. Blocking stops every guest invitation from working.",
      permission: "meet.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(guestsSchema, objectSchema),
      outputSchema: zodToolSchema(z.unknown(), objectSchema),
      handler: async (input, ctx) => {
        const changed = await lobby().setGuestsAllowed({
          orgId: ctx.actor.orgId,
          roomId: input.roomId,
          actorId: ctx.actor.id,
          allowed: input.allowed,
        });
        if (!changed) throw new Error("Only a host or co-host can change guest access.");
        return { allowed: input.allowed };
      },
    }),
  ];
}
