import type { JsonObject } from "@helix/sdk-types";
import fastify, { type FastifyInstance } from "fastify";
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPlatformMetrics, type PlatformMetrics } from "../../api/metrics.js";
import { MEET_WEBHOOK_BODY_LIMIT_BYTES } from "../../api/request-body.js";
import { mintMeetGuestInviteToken } from "./guest-invites.js";
import type { LiveKitOptions } from "./livekit.js";
import { registerMeetRoutes } from "./routes.js";
import type {
  AttachMeetRecordingInput,
  MeetMediaEventInput,
  MeetMediaEventResult,
  MeetMediaWebhookStore,
  MeetRecordingUploadRecord,
  MeetStore,
} from "./store.js";
import type {
  MeetControlState,
  MeetGuestInviteRecord,
  MeetMeetingRecord,
  MeetRecordingAttachmentRecord,
  MeetRoomRecord,
  MeetSummaryRef,
} from "./types.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const otherOrgId = "99999999-9999-4999-8999-999999999999";
const roomId = "33333333-3333-4333-8333-333333333333";
const threadId = "44444444-4444-4444-8444-444444444444";
const objectId = "55555555-5555-4555-8555-555555555555";
const messageId = "66666666-6666-4666-8666-666666666666";
const now = new Date("2026-05-20T12:00:00.000Z");
const liveKit: LiveKitOptions = {
  apiKey: "helix-test",
  apiSecret: "livekit-test-secret-with-at-least-32-characters",
  publicUrl: "wss://meet.example.com",
  internalUrl: "http://livekit:7880",
};
const roomName = `${orgId}.${roomId}`;

