import { describe, expect, it, vi } from "vitest";
import { createMeetRoom, endMeetRoom, listMeetRooms, mintMeetToken } from "./api";

const room = {
  id: "33333333-3333-4333-8333-333333333333",
  orgId: "22222222-2222-4222-8222-222222222222",
  threadId: "44444444-4444-4444-8444-444444444444",
  roomName: "launch-review",
  subject: "Launch review",
  jitsiDomain: "meet.helix.test",
  status: "active" as const,
  createdByActorId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-05-20T12:00:00.000Z",
  endedAt: null,
  metadata: {},
  createdAt: "2026-05-20T12:00:00.000Z",
  updatedAt: "2026-05-20T12:00:00.000Z",
};

describe("meet API", () => {
  it("creates rooms through the meet.create-room tool", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json(room)));

    await expect(
      createMeetRoom(
        {
          subject: "Launch review",
          roomName: "launch-review",
          jitsiDomain: "meet.helix.test",
        },
        fetchImpl,
      ),
    ).resolves.toEqual(room);
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/meet.create-room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: "Launch review",
        roomName: "launch-review",
        jitsiDomain: "meet.helix.test",
        participantActorIds: [],
        metadata: {},
      }),
    });
  });

  it("mints tokens and ends rooms through backend tools", async () => {
    const token = {
      roomId: room.id,
      roomName: room.roomName,
      jitsiDomain: room.jitsiDomain,
      token: "jwt",
      joinUrl: "https://meet.helix.test/launch-review?jwt=jwt",
      expiresAt: "2026-05-20T13:00:00.000Z",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(token))
      .mockResolvedValueOnce(Response.json({ ...room, status: "ended", endedAt: token.expiresAt }));

    await expect(mintMeetToken({ roomId: room.id, moderator: true }, fetchImpl)).resolves.toEqual(
      token,
    );
    await expect(endMeetRoom(room.id, fetchImpl)).resolves.toMatchObject({ status: "ended" });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/meet.mint-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: room.id, expiresInSeconds: 3600, moderator: true }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/meet.end-room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: room.id }),
    });
  });

  it("lists rooms through the meet.room.list tool", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ rooms: [room] })));

    await expect(listMeetRooms({ status: "active", limit: 25 }, fetchImpl)).resolves.toEqual([
      room,
    ]);
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/meet.room.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active", limit: 25 }),
    });
  });

  it("surfaces backend tool errors", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ error: "missing meet scope" }, { status: 403 })),
    );

    await expect(createMeetRoom({ subject: "Launch" }, fetchImpl)).rejects.toThrow(
      "missing meet scope",
    );
  });
});
