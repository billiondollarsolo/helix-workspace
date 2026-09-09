import { createHash } from "node:crypto";
import fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { JsonObject, StorageObject } from "@helix/sdk-types";
import { createPlatformMetrics, type PlatformMetrics } from "../../api/metrics.js";
import { MEET_WEBHOOK_BODY_LIMIT_BYTES } from "../../api/request-body.js";
import type { TenantStorageClient } from "../storage/tenant-resolver.js";
import { signWebhookPayload } from "../webhooks/signatures.js";
import { mintMeetGuestInviteToken } from "./guest-invites.js";
import { registerMeetRoutes, type MeetRecordingScanner } from "./routes.js";
import type {
  AttachMeetRecordingInput,
  MeetMediaEventInput,
  MeetMediaEventResult,
  MeetMediaWebhookStore,
  MeetRecordingUploadRecord,
  MeetStore,
} from "./store.js";
import type {
  MeetMeetingRecord,
  MeetGuestInviteRecord,
  MeetControlState,
  MeetRecordingAttachmentRecord,
  MeetRoomRecord,
  MeetSummaryRef,
} from "./types.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const otherOrgId = "99999999-9999-4999-8999-999999999999";
const roomId = "33333333-3333-4333-8333-333333333333";
const otherRoomId = "88888888-8888-4888-8888-888888888888";
const threadId = "44444444-4444-4444-8444-444444444444";
const objectId = "55555555-5555-4555-8555-555555555555";
const messageId = "66666666-6666-4666-8666-666666666666";
const now = new Date("2026-05-20T12:00:00.000Z");
const webhookSecret = "meet-test-webhook-secret-with-at-least-32-characters";
const validWebmBytes = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01,
]);
const validWebmSha256 = createHash("sha256").update(validWebmBytes).digest("hex");