describe("Meet LiveKit webhook", () => {
  it("applies signed room and participant events", async () => {
    const store = new FakeMeetStore();
    const app = await createApp(store);
    const started = await injectLiveKit(app, {
      event: "room_started",
      id: "EV_start",
      createdAt: now.getTime() / 1000,
      room: { name: roomName, sid: "RM_1" },
    });
    const joined = await injectLiveKit(app, {
      event: "participant_joined",
      id: "EV_join",
      room: { name: roomName },
      participant: { sid: "PA_1", identity: "user-1" },
    });

    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      lifecycle: { roomId, status: "active", version: 1, duplicate: false },
    });
    expect(joined.statusCode).toBe(200);
    expect(store.lifecycleEvents).toEqual([
      expect.objectContaining({
        event: "conference.started",
        eventId: "livekit:EV_start",
        orgId,
        roomId,
      }),
      expect.objectContaining({
        event: "participant.joined",
        eventId: "livekit:EV_join",
        sessionId: "PA_1",
        participantId: "user-1",
      }),
    ]);
  });

  it("ignores events Meet does not track and participant events without a session", async () => {
    const store = new FakeMeetStore();
    const app = await createApp(store);
    const track = await injectLiveKit(app, {
      event: "track_published",
      id: "EV_track",
      room: { name: roomName },
    });
    const noSession = await injectLiveKit(app, {
      event: "participant_joined",
      id: "EV_nosession",
      room: { name: roomName },
    });
    const foreignRoom = await injectLiveKit(app, {
      event: "room_started",
      id: "EV_foreign",
      room: { name: "not-a-helix-room" },
    });
    for (const response of [track, noSession, foreignRoom]) {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ignored: true });
    }
    expect(store.lifecycleEvents).toEqual([]);
  });

  it("ignores events for a room that does not exist, without asking LiveKit to retry", async () => {
    const app = await createApp(new FakeMeetStore());
    const response = await injectLiveKit(app, {
      event: "room_started",
      id: "EV_other_org",
      room: { name: `${otherOrgId}.${roomId}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ignored: true });
  });

  it("records participant duration and bridge load from signed events", async () => {
    const metrics = createPlatformMetrics();
    const app = await createApp(new FakeMeetStore(), { metrics });
    const participant = (event: string, id: string, sid: string) =>
      injectLiveKit(app, {
        event,
        id,
        room: { name: roomName },
        participant: { sid, identity: "user-1" },
      });
    await participant("participant_joined", "quality-join", "PA_1");
    await participant("participant_left", "quality-left", "PA_1");
    await participant("participant_joined", "quality-rejoin", "PA_2");

    const output = await metrics.registry.metrics();
    expect(output).toContain('helix_meet_participant_events_total{event="joined",device="none"} 2');
    expect(output).toContain('helix_meet_participant_events_total{event="left",device="none"} 1');
    expect(output).toContain(
      'helix_meet_participant_events_total{event="reconnected",device="none"} 1',
    );
    expect(output).toContain("helix_meet_call_duration_seconds_sum 10");
    expect(output).toContain("helix_meet_bridge_participant_load_count 3");
  });

  it("rejects missing, wrong-key, expired and body-tampered signatures before state changes", async () => {
    const store = new FakeMeetStore();
    const app = await createApp(store);
    const body = JSON.stringify({ event: "room_started", id: "EV_sig", room: { name: roomName } });
    const post = (authorization: string | undefined, payload = body) =>
      app.inject({
        method: "POST",
        url: "/webhook/livekit",
        headers: {
          "content-type": "application/webhook+json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        payload,
      });

    const responses = await Promise.all([
      post(undefined),
      post(liveKitAuthorization(body, { secret: `${liveKit.apiSecret}-wrong` })),
      post(liveKitAuthorization(body, { apiKey: "someone-else" })),
      post(liveKitAuthorization(body, { exp: now.getTime() / 1000 - 120 })),
      post(liveKitAuthorization(body), body.replace("EV_sig", "EV_forged")),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([401, 401, 401, 401, 401]);
    expect(store.lifecycleEvents).toEqual([]);
    expect(store.receipts.size).toBe(0);
  });

  it("durably rejects an exact signed-request replay", async () => {
    const store = new FakeMeetStore();
    const app = await createApp(store);
    const payload = JSON.stringify({
      event: "room_started",
      id: "EV_replay",
      room: { name: roomName },
    });
    const request = {
      method: "POST" as const,
      url: "/webhook/livekit",
      headers: {
        "content-type": "application/webhook+json",
        authorization: liveKitAuthorization(payload),
      },
      payload,
    };

    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(409);
    expect(store.lifecycleEvents).toHaveLength(1);
  });

  it("rejects caller-supplied tenant headers and oversized bodies", async () => {
    const store = new FakeMeetStore();
    const app = await createApp(store);
    const tenantHeader = await injectLiveKit(
      app,
      { event: "room_started", id: "EV_tenant", room: { name: roomName } },
      { "x-helix-org-id": otherOrgId },
    );
    const oversized = "x".repeat(MEET_WEBHOOK_BODY_LIMIT_BYTES + 1);
    const tooLarge = await app.inject({
      method: "POST",
      url: "/webhook/livekit",
      headers: {
        "content-type": "application/webhook+json",
        authorization: liveKitAuthorization(oversized),
      },
      payload: oversized,
    });

    expect(tenantHeader.statusCode).toBe(400);
    expect(tooLarge.statusCode).toBe(413);
    expect(store.lifecycleEvents).toEqual([]);
  });
});

describe("Meet guest join", () => {
  it("mints a bounded non-moderator join only for a resolved signed guest invite", async () => {
    const store = new FakeMeetStore();
    const invite: MeetGuestInviteRecord = {
      id: "77777777-7777-4777-8777-777777777777",
      orgId,
      roomId,
      email: "guest@example.com",
      expiresAt: new Date(now.getTime() + 3_600_000),
      revokedAt: null,
      createdByActorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      createdAt: now,
    };
    store.guestResolution = { invite, room: meetRoomRecord() };
    const token = mintMeetGuestInviteToken("x".repeat(32), {
      inviteId: invite.id,
      orgId,
      roomId,
      expiresAt: invite.expiresAt,
    });
    const app = await createApp(store);
    const undisclosed = await app.inject({
      method: "POST",
      url: "/api/meet/guest/join",
      payload: { token, email: invite.email, name: "Guest" },
    });
    expect(undisclosed.statusCode).toBe(400);
    const joined = await app.inject({
      method: "POST",
      url: "/api/meet/guest/join",
      payload: {
        token,
        email: invite.email,
        name: "Guest",
        recordingNoticeAccepted: true,
        recordingNoticeVersion: "2026-10-15",
        deviceId: "99999999-9999-4999-8999-999999999999",
        joinGrantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });
    expect(joined.statusCode).toBe(200);
    expect(store.guestConsents).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    expect(joined.json()).toMatchObject({ roomId, lobbyRequired: true });
    expect(joined.json()).toMatchObject({
      provider: "livekit",
      serverUrl: liveKit.publicUrl,
      mediaDomain: "meet.example.com",
    });
    const claims = JSON.parse(
      Buffer.from(String(joined.json().token).split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as {
      readonly iss: string;
      readonly video: { readonly room: string; readonly roomAdmin: boolean };
      readonly attributes: Record<string, string>;
    };
    expect(claims.iss).toBe(liveKit.apiKey);
    expect(claims.video).toMatchObject({ room: `${orgId}.${roomId}`, roomAdmin: false });
    expect(claims.attributes.helixRole).toBeUndefined();

    store.guestResolution = null;
    const revoked = await app.inject({
      method: "POST",
      url: "/api/meet/guest/join",
      payload: {
        token,
        email: invite.email,
        name: "Guest",
        recordingNoticeAccepted: true,
        recordingNoticeVersion: "2026-10-15",
        deviceId: "99999999-9999-4999-8999-999999999999",
        joinGrantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    });
    expect(revoked.statusCode).toBe(404);
  });

  it("refuses to register without a guest invite secret", async () => {
    await expect(
      registerMeetRoutes(fastify(), { store: new FakeMeetStore(), liveKit, guestInviteSecret: "" }),
    ).rejects.toThrow("Meet guest invite secret is required.");
  });
});

async function createApp(
  store: FakeMeetStore,
  options: { readonly metrics?: PlatformMetrics } = {},
): Promise<FastifyInstance> {
  const app = fastify();
  await registerMeetRoutes(app, {
    store,
    liveKit,
    guestInviteSecret: "x".repeat(32),
    now: () => now,
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
  });
  return app;
}

/** Signs a body the way the LiveKit server does. */
function liveKitAuthorization(
  body: string,
  overrides: { readonly secret?: string; readonly apiKey?: string; readonly exp?: number } = {},
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: overrides.apiKey ?? liveKit.apiKey,
    nbf: issuedAt - 5,
    exp: overrides.exp ?? issuedAt + 300,
    sha256: createHash("sha256").update(body).digest("base64"),
  });
  const signature = createHmac("sha256", overrides.secret ?? liveKit.apiSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function injectLiveKit(
  app: FastifyInstance,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  const payload = JSON.stringify(body);
  return app.inject({
    method: "POST",
    url: "/webhook/livekit",
    headers: {
      "content-type": "application/webhook+json",
      authorization: liveKitAuthorization(payload),
      ...extraHeaders,
    },
    payload,
  });
}

class FakeMeetStore implements MeetStore, MeetMediaWebhookStore {
  readonly attachments: AttachMeetRecordingInput[] = [];
  readonly uploads = new Map<string, MeetRecordingUploadRecord>();
  readonly receipts = new Set<string>();
  readonly lifecycleEvents: MeetMediaEventInput[] = [];
  readonly validations: JsonObject[] = [];
  readonly guestConsents: string[] = [];
  recordingStartAuthorized = true;
  guestResolution: {
    readonly invite: MeetGuestInviteRecord;
    readonly room: MeetRoomRecord;
  } | null = null;

  async claimMediaWebhook(input: { readonly id: string }): Promise<boolean> {
    if (this.receipts.has(input.id)) {
      return false;
    }
    this.receipts.add(input.id);
    return true;
  }

  async prepareRecordingUpload(
    input: Omit<MeetRecordingUploadRecord, "roomName" | "completedAt">,
  ): Promise<boolean> {
    if (input.orgId !== orgId || input.roomId !== roomId || this.uploads.has(input.id)) {
      return false;
    }
    this.uploads.set(input.id, { ...input, roomName: "Launch Review", completedAt: null });
    return true;
  }

  async getRecordingUpload(id: string): Promise<MeetRecordingUploadRecord | null> {
    return this.uploads.get(id) ?? null;
  }

  async completeRecordingUpload(id: string): Promise<boolean> {
    const upload = this.uploads.get(id);
    if (upload === undefined || upload.completedAt !== null || upload.expiresAt <= now) {
      return false;
    }
    this.uploads.set(id, { ...upload, completedAt: now });
    return true;
  }

  async markRecordingUploadReady(id: string, validation: JsonObject): Promise<boolean> {
    const upload = this.uploads.get(id);
    if (upload === undefined || upload.completedAt !== null || upload.expiresAt <= now)
      return false;
    this.validations.push(validation);
    return true;
  }

  async applyMediaEvent(input: MeetMediaEventInput): Promise<MeetMediaEventResult | null> {
    if (input.orgId !== orgId || input.roomId !== roomId) return null;
    this.lifecycleEvents.push(input);
    return {
      roomId,
      status: input.event === "conference.ended" ? "ended" : "active",
      version: this.lifecycleEvents.length,
      activeParticipantCount: input.event === "participant.joined" ? 1 : 0,
      ...(input.event === "participant.left" ? { participantDurationSeconds: 10 } : {}),
      ...(input.eventId === "livekit:quality-rejoin" ? { reconnected: true } : {}),
      duplicate: false,
    };
  }

  async expireEmptyRooms(): Promise<number> {
    return 0;
  }

  async createRoom(): Promise<MeetRoomRecord> {
    throw new Error("Not implemented for route tests.");
  }

  async listRoomsForActor(): Promise<readonly MeetRoomRecord[]> {
    throw new Error("Not implemented for route tests.");
  }

  async listMeetingsForActor(): Promise<readonly MeetMeetingRecord[]> {
    throw new Error("Not implemented for route tests.");
  }

  async getRoomForActor(): Promise<MeetRoomRecord | null> {
    throw new Error("Not implemented for route tests.");
  }

  async getRoomForActorByCode(): Promise<MeetRoomRecord | null> {
    return null;
  }

  async createGuestInvite(): Promise<null> {
    return null;
  }

  async revokeGuestInvite(): Promise<boolean> {
    return false;
  }

  async resolveGuestInvite(): Promise<{
    readonly invite: MeetGuestInviteRecord;
    readonly room: MeetRoomRecord;
  } | null> {
    return this.guestResolution;
  }

  async recordMemberRecordingConsent(): Promise<boolean> {
    return false;
  }

  async recordGuestRecordingConsent(input: { readonly joinGrantId: string }): Promise<boolean> {
    this.guestConsents.push(input.joinGrantId);
    return true;
  }

  async authorizeJoin(): Promise<MeetControlState> {
    return {
      roomId,
      hostActorId: null,
      cohostActorIds: [],
      lobbyEnabled: true,
      locked: false,
      mutePolicy: "open",
      presenterPolicy: "everyone",
      presenterSubject: null,
      chatPolicy: "everyone",
      reactionPolicy: "everyone",
      version: 1,
    };
  }

  async authorizeRecordingStart(): Promise<null> {
    return null;
  }

  async claimRecordingStartAuthorization(): Promise<boolean> {
    return this.recordingStartAuthorized;
  }

  async claimRecordingUploadAuthorization(): Promise<boolean> {
    return this.recordingStartAuthorized;
  }

  async getRoomById(input: {
    readonly orgId: string;
    readonly roomId: string;
  }): Promise<MeetRoomRecord | null> {
    return input.orgId === orgId && input.roomId === roomId ? meetRoomRecord() : null;
  }

  async getRoomByName(input: {
    readonly orgId: string;
    readonly roomName: string;
  }): Promise<MeetRoomRecord | null> {
    return input.orgId === orgId && input.roomName === "Launch Review" ? meetRoomRecord() : null;
  }

  async endRoom(): Promise<MeetRoomRecord | null> {
    throw new Error("Not implemented for route tests.");
  }

  async attachRecording(
    input: AttachMeetRecordingInput,
  ): Promise<MeetRecordingAttachmentRecord | null> {
    this.attachments.push(input);
    return { roomId, threadId, objectId, messageId, storageKey: input.storageKey };
  }

  async attachSummary(): Promise<MeetSummaryRef | null> {
    throw new Error("Not implemented for route tests.");
  }
}

function meetRoomRecord(): MeetRoomRecord {
  return {
    id: roomId,
    orgId,
    threadId,
    roomName: "Launch Review",
    joinCode: "abcd-ef01-2345",
    subject: "Launch Review",
    mediaDomain: "meet.example.com",
    status: "active",
    guestPolicy: "disabled",
    guestDomains: [],
    lobbyEnabled: true,
    createdByActorId: null,
    startedAt: now,
    endedAt: null,
    scheduledStartAt: null,
    scheduledEndAt: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}
