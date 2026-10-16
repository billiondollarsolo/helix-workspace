import { chatRoomSchema } from "@helix/contracts";
import { z } from "zod";
import { collaborationAuthorization } from "../tools/collaboration-authorization.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { ChatStore } from "./store.js";
import { serializeRoom } from "./tool-serialization.js";

export function createDirectMessageTool(store: ChatStore) {
  return defineTool<{ memberActorIds: string[] }, z.output<typeof chatRoomSchema>>({
    id: "chat.dm.open",
    description:
      "Open or reuse a direct conversation with workspace members. Uses chat.post; does not grant access to existing rooms.",
    permission: "chat.post",
    sideEffects: "write",
    standingAuthorization: collaborationAuthorization("chat.post"),
    inputSchema: zodToolSchema(
      z.object({ memberActorIds: z.array(z.string().uuid()).min(1).max(100) }).strict(),
      {
        type: "object",
        properties: {
          memberActorIds: {
            type: "array",
            items: { type: "string", format: "uuid" },
            minItems: 1,
            maxItems: 100,
          },
        },
        required: ["memberActorIds"],
        additionalProperties: false,
      },
    ),
    outputSchema: zodToolSchema(chatRoomSchema, { type: "object" }),
    handler: async (input, ctx) =>
      serializeRoom(
        await store.createRoom({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          kind: "chat_dm",
          memberActorIds: input.memberActorIds,
          externalAccess: "internal",
        }),
      ),
  });
}
