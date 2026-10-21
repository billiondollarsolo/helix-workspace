import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import type { LiveKitParticipantInfo, LiveKitRooms } from "./livekit-rooms.js";
import { InMemoryMeetStore } from "./store.js";
import { registerMeetTools } from "./tools.js";

const orgId = "a1000000-0000-4000-8000-000000000001";
const hostId = "a1000000-0000-4000-8000-000000000011";
const cohostId = "a1000000-0000-4000-8000-000000000012";
const attendeeId = "a1000000-0000-4000-8000-000000000013";

/** Records what host controls ask of LiveKit, with a fixed set of connected people. */
class FakeRooms implements LiveKitRooms {
  readonly calls: string[] = [];
  readonly updates = new Map<string, Parameters<LiveKitRooms["updateParticipant"]>[3]>();
  fail = false;
  constructor(readonly participants: LiveKitParticipantInfo[]) {}
  private record(call: string) {
    if (this.fail) throw new Error("LiveKit unreachable");
    this.calls.push(call);
  }
  async listParticipants() {
    this.record("list");
    return this.participants;
  }
  async removeParticipant(_org: string, _room: string, identity: string) {
    this.record(`remove ${identity}`);
  }
  async muteTrack(_org: string, _room: string, identity: string, trackSid: string) {
    this.record(`mute ${identity} ${trackSid}`);
  }
  async updateParticipant(
    _org: string,
    _room: string,
    identity: string,
    update: Parameters<LiveKitRooms["updateParticipant"]>[3],
  ) {
    this.record(`update ${identity}`);
    this.updates.set(identity, update);
  }
  async deleteRoom() {
    this.record("delete room");
  }
}