describe("Meet media webhook routes", () => {
  it("applies signed lifecycle events and requires participant session identity", async () => {
    const store = new FakeMeetStore();
    const app = await createApp(store, new RecordingStorageClient());
    const started = await injectSigned(app, "/webhook/jitsi", {
      event: "conference.started",
      eventId: "conference-start-1",
      orgId,
      roomId,
      roomName: "Launch Review",
      occurredAt: now.toISOString(),
    });
    const missingSession = await injectSigned(
      app,
      "/webhook/jitsi",
      {
        event: "participant.joined",
        eventId: "participant-join-1",
        orgId,
        roomId,
        occurredAt: now.toISOString(),
      },
      new Date(now.getTime() + 1_000),
    );

    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      lifecycle: { roomId, status: "active", version: 1, duplicate: false },
    });
    expect(store.lifecycleEvents).toHaveLength(1);
    expect(missingSession.statusCode).toBe(400);
  });

  it("records participant duration and bridge load only from signed media lifecycle events", async () => {
    const metrics = createPlatformMetrics();
    const app = await createApp(new FakeMeetStore(), new RecordingStorageClient(), [], { metrics });
    await injectSigned(app, "/webhook/jitsi", {
      event: "participant.joined",
      eventId: "quality-join",
      orgId,
      roomId,
      sessionId: "quality-session",
      occurredAt: now.toISOString(),
    });
    await injectSigned(
      app,
      "/webhook/jitsi",
      {
        event: "participant.left",
        eventId: "quality-left",
        orgId,
        roomId,
        sessionId: "quality-session",
        occurredAt: new Date(now.getTime() + 10_000).toISOString(),
      },
      new Date(now.getTime() + 1_000),
    );
    await injectSigned(
      app,
      "/webhook/jitsi",
      {
        event: "participant.joined",
        eventId: "quality-rejoin",
        orgId,
        roomId,
        sessionId: "quality-session-2",
        occurredAt: new Date(now.getTime() + 20_000).toISOString(),
      },
      new Date(now.getTime() + 2_000),
    );

    const output = await metrics.registry.metrics();
    expect(output).toContain('helix_meet_participant_events_total{event="joined",device="none"} 2');
    expect(output).toContain('helix_meet_participant_events_total{event="left",device="none"} 1');
    expect(output).toContain(
      'helix_meet_participant_events_total{event="reconnected",device="none"} 1',
    );
    expect(output).toContain("helix_meet_call_duration_seconds_sum 10");
    expect(output).toContain("helix_meet_bridge_participant_load_count 3");
  });

  it("rejects hidden recording starts and accepts a consent-authorized recording lifecycle", async () => {
    const store = new FakeMeetStore();
    store.recordingStartAuthorized = false;
    const app = await createApp(store, new RecordingStorageClient());
    const body = {
      event: "recording.started",
      eventId: "recording-start-1",
      orgId,
      roomId,
      occurredAt: now.toISOString(),
    };

    const denied = await injectSigned(app, "/webhook/jitsi", body);
    store.recordingStartAuthorized = true;
    const accepted = await injectSigned(
      app,
      "/webhook/jitsi",
      { ...body, eventId: "recording-start-2" },
      new Date(now.getTime() + 1_000),
    );

    expect(denied.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(200);
    expect(store.lifecycleEvents).toEqual([
      expect.objectContaining({ event: "recording.started", eventId: "recording-start-2" }),
    ]);
  });

  it("rejects an oversized signed body before claiming or changing state", async () => {
    const store = new FakeMeetStore();
    const app = await createApp(store, new RecordingStorageClient());

    const response = await app.inject({
      method: "POST",
      url: "/webhook/jitsi",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(MEET_WEBHOOK_BODY_LIMIT_BYTES) }),
    });

    expect(response.statusCode).toBe(413);
    expect(store.receipts.size).toBe(0);
    expect(store.attachments).toEqual([]);
  });

  it("derives the recording tenant and room exclusively from signed prepared state", async () => {
    const store = new FakeMeetStore();
    const storage = new RecordingStorageClient();
    const resolvedOrgIds: string[] = [];
    const app = await createApp(store, storage, resolvedOrgIds);

    const prepared = await injectSigned(app, "/internal/meet/recording-uploads", {
      orgId,
      roomId,
      mimeType: "video/webm",
      byteSize: validWebmBytes.byteLength,
      sha256: validWebmSha256,
      startedAt: "2026-05-20T11:00:00.000Z",
    });

    expect(prepared.statusCode).toBe(200);
    const preparedBody = prepared.json<{
      uploadId: string;
      storageKey: string;
      headers: Record<string, string>;
    }>();
    expect(preparedBody.headers).toMatchObject({
      "content-type": "video/webm",
      "x-amz-meta-orgid": orgId,
      "x-amz-meta-roomid": roomId,
      "x-amz-meta-uploadid": preparedBody.uploadId,
    });
    storage.objects.set(preparedBody.storageKey, {
      key: preparedBody.storageKey,
      body: validWebmBytes,
      contentType: "video/webm",
      metadata: {
        uploadid: preparedBody.uploadId,
        orgid: orgId,
        roomid: roomId,
      },
    });

    const completed = await injectSigned(app, "/webhook/jitsi", {
      event: "recording.uploaded",
      uploadId: preparedBody.uploadId,
      startedAt: "2026-05-20T11:00:00.000Z",
      endedAt: "2026-05-20T12:00:00.000Z",
      metadata: { uploaded: true, source: "jibri" },
    });

    expect(completed.statusCode).toBe(200);
    expect(resolvedOrgIds).toEqual([orgId, orgId]);
    expect(store.attachments).toEqual([
      expect.objectContaining({
        orgId,
        roomId,
        storageKey: preparedBody.storageKey,
        mimeType: "video/webm",
        byteSize: validWebmBytes.byteLength,
        sha256: validWebmSha256,
        metadata: expect.objectContaining({ uploadId: preparedBody.uploadId, source: "jibri" }),
      }),
    ]);
    expect(store.uploads.get(preparedBody.uploadId)?.completedAt).toEqual(now);
    expect(store.validations).toEqual([
      expect.objectContaining({ status: "ready", byteSize: validWebmBytes.byteLength }),
    ]);
  });

  it("refuses recording storage when capture did not start under a consent authorization", async () => {
    const store = new FakeMeetStore();
    store.recordingStartAuthorized = false;
    const storage = new RecordingStorageClient();
    const app = await createApp(store, storage);

    const response = await injectSigned(app, "/internal/meet/recording-uploads", prepareBody());

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Meet recording start was not authorized by participant consent.",
    });
    expect(storage.presignedPuts).toEqual([]);
  });

  it("fails closed and deletes bytes when authoritative antivirus validation rejects media", async () => {
    const store = new FakeMeetStore();
    const storage = new RecordingStorageClient();
    const uploadId = "77777777-7777-4777-8777-777777777777";
    const prepared = store.seedUpload(uploadId);
    storage.objects.set(prepared.storageKey, {
      key: prepared.storageKey,
      body: validWebmBytes,
      contentType: prepared.mimeType,
      metadata: { uploadid: uploadId, orgid: orgId, roomid: roomId },
    });
    const scanner: MeetRecordingScanner = {
      async scan() {
        return { infected: true, signature: "Eicar-Test", scanned: true, evidence: {} };
      },
      async scanStream() {
        throw new Error("Unexpected stream scan");
      },
    };
    const app = await createApp(store, storage, [], { scanner, requireScanner: true });

    const response = await injectSigned(app, "/webhook/jitsi", completionBody(uploadId));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Prepared Meet recording failed antivirus scanning: Eicar-Test.",
    });
    expect(storage.objects.has(prepared.storageKey)).toBe(false);
    expect(store.attachments).toEqual([]);
    expect(store.validations).toEqual([]);
  });

  it("rejects missing, stale, invalid, and body-tampered HMAC signatures before state changes", async () => {
    const store = new FakeMeetStore();
    const storage = new RecordingStorageClient();
    const app = await createApp(store, storage);
    const body = prepareBody();
    const raw = JSON.stringify(body);

    const missing = await app.inject({
      method: "POST",
      url: "/internal/meet/recording-uploads",
      headers: { "content-type": "application/json" },
      payload: raw,
    });
    const stale = await injectSigned(
      app,
      "/internal/meet/recording-uploads",
      body,
      new Date(now.getTime() - 301_000),
    );
    const invalid = await app.inject({
      method: "POST",
      url: "/internal/meet/recording-uploads",
      headers: {
        "content-type": "application/json",
        "x-helix-signature": signWebhookPayload({
          payload: raw,
          secret: `${webhookSecret}-wrong`,
          timestamp: now,
        }).header,
      },
      payload: raw,
    });
    const original = JSON.stringify({ ...body, byteSize: validWebmBytes.byteLength });
    const tampered = await app.inject({
      method: "POST",
      url: "/internal/meet/recording-uploads",
      headers: {
        "content-type": "application/json",
        "x-helix-signature": signWebhookPayload({
          payload: original,
          secret: webhookSecret,
          timestamp: now,
        }).header,
      },
      payload: JSON.stringify({ ...body, byteSize: validWebmBytes.byteLength + 1 }),
    });

    expect([missing.statusCode, stale.statusCode, invalid.statusCode, tampered.statusCode]).toEqual(
      [401, 401, 401, 401],
    );
    expect(store.uploads.size).toBe(0);
    expect(storage.presignedPuts).toEqual([]);
  });

  it("durably rejects an exact signed-request replay", async () => {
    const store = new FakeMeetStore();
    const app = await createApp(store, new RecordingStorageClient());
    const signed = signedRequest(prepareBody());

    const first = await app.inject({
      method: "POST",
      url: "/internal/meet/recording-uploads",
      ...signed,
    });
    const replay = await app.inject({
      method: "POST",
      url: "/internal/meet/recording-uploads",
      ...signed,
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(409);
    expect(store.uploads.size).toBe(1);
  });

  it("requires storage-enforced encryption before issuing secure-tier upload capabilities", async () => {
    const store = new FakeMeetStore();
    const app = await createApp(store, new RecordingStorageClient(), [], {
      requireEncryption: true,
    });

    const response = await injectSigned(app, "/internal/meet/recording-uploads", prepareBody());

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Meet recording encrypted storage is not configured.",
    });
    expect(store.uploads.size).toBe(0);
  });

  it("rejects caller-controlled tenant and meeting overrides", async () => {
    const store = new FakeMeetStore();
    const app = await createApp(store, new RecordingStorageClient());
    const uploadId = "77777777-7777-4777-8777-777777777777";
    store.seedUpload(uploadId);

    const tenantHeader = await injectSigned(app, "/webhook/jitsi", completionBody(uploadId), now, {
      "x-helix-org-id": otherOrgId,
    });
    const tenantBody = await injectSigned(app, "/webhook/jitsi", {
      ...completionBody(uploadId),
      orgId: otherOrgId,
    });
    const wrongRoom = await injectSigned(app, "/webhook/jitsi", {
      ...completionBody(uploadId),
      roomId: otherRoomId,
    });
    const wrongKey = await injectSigned(app, "/webhook/jitsi", {
      ...completionBody(uploadId),
      storageKey: "recordings/another-room/forged.webm",
    });

    expect([
      tenantHeader.statusCode,
      tenantBody.statusCode,
      wrongRoom.statusCode,
      wrongKey.statusCode,
    ]).toEqual([400, 400, 400, 400]);
    expect(store.attachments).toEqual([]);
  });

  it("rejects unknown, expired, and already-completed prepared upload capabilities", async () => {
    const store = new FakeMeetStore();
    const app = await createApp(store, new RecordingStorageClient());
    const unknownId = "77777777-7777-4777-8777-777777777777";
    const expiredId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const completedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    store.seedUpload(expiredId, { expiresAt: new Date(now.getTime() - 1) });
    store.seedUpload(completedId, { completedAt: now });

    const unknown = await injectSigned(app, "/webhook/jitsi", completionBody(unknownId), now);
    const expired = await injectSigned(
      app,
      "/webhook/jitsi",
      completionBody(expiredId),
      new Date(now.getTime() + 1_000),
    );
    const completed = await injectSigned(
      app,
      "/webhook/jitsi",
      completionBody(completedId),
      new Date(now.getTime() + 2_000),
    );

    expect([unknown.statusCode, expired.statusCode, completed.statusCode]).toEqual([409, 409, 409]);
    expect(store.attachments).toEqual([]);
  });

  it("validates uploaded object bytes and server-bound metadata before attaching", async () => {
    const store = new FakeMeetStore();
    const storage = new RecordingStorageClient();
    const app = await createApp(store, storage);
    const uploadId = "77777777-7777-4777-8777-777777777777";
    const prepared = store.seedUpload(uploadId);
    storage.objects.set(prepared.storageKey, {
      key: prepared.storageKey,
      body: Buffer.from("not a webm"),
      contentType: prepared.mimeType,
      metadata: { uploadid: uploadId, orgid: orgId, roomid: roomId },
    });

    const response = await injectSigned(app, "/webhook/jitsi", completionBody(uploadId));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Prepared Meet recording object bytes do not match the declared media type.",
    });
    expect(store.attachments).toEqual([]);
  });

  it("never promotes missing or truncated recording bytes", async () => {
    const store = new FakeMeetStore();
    const storage = new RecordingStorageClient();
    const missingId = "77777777-7777-4777-8777-777777777777";
    const truncatedId = "88888888-8888-4888-8888-888888888888";
    store.seedUpload(missingId);
    const truncated = store.seedUpload(truncatedId);
    storage.objects.set(truncated.storageKey, {
      key: truncated.storageKey,
      body: validWebmBytes.subarray(0, 4),
      contentType: truncated.mimeType,
      metadata: { uploadid: truncatedId, orgid: orgId, roomid: roomId },
    });

    const app = await createApp(store, storage);
    const missing = await injectSigned(app, "/webhook/jitsi", completionBody(missingId));
    const short = await injectSigned(
      app,
      "/webhook/jitsi",
      completionBody(truncatedId),
      new Date(now.getTime() + 1_000),
    );

    expect([missing.statusCode, short.statusCode]).toEqual([400, 400]);
    expect(store.attachments).toEqual([]);
    expect(store.validations).toEqual([]);
  });

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
    const app = await createApp(store, new RecordingStorageClient());
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
        recordingNoticeVersion: "2026-09-02",
        deviceId: "99999999-9999-4999-8999-999999999999",
        joinGrantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });
    expect(joined.statusCode).toBe(200);
    expect(store.guestConsents).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    expect(joined.json()).toMatchObject({ roomId, lobbyRequired: true });
    const jwtPayload = JSON.parse(
      Buffer.from(String(joined.json().token).split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { readonly context: { readonly user: { readonly moderator: boolean } } };
    expect(jwtPayload.context.user.moderator).toBe(false);

    store.guestResolution = null;
    const revoked = await app.inject({
      method: "POST",
      url: "/api/meet/guest/join",
      payload: {
        token,
        email: invite.email,
        name: "Guest",
        recordingNoticeAccepted: true,
        recordingNoticeVersion: "2026-09-02",
        deviceId: "99999999-9999-4999-8999-999999999999",
        joinGrantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    });
    expect(revoked.statusCode).toBe(404);
  });

  it("refuses to register without a webhook secret", async () => {
    const app = fastify();
    await expect(
      registerMeetRoutes(app, {
        store: new FakeMeetStore(),
        webhookSecret: "",
        jwtSecret: "x".repeat(32),
        jwtSubject: "meet.example.com",
      }),
    ).rejects.toThrow("Meet webhook secret is required.");
  });
});

