import type { Actor, StandingAuthorization } from "@helix/sdk-types";
import type { ChatStore } from "./store.js";

export function chatConversationAuthorization(store: Pick<ChatStore, "getRoomForActor">) {
  return async (
    input: { readonly roomId: string; readonly attachmentObjectIds?: readonly string[] },
    actor: Actor,
  ): Promise<StandingAuthorization | null> => {
    if (actor.type !== "agent" || input.attachmentObjectIds?.length) return null;
    const room = await store.getRoomForActor({
      orgId: actor.orgId,
      actorId: actor.id,
      roomId: input.roomId,
    });
    // Joining a conversation authorizes ordinary messages, not new file sharing or membership changes.
    if (
      !room ||
      room.orgId !== actor.orgId ||
      !room.members.some((member) => member.actorId === actor.id)
    )
      return null;
    return {
      id: `chat-conversation:${room.id}`,
      version: "1",
      requestsPerMinute: 30,
      requestsPerDay: 2000,
    };
  };
}
