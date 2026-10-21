import type { Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { mintMeetGuestInviteToken } from "./guest-invites.js";
import type { LiveKitRooms } from "./livekit-rooms.js";
import { InMemoryMeetLobbyStore, LOBBY_PRESENCE_MS } from "./lobby-store.js";
import { MEET_LOBBY_TOPIC, registerMeetRoutes } from "./routes.js";
import { InMemoryMeetStore, type MeetMediaWebhookStore, type MeetStore } from "./store.js";
import { registerMeetTools } from "./tools.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const hostId = "11111111-1111-4111-8111-111111111111";
const inviteId = "77777777-7777-4777-8777-777777777777";
const guest = `guest:${inviteId}`;
const secret = "x".repeat(32);
const liveKit = {
  apiKey: "helix",
  apiSecret: "test-livekit-secret-with-32-plus-chars",
  publicUrl: "wss://meet.example.test",
  internalUrl: "http://livekit:7880",
};

function roomRow(overrides: { lobby_enabled?: boolean; admitted?: string[] } = {}) {
  return {
    lobby_enabled: overrides.lobby_enabled ?? true,
    host_actor_id: hostId,
    cohost_actor_ids: [],
    admitted_participant_subjects: overrides.admitted ?? [],
  };
}

async function guestApp() {
  const room = roomRow();
  const lobby = new InMemoryMeetLobbyStore(() => room);
  const sendData = vi.fn(async () => undefined);
  const rooms = { sendData } as unknown as LiveKitRooms;
  const expiresAt = new Date(Date.now() + 3_600_000);
  const store = {
    resolveGuestInvite: async () => ({
      invite: { id: inviteId, orgId, roomId, email: "guest@example.com", expiresAt },
      room: {
        id: roomId,
        orgId,
        roomName: "Launch",
        mediaDomain: "meet.example.test",
        lobbyEnabled: true,
      },
    }),
    authorizeJoin: async () => ({
      roomId,
      hostActorId: hostId,
      cohostActorIds: [],
      mutePolicy: "open",
      presenterPolicy: "everyone",
      chatPolicy: "everyone",
    }),
    recordGuestRecordingConsent: async () => true,
  } as unknown as MeetStore & MeetMediaWebhookStore;
  const app = fastify();
  await registerMeetRoutes(app, { store, liveKit, guestInviteSecret: secret, lobby, rooms });
  const token = mintMeetGuestInviteToken(secret, { inviteId, orgId, roomId, expiresAt });
  const join = () =>
    app.inject({
      method: "POST",
      url: "/api/meet/guest/join",
      payload: {
        token,
        email: "guest@example.com",
        name: "Visiting Vera",
        recordingNoticeAccepted: true,
        recordingNoticeVersion: "2026-10-15",
        deviceId: "99999999-9999-4999-8999-999999999999",
        joinGrantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });
  return { room, lobby, sendData, join };
}

describe("Meet lobby: guests", () => {
  it("keeps a guest waiting without a media token and tells the hosts once", async () => {
    const { lobby, sendData, join } = await guestApp();
    const first = await join();
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ waiting: true, retryAfterMs: 3_000 });
    expect(first.json()).not.toHaveProperty("token");
    await join();
    expect(sendData).toHaveBeenCalledTimes(1);
    expect(sendData).toHaveBeenCalledWith(orgId, roomId, {
      topic: MEET_LOBBY_TOPIC,
      payload: { type: "lobby.waiting" },
      to: [hostId],
    });
    await expect(lobby.listWaiting({ orgId, roomId })).resolves.toMatchObject([
      { participantSubject: guest, displayName: "Visiting Vera" },
    ]);
  });

  it("lets the guest in once a host admits them", async () => {
    const { room, join } = await guestApp();
    expect((await join()).statusCode).toBe(202);
    room.admitted_participant_subjects.push(guest);
    const admitted = await join();
    expect(admitted.statusCode).toBe(200);
    expect(admitted.json()).toMatchObject({ provider: "livekit", roomId });
  });

  it("turns away a guest a host denied, for good", async () => {
    const { lobby, join } = await guestApp();
    await join();
    await lobby.decide({
      orgId,
      roomId,
      participantSubject: guest,
      actorId: hostId,
      decision: "denied",
    });
    const denied = await join();
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ denied: true });
    await expect(lobby.listWaiting({ orgId, roomId })).resolves.toEqual([]);
  });

  it("lets guests straight in with the lobby off", async () => {
    const { room, join } = await guestApp();
    room.lobby_enabled = false;
    expect((await join()).statusCode).toBe(200);
  });
});