async function createApp(
  store: FakeMeetStore,
  storage: RecordingStorageClient,
  resolvedOrgIds: string[] = [],
  scanOptions: {
    readonly scanner?: MeetRecordingScanner;
    readonly requireScanner?: boolean;
    readonly requireEncryption?: boolean;
    readonly metrics?: PlatformMetrics;
  } = {},
): Promise<FastifyInstance> {
  const app = fastify();
  await registerMeetRoutes(app, {
    store,
    webhookSecret,
    jwtSecret: "x".repeat(32),
    jwtSubject: "meet.example.com",
    now: () => now,
    ...(scanOptions.scanner === undefined ? {} : { recordingScanner: scanOptions.scanner }),
    requireRecordingScanner: scanOptions.requireScanner ?? false,
    requireRecordingEncryption: scanOptions.requireEncryption ?? false,
    ...(scanOptions.metrics === undefined ? {} : { metrics: scanOptions.metrics }),
    storageResolver: ({ orgId: resolvedOrgId }) => {
      resolvedOrgIds.push(resolvedOrgId);
      return { client: storage, managedBy: "helix-default", prefix: "" };
    },
  });
  return app;
}

function prepareBody(): Record<string, unknown> {
  return {
    orgId,
    roomId,
    mimeType: "video/webm",
    byteSize: validWebmBytes.byteLength,
    sha256: validWebmSha256,
    startedAt: "2026-05-20T11:00:00.000Z",
  };
}

