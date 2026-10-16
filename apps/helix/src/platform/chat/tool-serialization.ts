import type { ChatRoomRecord } from "./types.js";

export function serializeRoom(room: ChatRoomRecord) {
  return {
    id: room.id,
    orgId: room.orgId,
    kind: room.kind,
    subject: room.subject,
    createdByActorId: room.createdByActorId,
    metadata: room.metadata,
    members: room.members.map((m) => ({
      actorId: m.actorId,
      role: m.role,
      displayName: m.displayName,
      email: m.email,
    })),
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
    settings:
      room.settings === null
        ? null
        : {
            ...room.settings,
            createdAt: room.settings.createdAt.toISOString(),
            updatedAt: room.settings.updatedAt.toISOString(),
          },
  };
}