describe("Meet lobby: store rules", () => {
  it("never holds hosts, co-hosts or people already let in", async () => {
    const lobby = new InMemoryMeetLobbyStore(() => ({
      ...roomRow({ admitted: ["guest:back"] }),
      cohost_actor_ids: ["cohost"],
    }));
    for (const subject of [hostId, "cohost", "guest:back"])
      await expect(
        lobby.enter({ orgId, roomId, participantSubject: subject, displayName: "x" }),
      ).resolves.toEqual({ status: "proceed" });
  });

  it("drops guests who stopped checking in from the host's list", async () => {
    let now = 1_000_000;
    const lobby = new InMemoryMeetLobbyStore(
      () => roomRow(),
      () => now,
    );
    await lobby.enter({ orgId, roomId, participantSubject: guest, displayName: "Vera" });
    now += LOBBY_PRESENCE_MS + 1;
    await expect(lobby.listWaiting({ orgId, roomId })).resolves.toEqual([]);
  });
});

describe("Meet lobby: host tools", () => {
  async function setup() {
    const store = new InMemoryMeetStore();
    const room = await store.createRoom({
      orgId,
      actorId: hostId,
      subject: "Lobby room",
      mediaDomain: "meet.example.test",
      participantActorIds: ["55555555-5555-4555-8555-555555555555"],
    });
    const lobby = new InMemoryMeetLobbyStore(() => roomRow());
    await lobby.enter({ orgId, roomId: room.id, participantSubject: guest, displayName: "Vera" });
    const registry = createToolRegistry();
    registerMeetTools(registry, { store, lobby, liveKit, guestInviteSecret: secret });
    return { registry, lobby, roomId: room.id };
  }
  const actor = (id: string): Actor => ({
    id,
    orgId,
    type: "user",
    displayName: id,
    scopes: ["meet.read", "meet.write"],
  });

  it("shows hosts who is waiting and lets them admit or deny", async () => {
    const { registry, lobby, roomId: id } = await setup();
    await expect(
      registry.invoke("meet.lobby.list", { roomId: id }, { actor: actor(hostId) }),
    ).resolves.toMatchObject({
      ok: true,
      output: { waiting: [{ participantSubject: guest, displayName: "Vera" }] },
    });
    await expect(
      registry.invoke(
        "meet.lobby.admit",
        { roomId: id, participantSubject: guest },
        { actor: actor(hostId) },
      ),
    ).resolves.toMatchObject({ ok: true, output: { admitted: true } });
    expect(lobby.requests.get(`${id}:${guest}`)?.status).toBe("admitted");
    await expect(
      registry.invoke(
        "meet.guests.set-allowed",
        { roomId: id, allowed: true },
        { actor: actor(hostId) },
      ),
    ).resolves.toMatchObject({ ok: true, output: { allowed: true } });
  });

  it("keeps attendees out of the lobby controls", async () => {
    const { registry, roomId: id } = await setup();
    const attendee = actor("55555555-5555-4555-8555-555555555555");
    for (const [tool, input] of [
      ["meet.lobby.list", { roomId: id }],
      ["meet.lobby.admit", { roomId: id, participantSubject: guest }],
      ["meet.lobby.deny", { roomId: id, participantSubject: guest }],
      ["meet.guests.set-allowed", { roomId: id, allowed: true }],
    ] as const)
      await expect(registry.invoke(tool, input, { actor: attendee })).resolves.toMatchObject({
        ok: false,
      });
  });
});