describe("Meet host controls", () => {
  it("rejects crafted attendee controls and safely transfers host authority", async () => {
    const { store, registry, roomId, rooms } = await setup();
    const attendee = actor(attendeeId);
    const host = actor(hostId);

    await expect(
      apply(registry, attendee, roomId, { action: "set_lock", locked: true }),
    ).resolves.toMatchObject({ ok: false });

    const promoted = await apply(registry, host, roomId, {
      action: "set_cohost",
      actorId: cohostId,
      mediaParticipantId: "media-cohost",
      enabled: true,
    });
    expect(promoted).toMatchObject({ ok: true, output: { callUpdated: true } });
    expect(rooms.updates.get(cohostId)?.attributes).toEqual({ helixRole: "host" });
    expect(rooms.updates.get(attendeeId)?.attributes).toEqual({ helixRole: "" });
    await expect(
      apply(registry, actor(cohostId), roomId, { action: "set_lobby", enabled: false }),
    ).resolves.toMatchObject({ ok: true });

    const transferred = await apply(registry, host, roomId, {
      action: "transfer_host",
      actorId: cohostId,
      mediaParticipantId: "media-cohost",
    });
    expect(transferred).toMatchObject({
      ok: true,
      output: { state: { hostActorId: cohostId, cohostActorIds: [hostId] } },
    });
    await expect(
      apply(registry, host, roomId, { action: "set_lock", locked: true }),
    ).resolves.toMatchObject({ ok: true });
    expect(store.controlEvents.map((event) => event.version)).toEqual([2, 3, 4, 5]);
  });

  it("enforces lock, ban, chat, mute, presenter, lobby admission, and signed features", async () => {
    const { store, registry, roomId, rooms } = await setup();
    const host = actor(hostId);
    const attendee = actor(attendeeId);

    await expect(
      apply(registry, host, roomId, { action: "set_lock", locked: true }),
    ).resolves.toMatchObject({ ok: true, output: { callUpdated: true } });
    // Lock is enforced when Helix issues tokens; nothing to do in the call.
    expect(rooms.calls).toEqual([]);
    await expect(
      mint(registry, attendee, roomId, "10000000-0000-4000-8000-000000000001"),
    ).resolves.toMatchObject({ ok: false });
    await apply(registry, host, roomId, { action: "set_lock", locked: false });
    await store.authorizeJoin({ orgId, roomId, participantSubject: attendeeId });
    await apply(registry, host, roomId, { action: "set_chat_policy", policy: "disabled" });
    await apply(registry, host, roomId, { action: "set_reaction_policy", policy: "hosts" });
    await apply(registry, host, roomId, { action: "set_mute_policy", policy: "moderated" });
    const presenter = await apply(registry, host, roomId, {
      action: "set_presenter",
      policy: "selected",
      participantSubject: attendeeId,
      mediaParticipantId: "media-attendee",
    });
    expect(presenter).toMatchObject({ ok: true, output: { callUpdated: true } });
    // Connected people get the new policy: chat off, only the host unmutes, only the
    // selected attendee presents.
    expect(rooms.updates.get(attendeeId)?.permission).toEqual({
      canSubscribe: true,
      canPublish: true,
      canPublishData: false,
      canPublishSources: ["camera", "screen_share", "screen_share_audio"],
      canUpdateMetadata: true,
    });
    expect(rooms.updates.get(hostId)?.permission.canPublishSources).toEqual([
      "camera",
      "microphone",
    ]);

    rooms.calls.length = 0;
    await expect(
      apply(registry, host, roomId, {
        action: "mute",
        participantSubject: attendeeId,
        mediaParticipantId: "spoofed-id",
        mediaType: "audio",
      }),
    ).resolves.toMatchObject({ ok: true, output: { callUpdated: true } });
    expect(rooms.calls).toEqual(["list", `mute ${attendeeId} TR_mic`]);

    const token = await mint(registry, attendee, roomId, "10000000-0000-4000-8000-000000000002");
    expect(token.ok).toBe(true);
    if (!token.ok) throw new Error(token.error);
    const payload = JSON.parse(
      Buffer.from(token.output.token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    expect(payload.video).toMatchObject({
      roomAdmin: false,
      canPublishData: false,
      canPublishSources: ["camera", "screen_share", "screen_share_audio"],
    });

    await expect(
      apply(registry, host, roomId, {
        action: "admit",
        participantSubject: attendeeId,
        mediaParticipantId: "lobby-attendee",
      }),
    ).resolves.toMatchObject({ ok: true, output: { callUpdated: true } });
    rooms.calls.length = 0;
    await expect(
      apply(registry, host, roomId, {
        action: "remove",
        participantSubject: attendeeId,
        mediaParticipantId: "media-attendee",
        ban: true,
      }),
    ).resolves.toMatchObject({ ok: true, output: { callUpdated: true } });
    // The authorized subject is removed, not the id the browser sent.
    expect(rooms.calls).toEqual([`remove ${attendeeId}`]);
    await expect(
      mint(registry, attendee, roomId, "10000000-0000-4000-8000-000000000003"),
    ).resolves.toMatchObject({ ok: false });
    expect(store.controlEvents.at(-1)?.control).toMatchObject({ action: "remove", ban: true });
  });

  it("keeps a recorded control when LiveKit is unreachable, and ends the call for everyone", async () => {
    const { registry, roomId, rooms } = await setup();
    rooms.fail = true;
    await expect(
      apply(registry, actor(hostId), roomId, { action: "set_chat_policy", policy: "hosts" }),
    ).resolves.toMatchObject({
      ok: true,
      output: { state: { chatPolicy: "hosts" }, callUpdated: false },
    });
    rooms.fail = false;
    await expect(
      registry.invoke("meet.end-room", { roomId }, { actor: actor(hostId) }),
    ).resolves.toMatchObject({ ok: true, output: { status: "ended", callEnded: true } });
    expect(rooms.calls).toEqual(["delete room"]);
  });
});

async function setup() {
  const store = new InMemoryMeetStore();
  const room = await store.createRoom({
    orgId,
    actorId: hostId,
    subject: "Control room",
    mediaDomain: "meet.example.test",
    participantActorIds: [cohostId, attendeeId],
  });
  const registry = createToolRegistry();
  const rooms = new FakeRooms([
    { identity: hostId, tracks: [{ sid: "TR_host_mic", source: "microphone" }] },
    { identity: cohostId, tracks: [] },
    {
      identity: attendeeId,
      tracks: [
        { sid: "TR_mic", source: "microphone" },
        { sid: "TR_cam", source: "camera" },
      ],
    },
  ]);
  registerMeetTools(registry, {
    store,
    rooms,
    liveKit: {
      apiKey: "helix",
      apiSecret: "test-livekit-secret-with-32-plus-chars",
      publicUrl: "wss://meet.example.test",
      internalUrl: "http://livekit:7880",
    },
    guestInviteSecret: "test-secret",
  });
  return { store, registry, roomId: room.id, rooms };
}

function actor(id: string): Actor {
  return { id, orgId, type: "user", displayName: id, scopes: ["meet.read", "meet.write"] };
}

function apply(
  registry: ReturnType<typeof createToolRegistry>,
  user: Actor,
  roomId: string,
  control: Record<string, unknown>,
) {
  return registry.invoke<{ readonly state: unknown; readonly callUpdated: boolean }>(
    "meet.host-controls.apply",
    { roomId, ...control },
    { actor: user },
  );
}

function mint(
  registry: ReturnType<typeof createToolRegistry>,
  user: Actor,
  roomId: string,
  joinGrantId: string,
) {
  return registry.invoke<{ readonly token: string }>(
    "meet.mint-token",
    {
      roomId,
      recordingNoticeAccepted: true,
      recordingNoticeVersion: "2026-10-15",
      deviceId: "20000000-0000-4000-8000-000000000001",
      joinGrantId,
    },
    { actor: user },
  );
}
