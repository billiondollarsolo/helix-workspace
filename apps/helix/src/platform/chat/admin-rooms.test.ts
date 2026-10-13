import type { ToolContext } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createChatAdminRoomTools, type ChatAdminRoomToolOptions } from "./admin-rooms.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const room = {
  id: "33333333-3333-4333-8333-333333333333",
  kind: "chat_room",
  name: "General",
  privacy: "discoverable",
  memberCount: 3,
  agentOnly: false,
  updatedAt: "2026-05-20T12:00:00.000Z",
} as const;

const context: ToolContext = {
  actor: { id: actorId, orgId, type: "user", scopes: ["admin.chat"] },
  can: async () => true,
  requirePermission: async () => {},
  audit: async () => {},
};

async function list(privateRoomsVisible: boolean, input: Record<string, unknown>) {
  const asked: unknown[] = [];
  const consulted: string[] = [];
  const store: ChatAdminRoomToolOptions["store"] = {
    list: async (request) => {
      asked.push(request);
      return { rooms: [room], hiddenPrivateCount: request.includePrivate ? 0 : 2 };
    },
  };
  const [tool] = createChatAdminRoomTools({
    store,
    adminsSeePrivateRooms: async (asking) => {
      consulted.push(asking);
      return privateRoomsVisible;
    },
  });
  if (tool === undefined) throw new Error("Expected the organization room list tool.");
  return {
    tool,
    output: await tool.handler(tool.inputSchema.parse(input), context),
    asked,
    consulted,
  };
}

describe("chat.room.list_organization", () => {
  it("is a read that only Chat administrators may run", async () => {
    const { tool } = await list(false, {});
    expect(tool).toMatchObject({
      id: "chat.room.list_organization",
      permission: "admin.chat",
      sideEffects: "read",
    });
    expect(tool.confirmationRequired).toBeUndefined();
  });

  it("leaves private and agent-only rooms out unless the organization and the caller ask", async () => {
    const closed = await list(false, {});
    expect(closed.consulted).toEqual([orgId]);
    expect(closed.asked).toEqual([
      expect.objectContaining({
        orgId,
        actorId,
        limit: 100,
        includePrivate: false,
        includeAgentOnly: false,
      }),
    ]);
    expect(closed.output).toEqual({
      rooms: [room],
      privateRoomsVisible: false,
      hiddenPrivateCount: 2,
    });

    const open = await list(true, { includeAgentOnly: true, query: "gen" });
    expect(open.asked).toEqual([
      expect.objectContaining({ query: "gen", includePrivate: true, includeAgentOnly: true }),
    ]);
    expect(open.output).toMatchObject({ privateRoomsVisible: true, hiddenPrivateCount: 0 });
  });
});
