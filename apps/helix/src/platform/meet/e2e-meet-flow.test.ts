import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { createToolRegistry } from "../tool-registry.js";
import { registerMeetTools } from "./tools.js";
import { InMemoryMeetStore } from "./store.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const participantActorId = "55555555-5555-4555-8555-555555555555";

describe("meet flow", () => {
  it("creates rooms, enforces room access, mints Jitsi JWTs, ends rooms, and attaches recordings against the platform store", async () => {
    const store = new InMemoryMeetStore();
    const registry = createToolRegistry();
    registerMeetTools(registry, {
      store,
      jwtSecret: "test-secret",
      jwtAppId: "helix",
      jwtIssuer: "helix",
    });
    const actor = userActor(["meet.read", "meet.write"]);

    const created = await registry.invoke<{ readonly id: string; readonly roomName: string }>(
      "meet.create-room",
      {
        subject: "Launch review",
        roomName: "Launch Review",
        jitsiDomain: "meet.helix.test",
        participantActorIds: [participantActorId],
      },
      { actor },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(created.error);
    }

    const token = await registry.invoke<{ readonly token: string; readonly joinUrl: string }>(
      "meet.mint-token",
      { roomId: created.output.id, moderator: true },
      { actor },
    );
    expect(token.ok).toBe(true);
    if (!token.ok) {
      throw new Error(token.error);
    }

    await expect(
      store.getRoomForActor({
        orgId,
        actorId: "99999999-9999-4999-8999-999999999999",
        roomId: created.output.id,
      }),
    ).resolves.toBeNull();
    await expect(
      store.getRoomForActor({
        orgId,
        actorId: participantActorId,
        roomId: created.output.id,
      }),
    ).resolves.toMatchObject({ id: created.output.id });

    const recording = await store.attachRecording({
      orgId,
      roomName: created.output.roomName,
      storageKey: "recordings/launch-review.mp4",
      byteSize: 42,
      metadata: { source: "jitsi" },
    });
    const roomsWithRecording = await registry.invoke<{
      readonly rooms: readonly {
        readonly id: string;
        readonly recordingArtifacts: readonly {
          readonly storageKey: string;
          readonly byteSize: number;
        }[];
      }[];
    }>("meet.room.list", { limit: 10 }, { actor });
    const ended = await registry.invoke<{
      readonly status: string;
      readonly endedAt: string | null;
    }>("meet.end-room", { roomId: created.output.id }, { actor });

    const stored = await store.getRoomForActor({ orgId, actorId, roomId: created.output.id });
    expect(stored).toMatchObject({
      orgId,
      subject: "Launch review",
      roomName: "launch-review",
      jitsiDomain: "meet.helix.test",
    });
    expect(created.output.roomName).toBe("launch-review");
    expect(token.output.token.split(".")).toHaveLength(3);
    expect(token.output.joinUrl).toContain("https://meet.helix.test/launch-review?jwt=");
    expect(recording).toMatchObject({
      roomId: created.output.id,
      threadId: stored?.threadId,
      storageKey: "recordings/launch-review.mp4",
    });
    expect(roomsWithRecording.ok ? roomsWithRecording.output.rooms : []).toEqual([
      expect.objectContaining({
        id: created.output.id,
        recordingArtifacts: [
          expect.objectContaining({
            storageKey: "recordings/launch-review.mp4",
            byteSize: 42,
          }),
        ],
      }),
    ]);
    expect(ended.ok ? ended.output.status : undefined).toBe("ended");
    expect(ended.ok ? ended.output.endedAt : undefined).toEqual(expect.any(String));
  });

  it("lists only Meet rooms visible to the actor with optional status and limit filters", async () => {
    const store = new InMemoryMeetStore();
    const registry = createToolRegistry();
    registerMeetTools(registry, {
      store,
      jwtSecret: "test-secret",
    });
    const actor = userActor(["meet.read"]);
    const activeRoom = await store.createRoom({
      orgId,
      actorId,
      subject: "Active room",
      jitsiDomain: "meet.helix.test",
    });
    const endedRoom = await store.createRoom({
      orgId,
      actorId,
      subject: "Ended room",
      jitsiDomain: "meet.helix.test",
    });
    await store.endRoom({ orgId, actorId, roomId: endedRoom.id });
    const hiddenRoom = await store.createRoom({
      orgId,
      actorId: participantActorId,
      subject: "Hidden room",
      jitsiDomain: "meet.helix.test",
    });

    const activeList = await registry.invoke<{
      readonly rooms: readonly { readonly id: string; readonly status: string }[];
    }>("meet.room.list", { status: "active", limit: 10 }, { actor });
    const limitedList = await registry.invoke<{
      readonly rooms: readonly { readonly id: string }[];
    }>("meet.room.list", { limit: 1 }, { actor });

    expect(activeList.ok).toBe(true);
    expect(activeList.ok ? activeList.output.rooms : []).toEqual([
      expect.objectContaining({ id: activeRoom.id, status: "active" }),
    ]);
    expect(activeList.ok ? activeList.output.rooms.map((room) => room.id) : []).not.toContain(
      hiddenRoom.id,
    );
    expect(limitedList.ok ? limitedList.output.rooms : []).toHaveLength(1);
    expect(limitedList.ok ? limitedList.output.rooms.map((room) => room.id) : []).not.toContain(
      hiddenRoom.id,
    );
  });
});

function userActor(scopes: readonly string[]): Actor {
  return {
    id: actorId,
    orgId,
    type: "user",
    email: "ada@example.com",
    displayName: "Ada Lovelace",
    scopes,
  };
}
