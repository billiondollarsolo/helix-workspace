import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { InMemoryMeetStore } from "./store.js";
import { registerMeetTools } from "./tools.js";

const orgId = "a1000000-0000-4000-8000-000000000001";
const hostId = "a1000000-0000-4000-8000-000000000011";
const cohostId = "a1000000-0000-4000-8000-000000000012";
const attendeeId = "a1000000-0000-4000-8000-000000000013";

describe("Meet host controls", () => {
  it("rejects crafted attendee controls and safely transfers host authority", async () => {
    const { store, registry, roomId } = await setup();
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
    expect(promoted).toMatchObject({
      ok: true,
      output: { mediaCommands: [{ command: "grantModerator", participantId: "media-cohost" }] },
    });
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
    const { store, registry, roomId } = await setup();
    const host = actor(hostId);
    const attendee = actor(attendeeId);

    await expect(
      apply(registry, host, roomId, { action: "set_lock", locked: true }),
    ).resolves.toMatchObject({ ok: true, output: { mediaCommands: [{ command: "password" }] } });
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
    expect(presenter).toMatchObject({
      ok: true,
      output: {
        mediaCommands: [
          { command: "toggleModeration", mediaType: "desktop", enabled: true },
          { command: "approveParticipant", mediaType: "desktop", participantId: "media-attendee" },
        ],
      },
    });

    const token = await mint(registry, attendee, roomId, "10000000-0000-4000-8000-000000000002");
    expect(token.ok).toBe(true);
    if (!token.ok) throw new Error(token.error);
    const payload = JSON.parse(
      Buffer.from(token.output.token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    expect(payload.context).toMatchObject({
      user: { moderator: false },
      features: { "send-groupchat": false, "send-reactions": false, "screen-sharing": true },
    });

    await expect(
      apply(registry, host, roomId, {
        action: "admit",
        participantSubject: attendeeId,
        mediaParticipantId: "lobby-attendee",
      }),
    ).resolves.toMatchObject({
      ok: true,
      output: { mediaCommands: [{ command: "answerKnockingParticipant", approved: true }] },
    });
    await expect(
      apply(registry, host, roomId, {
        action: "remove",
        participantSubject: attendeeId,
        mediaParticipantId: "media-attendee",
        ban: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      output: { mediaCommands: [{ command: "kickParticipant" }] },
    });
    await expect(
      mint(registry, attendee, roomId, "10000000-0000-4000-8000-000000000003"),
    ).resolves.toMatchObject({ ok: false });
    expect(store.controlEvents.at(-1)?.control).toMatchObject({ action: "remove", ban: true });
  });
});

async function setup() {
  const store = new InMemoryMeetStore();
  const room = await store.createRoom({
    orgId,
    actorId: hostId,
    subject: "Control room",
    jitsiDomain: "meet.example.test",
    participantActorIds: [cohostId, attendeeId],
  });
  const registry = createToolRegistry();
  registerMeetTools(registry, {
    store,
    jwtSecret: "test-secret",
    jitsiPublicUrl: "https://meet.example.test",
  });
  return { store, registry, roomId: room.id };
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
  return registry.invoke<{ readonly state: unknown; readonly mediaCommands: readonly unknown[] }>(
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
      recordingNoticeVersion: "2026-09-02",
      deviceId: "20000000-0000-4000-8000-000000000001",
      joinGrantId,
    },
    { actor: user },
  );
}
