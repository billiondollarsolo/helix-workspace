import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { createPlatformMetrics } from "../../api/metrics.js";
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
    const metrics = createPlatformMetrics();
    registerMeetTools(registry, {
      store,
      metrics,
      jwtSecret: "test-secret",
      jwtAppId: "helix",
      jwtIssuer: "helix",
      jitsiPublicUrl: "https://meet.helix.test",
      recordingAvailable: async () => true,
    });
    const actor = userActor(["meet.read", "meet.write"]);

    await expect(
      registry.invoke(
        "meet.create-room",
        { subject: "Spoofed deployment", jitsiDomain: "attacker.example" },
        { actor },
      ),
    ).resolves.toMatchObject({ ok: false });

    const created = await registry.invoke<{ readonly id: string; readonly roomName: string }>(
      "meet.create-room",
      {
        subject: "Launch review",
        roomName: "Launch Review",
        participantActorIds: [participantActorId],
      },
      { actor },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(created.error);
    }

    await expect(
      registry.invoke("meet.mint-token", { roomId: created.output.id }, { actor }),
    ).resolves.toMatchObject({ ok: false });

    const token = await registry.invoke<{
      readonly token: string;
      readonly joinUrl: string;
      readonly recordingAvailable: boolean;
    }>(
      "meet.mint-token",
      {
        roomId: created.output.id,
        recordingNoticeAccepted: true,
        recordingNoticeVersion: "2026-09-02",
        deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        joinGrantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
      { actor },
    );
    expect(token.ok).toBe(true);
    if (!token.ok) {
      throw new Error(token.error);
    }
    expect(jwtPayload(token.output.token).context.user.moderator).toBe(true);
    expect(token.output.recordingAvailable).toBe(true);

    await expect(
      registry.invoke(
        "meet.telemetry.record",
        {
          roomId: created.output.id,
          event: "quality",
          packetLossPercent: 12,
          jitterMs: 250,
          rttMs: 800,
          bitrateKbps: 50,
          bridgeLoadPercent: 95,
        },
        { actor },
      ),
    ).resolves.toMatchObject({ ok: true, output: { accepted: true } });
    await expect(
      registry.invoke(
        "meet.telemetry.record",
        { roomId: created.output.id, event: "quality", packetLossPercent: 101 },
        { actor },
      ),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      registry.invoke(
        "meet.telemetry.record",
        {
          roomId: created.output.id,
          event: "quality",
          packetLossPercent: 1,
          mediaContent: "must-not-be-accepted",
          token: "must-not-be-accepted",
        },
        { actor },
      ),
    ).resolves.toMatchObject({ ok: false });
    const telemetry = await metrics.registry.metrics();
    expect(telemetry).toContain('helix_meet_degraded_samples_total{signal="packet_loss"} 1');
    expect(telemetry).not.toContain(created.output.id);

    const participant = { ...userActor(["meet.read", "meet.write"]), id: participantActorId };
    const participantToken = await registry.invoke<{ readonly token: string }>(
      "meet.mint-token",
      {
        roomId: created.output.id,
        recordingNoticeAccepted: true,
        recordingNoticeVersion: "2026-09-02",
        deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        joinGrantId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      },
      { actor: participant },
    );
    expect(participantToken.ok).toBe(true);
    if (participantToken.ok) {
      expect(jwtPayload(participantToken.output.token).context.user.moderator).toBe(false);
    }
    await expect(
      registry.invoke(
        "meet.recording.authorize-start",
        { roomId: created.output.id },
        { actor },
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      registry.invoke("meet.end-room", { roomId: created.output.id }, { actor: participant }),
    ).resolves.toMatchObject({ ok: false });

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

  it("lists scheduled and recent meetings with host, attendees, join code, and recording refs", async () => {
    const store = new InMemoryMeetStore();
    store.registerActor(actorId, { displayName: "Ada Lovelace", email: "ada@example.com" });
    store.registerActor(participantActorId, { displayName: "Mira Okafor" });
    const registry = createToolRegistry();
    registerMeetTools(registry, { store, jwtSecret: "test-secret" });
    const actor = userActor(["meet.read", "meet.write"]);

    const scheduled = await store.createRoom({
      orgId,
      actorId,
      subject: "Q3 Roadmap working session",
      jitsiDomain: "meet.helix.test",
      participantActorIds: [participantActorId],
      status: "scheduled",
      scheduledStartAt: new Date("2026-05-22T10:00:00.000Z"),
      scheduledEndAt: new Date("2026-05-22T11:30:00.000Z"),
    });
    const recent = await store.createRoom({
      orgId,
      actorId,
      subject: "Eng standup",
      jitsiDomain: "meet.helix.test",
    });
    await store.attachRecording({
      orgId,
      roomId: recent.id,
      storageKey: "recordings/eng-standup.mp4",
      byteSize: 1024,
    });
    await store.attachSummary({
      orgId,
      roomId: recent.id,
      body: "Standup recap: shipped auth fix, blocked on staging cert.",
    });
    await store.endRoom({ orgId, actorId, roomId: recent.id });

    const listed = await registry.invoke<{
      readonly meetings: readonly { readonly id: string; readonly status: string }[];
      readonly scheduled: readonly {
        readonly id: string;
        readonly code: string;
        readonly attendeeCount: number;
        readonly durationSeconds: number | null;
        readonly host: { readonly displayName: string | null } | null;
      }[];
      readonly recent: readonly {
        readonly id: string;
        readonly recorded: boolean;
        readonly summaries: readonly { readonly body: string }[];
      }[];
    }>("meet.meetings.list", { limit: 20 }, { actor });

    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      throw new Error(listed.error);
    }
    expect(listed.output.scheduled).toHaveLength(1);
    expect(listed.output.scheduled[0]).toMatchObject({
      id: scheduled.id,
      attendeeCount: 2,
      durationSeconds: 5400,
    });
    expect(listed.output.scheduled[0]?.host?.displayName).toBe("Ada Lovelace");
    expect(listed.output.scheduled[0]?.code).toMatch(/^[a-z0-9-]+$/);
    expect(listed.output.recent).toEqual([
      expect.objectContaining({
        id: recent.id,
        recorded: true,
        summaries: [
          expect.objectContaining({
            body: "Standup recap: shipped auth fix, blocked on staging cert.",
          }),
        ],
      }),
    ]);
    // Scheduled meetings sort ahead of recent ones.
    expect(listed.output.meetings[0]?.id).toBe(scheduled.id);
  });

  it("creates a scheduled room via the create-room tool when a schedule window is given", async () => {
    const store = new InMemoryMeetStore();
    const registry = createToolRegistry();
    registerMeetTools(registry, { store, jwtSecret: "test-secret" });
    const actor = userActor(["meet.read", "meet.write"]);

    const created = await registry.invoke<{ readonly id: string; readonly status: string }>(
      "meet.create-room",
      {
        subject: "1:1 with Jonas",
        scheduledStartAt: "2026-05-22T15:00:00.000Z",
        scheduledEndAt: "2026-05-22T15:30:00.000Z",
      },
      { actor },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(created.error);
    }
    expect(created.output.status).toBe("scheduled");
    const stored = await store.getRoomForActor({ orgId, actorId, roomId: created.output.id });
    expect(stored?.scheduledStartAt?.toISOString()).toBe("2026-05-22T15:00:00.000Z");
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

function jwtPayload(token: string): {
  readonly context: { readonly user: { readonly moderator: boolean } };
} {
  const payload = token.split(".")[1];
  if (payload === undefined) throw new Error("JWT payload missing");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    readonly context: { readonly user: { readonly moderator: boolean } };
  };
}