function completionBody(uploadId: string): Record<string, unknown> {
  return {
    event: "recording.uploaded",
    uploadId,
    startedAt: "2026-05-20T11:00:00.000Z",
    endedAt: "2026-05-20T12:00:00.000Z",
    metadata: { uploaded: true },
  };
}

function signedRequest(
  body: unknown,
  timestamp: Date = now,
  extraHeaders: Record<string, string> = {},
): { readonly headers: Record<string, string>; readonly payload: string } {
  const payload = JSON.stringify(body);
  return {
    payload,
    headers: {
      "content-type": "application/json",
      "x-helix-signature": signWebhookPayload({
        payload,
        secret: webhookSecret,
        timestamp,
      }).header,
      ...extraHeaders,
    },
  };
}

function injectSigned(
  app: FastifyInstance,
  url: string,
  body: unknown,
  timestamp: Date = now,
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({ method: "POST", url, ...signedRequest(body, timestamp, extraHeaders) });
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
      ...(input.eventId === "quality-rejoin" ? { reconnected: true } : {}),
      duplicate: false,
    };
  }

  async expireEmptyRooms(): Promise<number> {
    return 0;
  }

  seedUpload(
    id: string,
    overrides: Partial<MeetRecordingUploadRecord> = {},
  ): MeetRecordingUploadRecord {
    const upload: MeetRecordingUploadRecord = {
      id,
      orgId,
      roomId,
      roomName: "Launch Review",
      storageKey: `recordings/Launch-Review/${id}.webm`,
      mimeType: "video/webm",
      byteSize: validWebmBytes.byteLength,
      sha256: validWebmSha256,
      expiresAt: new Date(now.getTime() + 900_000),
      completedAt: null,
      ...overrides,
    };
    this.uploads.set(id, upload);
    return upload;
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
    jitsiDomain: "meet.example.com",
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

class RecordingStorageClient implements TenantStorageClient {
  readonly objects = new Map<string, StorageObject>();
  readonly presignedPuts: string[] = [];

  async put(): Promise<void> {
    throw new Error("Not implemented for route tests.");
  }

  async get(key: string): Promise<StorageObject | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async presignPutRequest(
    key: string,
    options?: {
      readonly contentType?: string;
      readonly metadata?: Record<string, string>;
    },
  ): Promise<{ readonly url: string; readonly headers: Record<string, string> }> {
    this.presignedPuts.push(key);
    return {
      url: `put://${key}`,
      headers: {
        ...(options?.contentType === undefined ? {} : { "content-type": options.contentType }),
        ...Object.fromEntries(
          Object.entries(options?.metadata ?? {}).map(([name, value]) => [
            `x-amz-meta-${name.toLowerCase()}`,
            value,
          ]),
        ),
      },
    };
  }
}
