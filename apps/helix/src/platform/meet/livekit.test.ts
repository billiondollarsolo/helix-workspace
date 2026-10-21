import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  liveKitHealthy,
  liveKitJoin,
  liveKitMediaEvent,
  liveKitRoomName,
  liveKitServerToken,
  mintLiveKitToken,
  parseLiveKitRoomName,
  verifyLiveKitWebhook,
  type LiveKitOptions,
} from "./livekit.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-05-20T12:00:00.000Z");
const options: LiveKitOptions = {
  apiKey: "helix",
  apiSecret: "livekit-test-secret-with-at-least-32-characters",
  publicUrl: "wss://workspace.example.test",
  internalUrl: "http://livekit:7880",
};

function decode(token: string): Record<string, unknown> {
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const expected = createHmac("sha256", options.apiSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  expect(signature).toBe(expected);
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function webhookAuthorization(body: string, claims: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = encode({
    iss: options.apiKey,
    nbf: issuedAt,
    exp: issuedAt + 300,
    sha256: createHash("sha256").update(body).digest("base64"),
    ...claims,
  });
  const signature = createHmac("sha256", options.apiSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `Bearer ${header}.${payload}.${signature}`;
}

describe("LiveKit room names", () => {
  it("round-trips org and room ids and rejects anything else", () => {
    const name = liveKitRoomName(orgId, roomId);
    expect(parseLiveKitRoomName(name)).toEqual({ orgId, roomId });
    expect(parseLiveKitRoomName("lobby")).toBeNull();
    expect(parseLiveKitRoomName(`${orgId}.${roomId}.extra`)).toBeNull();
  });
});

describe("LiveKit access tokens", () => {
  it("signs a room-scoped token and clamps its lifetime", () => {
    const minted = mintLiveKitToken({
      ...options,
      identity: "user-1",
      name: "Ada",
      room: "room",
      grants: {
        roomAdmin: false,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canPublishSources: ["camera"],
      },
      ttlSeconds: 86_400,
      now,
    });
    const claims = decode(minted.token);
    expect(claims).toMatchObject({
      iss: "helix",
      sub: "user-1",
      name: "Ada",
      video: { room: "room", roomJoin: true, roomAdmin: false, canPublishSources: ["camera"] },
    });
    expect(minted.ttlSeconds).toBe(3600);
    expect(claims.exp).toBe(now.getTime() / 1000 + 3600);
  });

  it("maps Meet policy onto grants and gives hosts room admin", () => {
    const host = liveKitJoin(options, {
      orgId,
      roomId,
      identity: "host-1",
      name: "Host",
      moderator: true,
      features: {},
      consentVersion: "2026-10-15",
      ttlSeconds: 300,
      now,
    });
    expect(host).toMatchObject({ provider: "livekit", serverUrl: options.publicUrl });
    expect(decode(host.token)).toMatchObject({
      video: {
        room: `${orgId}.${roomId}`,
        roomAdmin: true,
        canPublishData: true,
        canPublishSources: ["camera", "microphone", "screen_share", "screen_share_audio"],
      },
      attributes: { helixOrgId: orgId, helixRoomId: roomId, helixRole: "host" },
    });

    const attendee = liveKitJoin(options, {
      orgId,
      roomId,
      identity: "user-2",
      name: "Attendee",
      moderator: false,
      features: { "send-groupchat": false, "screen-sharing": false },
      consentVersion: "2026-10-15",
      ttlSeconds: 300,
      now,
    });
    const claims = decode(attendee.token) as {
      video: Record<string, unknown>;
      attributes: Record<string, string>;
    };
    expect(claims.video).toMatchObject({
      roomAdmin: false,
      canPublishData: false,
      canPublishSources: ["camera", "microphone"],
    });
    expect(claims.attributes.helixRole).toBeUndefined();
  });

  it("issues short-lived server API tokens", () => {
    const claims = decode(liveKitServerToken(options, "room", now));
    expect(claims).toMatchObject({ iss: "helix", video: { room: "room", roomAdmin: true } });
    expect(claims.exp).toBe(now.getTime() / 1000 + 60);
  });
});

describe("LiveKit webhooks", () => {
  const body = JSON.stringify({ event: "room_started", id: "EV_1" });
  const verify = (authorization: string | undefined, raw = body, at = now) =>
    verifyLiveKitWebhook({ ...options, authorization, body: Buffer.from(raw), now: at });

  it("accepts a current signature over the exact body", () => {
    expect(verify(webhookAuthorization(body))).toBe(true);
  });

  it("rejects missing, foreign, expired, early and tampered deliveries", () => {
    expect(verify(undefined)).toBe(false);
    expect(verify("Bearer not-a-jwt")).toBe(false);
    expect(verify(webhookAuthorization(body, { iss: "other" }))).toBe(false);
    expect(verify(webhookAuthorization(body), body, new Date(now.getTime() + 400_000))).toBe(false);
    expect(verify(webhookAuthorization(body), body, new Date(now.getTime() - 60_000))).toBe(false);
    expect(verify(webhookAuthorization(body), body.replace("EV_1", "EV_2"))).toBe(false);
    const forged = webhookAuthorization(body).slice(0, -2) + "xx";
    expect(verify(forged)).toBe(false);
  });

  it("maps lifecycle events onto Meet events", () => {
    const room = { name: liveKitRoomName(orgId, roomId) };
    expect(
      liveKitMediaEvent({ event: "room_finished", id: "EV_end", createdAt: 1_779_278_400, room }),
    ).toEqual({
      eventId: "livekit:EV_end",
      orgId,
      roomId,
      event: "conference.ended",
      occurredAt: new Date(1_779_278_400_000),
    });
    expect(
      liveKitMediaEvent({
        event: "participant_left",
        id: "EV_left",
        room,
        participant: { sid: "PA_1", identity: "user-1" },
      }),
    ).toMatchObject({ event: "participant.left", sessionId: "PA_1", participantId: "user-1" });
    expect(liveKitMediaEvent({ event: "track_published", id: "EV_t", room })).toBeNull();
    expect(liveKitMediaEvent({ event: "participant_joined", id: "EV_p", room })).toBeNull();
    expect(liveKitMediaEvent({ event: "room_started", room })).toBeNull();
  });
});

describe("LiveKit health", () => {
  it("reports whether the server answers", async () => {
    const ok = (async () => new Response("OK")) as unknown as typeof fetch;
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(liveKitHealthy(options, ok)).resolves.toBe(true);
    await expect(liveKitHealthy(options, down)).resolves.toBe(false);
  });
});
