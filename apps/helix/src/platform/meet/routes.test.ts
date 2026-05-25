import { createHash } from "node:crypto";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { StorageObject } from "@helix/sdk-types";
import { registerMeetRoutes } from "./routes.js";
import type { AttachMeetRecordingInput, MeetStore } from "./store.js";
import type { TenantStorageClient } from "../storage/tenant-resolver.js";
import type {
  MeetMeetingRecord,
  MeetRecordingAttachmentRecord,
  MeetRoomRecord,
  MeetSummaryRef,
} from "./types.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const threadId = "44444444-4444-4444-8444-444444444444";
const objectId = "55555555-5555-4555-8555-555555555555";
const messageId = "66666666-6666-4666-8666-666666666666";
const sha256 = "a".repeat(64);
const validWebmBytes = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01,
]);

describe("Meet recording webhook routes", () => {
  it("attaches recording webhook artifacts to the room thread through the Meet store", async () => {
    const store = new FakeMeetStore();
    const app = fastify();
    await registerMeetRoutes(app, {
      store,
      webhookSecret: "shared-secret",
      defaultOrgId: "00000000-0000-0000-0000-000000000000",
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhook/jitsi",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
        "x-helix-org-id": orgId,
      },
      payload: {
        event_name: "RECORDING_UPLOAD_FINISHED",
        upload_id: "77777777-7777-4777-8777-777777777777",
        room_name: "Launch Review",
        storage_key: "recordings/launch-review.webm",
        mime_type: "video/webm",
        byte_size: 2048,
        sha256,
        started_at: "2026-05-20T14:00:00.000Z",
        ended_at: "2026-05-20T14:45:00.000Z",
        metadata: { source: "jibri" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      attachment: {
        roomId,
        threadId,
        objectId,
        messageId,
        storageKey: "recordings/launch-review.webm",
      },
    });
    expect(store.attachments).toHaveLength(1);
    expect(store.attachments[0]).toMatchObject({
      orgId,
      roomName: "Launch Review",
      storageKey: "recordings/launch-review.webm",
      mimeType: "video/webm",
      byteSize: 2048,
      sha256,
      metadata: {
        event: "RECORDING_UPLOAD_FINISHED",
        uploadId: "77777777-7777-4777-8777-777777777777",
        source: "jibri",
      },
    });
    expect(store.attachments[0]?.startedAt?.toISOString()).toBe("2026-05-20T14:00:00.000Z");
    expect(store.attachments[0]?.endedAt?.toISOString()).toBe("2026-05-20T14:45:00.000Z");
  });

  it("ignores non-recording Jitsi webhook events without touching storage state", async () => {
    const store = new FakeMeetStore();
    const app = fastify();
    await registerMeetRoutes(app, { store, webhookSecret: "shared-secret", defaultOrgId: orgId });

    const response = await app.inject({
      method: "POST",
      url: "/webhook/jitsi",
      headers: {
        "content-type": "application/json",
        "x-jitsi-secret": "shared-secret",
      },
      payload: { event: "participant-joined", room: "Launch Review" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, ignored: true, event: "participant-joined" });
    expect(store.attachments).toEqual([]);
  });

  it("rejects missing or invalid recording webhook artifact locations", async () => {
    const store = new FakeMeetStore();
    const app = fastify();
    await registerMeetRoutes(app, { store, webhookSecret: "shared-secret", defaultOrgId: orgId });

    const response = await app.inject({
      method: "POST",
      url: "/webhook/jitsi",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
      },
      payload: { event: "recording-uploaded", room: "Launch Review" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Jitsi recording webhook requires storageKey, fileKey, or url.",
    });
    expect(store.attachments).toEqual([]);
  });

  it("rejects unsupported recording media metadata before attaching", async () => {
    const store = new FakeMeetStore();
    const app = fastify();
    await registerMeetRoutes(app, { store, webhookSecret: "shared-secret", defaultOrgId: orgId });

    const response = await app.inject({
      method: "POST",
      url: "/webhook/jitsi",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
      },
      payload: {
        event: "recording-uploaded",
        room: "Launch Review",
        storageKey: "recordings/launch-review.txt",
        mimeType: "text/plain",
        byteSize: 12,
        sha256,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Meet recording media must be video/mp4 or video/webm.",
    });
    expect(store.attachments).toEqual([]);
  });

  it("requires prepared upload evidence when configured for BYO recording storage", async () => {
    const store = new FakeMeetStore();
    const storage = new RecordingStorageClient();
    storage.objects.set("recordings/Launch-Review/77777777-7777-4777-8777-777777777777.webm", {
      key: "recordings/Launch-Review/77777777-7777-4777-8777-777777777777.webm",
      body: validWebmBytes,
      contentType: "video/webm",
      metadata: {
        uploadid: "77777777-7777-4777-8777-777777777777",
        orgid: orgId,
      },
    });
    const preparedSha256 = sha256Hex(validWebmBytes);
    const app = fastify();
    await registerMeetRoutes(app, {
      store,
      webhookSecret: "shared-secret",
      defaultOrgId: orgId,
      storageResolver: async () => ({
        client: storage,
        managedBy: "helix-default",
        prefix: "",
      }),
      requirePreparedRecordingUpload: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhook/jitsi",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
        "x-helix-org-id": orgId,
      },
      payload: {
        event: "recording-uploaded",
        roomName: "Launch Review",
        storageKey: "recordings/Launch-Review/77777777-7777-4777-8777-777777777777.webm",
        uploadId: "77777777-7777-4777-8777-777777777777",
        mimeType: "video/webm",
        byteSize: validWebmBytes.byteLength,
        sha256: preparedSha256,
        metadata: { uploaded: true },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(store.attachments).toHaveLength(1);
    expect(store.attachments[0]).toMatchObject({
      orgId,
      storageKey: "recordings/Launch-Review/77777777-7777-4777-8777-777777777777.webm",
      metadata: {
        uploadId: "77777777-7777-4777-8777-777777777777",
        uploaded: true,
      },
    });
  });

  it("validates prepared recording objects before attaching", async () => {
    const store = new FakeMeetStore();
    const storage = new RecordingStorageClient();
    const app = fastify();
    await registerMeetRoutes(app, {
      store,
      webhookSecret: "shared-secret",
      defaultOrgId: orgId,
      storageResolver: async () => ({
        client: storage,
        managedBy: "helix-default",
        prefix: "",
      }),
    });

    const missing = await app.inject({
      method: "POST",
      url: "/webhook/jitsi",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
        "x-helix-org-id": orgId,
      },
      payload: {
        event: "recording-uploaded",
        roomName: "Launch Review",
        storageKey: "recordings/Launch-Review/77777777-7777-4777-8777-777777777777.webm",
        uploadId: "77777777-7777-4777-8777-777777777777",
        mimeType: "video/webm",
        byteSize: 2048,
        sha256,
        metadata: { uploaded: true },
      },
    });

    storage.objects.set("recordings/Launch-Review/77777777-7777-4777-8777-777777777777.webm", {
      key: "recordings/Launch-Review/77777777-7777-4777-8777-777777777777.webm",
      body: validWebmBytes,
      contentType: "video/webm",
      metadata: {
        uploadid: "77777777-7777-4777-8777-777777777777",
        orgid: orgId,
      },
    });
    const shaMismatch = await app.inject({
      method: "POST",
      url: "/webhook/jitsi",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
        "x-helix-org-id": orgId,
      },
      payload: {
        event: "recording-uploaded",
        roomName: "Launch Review",
        storageKey: "recordings/Launch-Review/77777777-7777-4777-8777-777777777777.webm",
        uploadId: "77777777-7777-4777-8777-777777777777",
        mimeType: "video/webm",
        byteSize: validWebmBytes.byteLength,
        sha256,
        metadata: { uploaded: true },
      },
    });
    const plainBytes = Buffer.from("actual bytes");
    storage.objects.set("recordings/Launch-Review/77777777-7777-4777-8777-777777777777.webm", {
      key: "recordings/Launch-Review/77777777-7777-4777-8777-777777777777.webm",
      body: plainBytes,
      contentType: "video/webm",
      metadata: {
        uploadid: "77777777-7777-4777-8777-777777777777",
        orgid: orgId,
      },
    });
    const mediaMismatch = await app.inject({
      method: "POST",
      url: "/webhook/jitsi",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
        "x-helix-org-id": orgId,
      },
      payload: {
        event: "recording-uploaded",
        roomName: "Launch Review",
        storageKey: "recordings/Launch-Review/77777777-7777-4777-8777-777777777777.webm",
        uploadId: "77777777-7777-4777-8777-777777777777",
        mimeType: "video/webm",
        byteSize: plainBytes.byteLength,
        sha256: sha256Hex(plainBytes),
        metadata: { uploaded: true },
      },
    });

    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({
      error: "Prepared Meet recording object was not found in tenant storage.",
    });
    expect(shaMismatch.statusCode).toBe(400);
    expect(shaMismatch.json()).toEqual({
      error: "Prepared Meet recording object sha256 does not match the webhook sha256.",
    });
    expect(mediaMismatch.statusCode).toBe(400);
    expect(mediaMismatch.json()).toEqual({
      error: "Prepared Meet recording object bytes do not match the declared media type.",
    });
    expect(store.attachments).toEqual([]);
  });

  it("rejects unprepared recording webhooks when prepared upload mode is required", async () => {
    const store = new FakeMeetStore();
    const app = fastify();
    await registerMeetRoutes(app, {
      store,
      webhookSecret: "shared-secret",
      defaultOrgId: orgId,
      requirePreparedRecordingUpload: true,
    });

    const missingUploadId = await app.inject({
      method: "POST",
      url: "/webhook/jitsi",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
      },
      payload: {
        event: "recording-uploaded",
        roomName: "Launch Review",
        storageKey: "recordings/Launch-Review/manual.webm",
        mimeType: "video/webm",
        byteSize: 2048,
        sha256,
        metadata: { uploaded: true },
      },
    });
    const mismatchedStorageKey = await app.inject({
      method: "POST",
      url: "/webhook/jitsi",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
      },
      payload: {
        event: "recording-uploaded",
        roomName: "Launch Review",
        storageKey: "recordings/Launch-Review/other.webm",
        uploadId: "77777777-7777-4777-8777-777777777777",
        mimeType: "video/webm",
        byteSize: 2048,
        sha256,
        metadata: { uploaded: true },
      },
    });
    const uploadedFalse = await app.inject({
      method: "POST",
      url: "/webhook/jitsi",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
      },
      payload: {
        event: "recording-uploaded",
        roomName: "Launch Review",
        storageKey: "recordings/Launch-Review/77777777-7777-4777-8777-777777777777.webm",
        uploadId: "77777777-7777-4777-8777-777777777777",
        mimeType: "video/webm",
        byteSize: 2048,
        sha256,
        metadata: { uploaded: false },
      },
    });

    expect(missingUploadId.statusCode).toBe(400);
    expect(missingUploadId.json()).toEqual({
      error: "Jitsi recording webhook requires uploadId in prepared-upload mode.",
    });
    expect(mismatchedStorageKey.statusCode).toBe(400);
    expect(mismatchedStorageKey.json()).toEqual({
      error: "Jitsi recording webhook storageKey does not match the prepared uploadId.",
    });
    expect(uploadedFalse.statusCode).toBe(400);
    expect(uploadedFalse.json()).toEqual({
      error: "Jitsi recording webhook requires uploaded=true in prepared-upload mode.",
    });
    expect(store.attachments).toEqual([]);
  });

  it("requires the configured shared secret before processing recording webhooks", async () => {
    const store = new FakeMeetStore();
    const app = fastify();
    await registerMeetRoutes(app, { store, webhookSecret: "shared-secret", defaultOrgId: orgId });

    const response = await app.inject({
      method: "POST",
      url: "/webhook/jitsi",
      headers: { "content-type": "application/json", "x-helix-jitsi-secret": "wrong" },
      payload: {
        event: "recording-uploaded",
        room: "Launch Review",
        storageKey: "recordings/launch-review.mp4",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid Jitsi webhook secret." });
    expect(store.attachments).toEqual([]);
  });

  it("prepares tenant-resolved recording uploads with a presigned PUT URL", async () => {
    const store = new FakeMeetStore();
    const storage = new RecordingStorageClient();
    const resolvedOrgIds: string[] = [];
    const app = fastify();
    await registerMeetRoutes(app, {
      store,
      webhookSecret: "shared-secret",
      storageResolver: async ({ orgId: resolvedOrgId }) => {
        resolvedOrgIds.push(resolvedOrgId);
        return {
          client: storage,
          managedBy: "helix-default",
          prefix: `tenants/${resolvedOrgId}/`,
        };
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/meet/recording-uploads",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
        "x-helix-org-id": orgId,
      },
      payload: {
        roomName: "Launch Review",
        mimeType: "video/webm",
        byteSize: 2048,
        sha256,
      },
    });

    expect(response.statusCode).toBe(200);
    const body: {
      readonly uploadId: string;
      readonly storageKey: string;
      readonly uploadUrl: string;
      readonly headers: Record<string, string>;
      readonly expiresAt: string;
      readonly completeWebhook: string;
    } = response.json();
    expect(body.storageKey).toMatch(/^recordings\/Launch-Review\/[0-9a-f-]+\.webm$/u);
    expect(body.uploadUrl).toBe(`put://${body.storageKey}`);
    expect(body.headers).toEqual({
      "content-type": "video/webm",
      "x-amz-meta-uploadid": body.uploadId,
      "x-amz-meta-orgid": orgId,
      "x-amz-meta-roomname": "Launch Review",
    });
    expect(body.completeWebhook).toBe("/webhook/jitsi");
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(resolvedOrgIds).toEqual([orgId]);
    expect(storage.presignedPuts).toEqual([
      {
        key: body.storageKey,
        expiresSeconds: 900,
        contentType: "video/webm",
        metadata: {
          uploadId: body.uploadId,
          orgId,
          roomName: "Launch Review",
        },
      },
    ]);
  });

  it("rejects recording upload preparation for unsupported or empty media", async () => {
    const storage = new RecordingStorageClient();
    const app = fastify();
    await registerMeetRoutes(app, {
      store: new FakeMeetStore(),
      webhookSecret: "shared-secret",
      storageResolver: async () => ({
        client: storage,
        managedBy: "helix-default",
        prefix: "",
      }),
    });

    const invalidMime = await app.inject({
      method: "POST",
      url: "/internal/meet/recording-uploads",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
        "x-helix-org-id": orgId,
      },
      payload: { roomName: "Launch Review", mimeType: "application/octet-stream", byteSize: 1 },
    });
    const emptyMedia = await app.inject({
      method: "POST",
      url: "/internal/meet/recording-uploads",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
        "x-helix-org-id": orgId,
      },
      payload: { roomName: "Launch Review", mimeType: "video/mp4", byteSize: 0 },
    });

    expect(invalidMime.statusCode).toBe(400);
    expect(invalidMime.json()).toEqual({
      error: "Meet recording media must be video/mp4 or video/webm.",
    });
    expect(emptyMedia.statusCode).toBe(400);
    expect(emptyMedia.json()).toEqual({
      error: "Meet recording media byteSize must be greater than zero.",
    });
    expect(storage.presignedPuts).toEqual([]);
  });

  it("rejects recording upload preparation without tenant context", async () => {
    const app = fastify();
    await registerMeetRoutes(app, {
      store: new FakeMeetStore(),
      webhookSecret: "shared-secret",
      storageResolver: async () => ({
        client: new RecordingStorageClient(),
        managedBy: "helix-default",
        prefix: "",
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/meet/recording-uploads",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
      },
      payload: { roomName: "Launch Review" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Meet recording upload preparation requires X-Helix-Org-Id.",
    });
  });

  it("rejects recording upload preparation when tenant storage is not configured", async () => {
    const app = fastify();
    await registerMeetRoutes(app, {
      store: new FakeMeetStore(),
      webhookSecret: "shared-secret",
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/meet/recording-uploads",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
        "x-helix-org-id": orgId,
      },
      payload: { roomName: "Launch Review" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Meet recording upload storage is not configured.",
    });
  });

  it("rejects recording upload preparation for an unknown room name", async () => {
    const storage = new RecordingStorageClient();
    const app = fastify();
    await registerMeetRoutes(app, {
      store: new FakeMeetStore(),
      webhookSecret: "shared-secret",
      storageResolver: async () => ({
        client: storage,
        managedBy: "helix-default",
        prefix: "",
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/meet/recording-uploads",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
        "x-helix-org-id": orgId,
      },
      payload: { roomName: "Unknown Room" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Unknown Meet room for recording upload." });
    expect(storage.presignedPuts).toEqual([]);
  });

  it("rejects recording upload preparation for an unknown room id", async () => {
    const storage = new RecordingStorageClient();
    const app = fastify();
    await registerMeetRoutes(app, {
      store: new FakeMeetStore(),
      webhookSecret: "shared-secret",
      storageResolver: async () => ({
        client: storage,
        managedBy: "helix-default",
        prefix: "",
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/meet/recording-uploads",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
        "x-helix-org-id": orgId,
      },
      payload: { roomId: "77777777-7777-4777-8777-777777777777" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Unknown Meet room for recording upload." });
    expect(storage.presignedPuts).toEqual([]);
  });

  it("rejects recording upload preparation when storage cannot presign", async () => {
    const app = fastify();
    await registerMeetRoutes(app, {
      store: new FakeMeetStore(),
      webhookSecret: "shared-secret",
      storageResolver: async () => ({
        client: new MetadataOnlyStorageClient(),
        managedBy: "helix-default",
        prefix: "",
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/meet/recording-uploads",
      headers: {
        "content-type": "application/json",
        "x-helix-jitsi-secret": "shared-secret",
        "x-helix-org-id": orgId,
      },
      payload: { roomName: "Launch Review" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Meet recording upload storage does not support presigned uploads.",
    });
  });
});

class FakeMeetStore implements MeetStore {
  readonly attachments: AttachMeetRecordingInput[] = [];

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

  async getRoomById(input: { readonly roomId: string }): Promise<MeetRoomRecord | null> {
    return input.roomId === roomId ? meetRoomRecord() : null;
  }

  async getRoomByName(input: { readonly roomName: string }): Promise<MeetRoomRecord | null> {
    if (input.roomName !== "Launch Review") {
      return null;
    }
    return meetRoomRecord();
  }

  async endRoom(): Promise<MeetRoomRecord | null> {
    throw new Error("Not implemented for route tests.");
  }

  async attachRecording(
    input: AttachMeetRecordingInput,
  ): Promise<MeetRecordingAttachmentRecord | null> {
    this.attachments.push(input);
    return {
      roomId,
      threadId,
      objectId,
      messageId,
      storageKey: input.storageKey,
    };
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
    subject: "Launch Review",
    jitsiDomain: "meet.example.com",
    status: "active",
    createdByActorId: null,
    startedAt: new Date("2026-05-20T14:00:00.000Z"),
    endedAt: null,
    scheduledStartAt: null,
    scheduledEndAt: null,
    metadata: {},
    createdAt: new Date("2026-05-20T14:00:00.000Z"),
    updatedAt: new Date("2026-05-20T14:00:00.000Z"),
  };
}

class RecordingStorageClient implements TenantStorageClient {
  readonly objects = new Map<string, StorageObject>();
  readonly presignedPuts: {
    readonly key: string;
    readonly expiresSeconds: number | undefined;
    readonly contentType: string | undefined;
    readonly metadata: Record<string, string> | undefined;
  }[] = [];

  async put(): Promise<void> {
    throw new Error("Not implemented for route tests.");
  }

  async get(key: string): Promise<StorageObject | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(): Promise<void> {
    throw new Error("Not implemented for route tests.");
  }

  async presignPutUrl(
    key: string,
    options?: {
      readonly expiresSeconds?: number;
      readonly contentType?: string;
      readonly metadata?: Record<string, string>;
    },
  ): Promise<string> {
    this.presignedPuts.push({
      key,
      expiresSeconds: options?.expiresSeconds,
      contentType: options?.contentType,
      metadata: options?.metadata,
    });
    return `put://${key}`;
  }

  async presignPutRequest(
    key: string,
    options?: {
      readonly expiresSeconds?: number;
      readonly contentType?: string;
      readonly metadata?: Record<string, string>;
    },
  ): Promise<{ readonly url: string; readonly headers: Record<string, string> }> {
    const url = await this.presignPutUrl(key, options);
    return {
      url,
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

class MetadataOnlyStorageClient implements TenantStorageClient {
  async put(): Promise<void> {
    throw new Error("Not implemented for route tests.");
  }

  async get(): Promise<StorageObject | null> {
    throw new Error("Not implemented for route tests.");
  }

  async delete(): Promise<void> {
    throw new Error("Not implemented for route tests.");
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
