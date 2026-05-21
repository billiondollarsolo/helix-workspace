import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerMeetRoutes } from "./routes.js";
import type { AttachMeetRecordingInput, MeetStore } from "./store.js";
import type { MeetRecordingAttachmentRecord, MeetRoomRecord } from "./types.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const threadId = "44444444-4444-4444-8444-444444444444";
const objectId = "55555555-5555-4555-8555-555555555555";
const messageId = "66666666-6666-4666-8666-666666666666";
const sha256 = "a".repeat(64);

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
      metadata: { event: "RECORDING_UPLOAD_FINISHED", source: "jibri" },
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
});

class FakeMeetStore implements MeetStore {
  readonly attachments: AttachMeetRecordingInput[] = [];

  async createRoom(): Promise<MeetRoomRecord> {
    throw new Error("Not implemented for route tests.");
  }

  async listRoomsForActor(): Promise<readonly MeetRoomRecord[]> {
    throw new Error("Not implemented for route tests.");
  }

  async getRoomForActor(): Promise<MeetRoomRecord | null> {
    throw new Error("Not implemented for route tests.");
  }

  async getRoomByName(): Promise<MeetRoomRecord | null> {
    throw new Error("Not implemented for route tests.");
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
}
