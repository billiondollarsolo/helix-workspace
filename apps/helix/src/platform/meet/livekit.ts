/* LiveKit media for Meet (see helix-improvement-plan.md §11c).
 *
 * LiveKit access tokens and webhooks are HS256 JWTs signed with the API secret,
 * so this module needs no LiveKit server SDK. Rooms are named
 * "<orgId>.<roomId>" so webhooks map straight back to a Helix room.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { getCryptoProvider } from "../crypto/index.js";
import type { MeetMediaEventType } from "./store.js";

/** Operator configuration for LiveKit. */
export interface LiveKitOptions {
  readonly apiKey: string;
  readonly apiSecret: string;
  /** Browser-facing websocket origin, e.g. wss://workspace.example.com (the client adds /rtc). */
  readonly publicUrl: string;
  /** Server API origin on the private network, e.g. http://livekit:7880. */
  readonly internalUrl: string;
}

export const LIVEKIT_MAX_TOKEN_TTL_SECONDS = 60 * 60;

export function liveKitRoomName(orgId: string, roomId: string): string {
  return `${orgId}.${roomId}`;
}

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const roomNamePattern = new RegExp(`^(${uuid})\\.(${uuid})$`, "iu");

export function parseLiveKitRoomName(
  name: string,
): { readonly orgId: string; readonly roomId: string } | null {
  const match = roomNamePattern.exec(name);
  return match?.[1] && match[2] ? { orgId: match[1], roomId: match[2] } : null;
}

export interface LiveKitGrants {
  /** Hosts moderate (mute others, remove, end) through the room-admin grant. */
  readonly roomAdmin: boolean;
  readonly canPublish: boolean;
  readonly canSubscribe: boolean;
  readonly canPublishData: boolean;
  /** Which tracks may be published; screen share is left out when the presenter policy denies it. */
  readonly canPublishSources: readonly (
    "camera" | "microphone" | "screen_share" | "screen_share_audio"
  )[];
}

export interface MintLiveKitTokenInput {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly identity: string;
  readonly name: string;
  readonly room: string;
  readonly grants: LiveKitGrants;
  /** Helix context the media server echoes back in webhooks. */
  readonly attributes?: Readonly<Record<string, string>>;
  readonly ttlSeconds: number;
  readonly now?: Date;
}

export interface MintedLiveKitToken {
  readonly token: string;
  readonly expiresAt: Date;
  readonly ttlSeconds: number;
}

export function mintLiveKitToken(input: MintLiveKitTokenInput): MintedLiveKitToken {
  if (input.apiKey.length === 0 || input.apiSecret.length === 0)
    throw new Error("LiveKit API key and secret are required.");
  const ttlSeconds = Math.max(
    30,
    Math.min(LIVEKIT_MAX_TOKEN_TTL_SECONDS, Math.floor(input.ttlSeconds)),
  );
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const payload = {
    iss: input.apiKey,
    sub: input.identity,
    name: input.name,
    nbf: issuedAt - 5,
    exp: issuedAt + ttlSeconds,
    video: {
      room: input.room,
      roomJoin: true,
      roomAdmin: input.grants.roomAdmin,
      canPublish: input.grants.canPublish,
      canSubscribe: input.grants.canSubscribe,
      canPublishData: input.grants.canPublishData,
      canPublishSources: input.grants.canPublishSources,
      // Raised hand and similar state; names and Helix context stay server-issued.
      canUpdateOwnMetadata: true,
    },
    ...(input.attributes === undefined ? {} : { attributes: input.attributes }),
  };
  return {
    token: signHs256(payload, input.apiSecret),
    expiresAt: new Date((issuedAt + ttlSeconds) * 1000),
    ttlSeconds,
  };
}

/**
 * Join details for a LiveKit room: the browser connects to `serverUrl` with `token`.
 * `features` are Meet's per-participant policy (chat, screen sharing), enforced by
 * the media server through token grants.
 */
export function liveKitJoin(
  options: LiveKitOptions,
  input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly identity: string;
    readonly name: string;
    readonly moderator: boolean;
    readonly features: Readonly<Record<string, boolean>>;
    readonly consentVersion: string;
    readonly ttlSeconds: number;
    readonly now?: Date;
  },
) {
  const minted = mintLiveKitToken({
    apiKey: options.apiKey,
    apiSecret: options.apiSecret,
    identity: input.identity,
    name: input.name,
    room: liveKitRoomName(input.orgId, input.roomId),
    grants: {
      roomAdmin: input.moderator,
      canPublish: true,
      canSubscribe: true,
      canPublishData: input.features["send-groupchat"] !== false,
      canPublishSources:
        input.features["screen-sharing"] === false
          ? ["camera", "microphone"]
          : ["camera", "microphone", "screen_share", "screen_share_audio"],
    },
    attributes: {
      helixOrgId: input.orgId,
      helixRoomId: input.roomId,
      helixCaptureConsent: input.consentVersion,
      ...(input.moderator ? { helixRole: "host" } : {}),
    },
    ttlSeconds: input.ttlSeconds,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return {
    provider: "livekit" as const,
    serverUrl: options.publicUrl,
    joinUrl: options.publicUrl,
    token: minted.token,
    expiresAt: minted.expiresAt.toISOString(),
  };
}

/** Short-lived token for Workspace's own calls to the LiveKit server API. */
export function liveKitServerToken(
  options: LiveKitOptions,
  room: string,
  now = new Date(),
): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return signHs256(
    {
      iss: options.apiKey,
      nbf: issuedAt - 5,
      exp: issuedAt + 60,
      video: { room, roomAdmin: true, roomRecord: true, roomCreate: true, roomList: true },
    },
    options.apiSecret,
  );
}

/**
 * LiveKit signs each webhook with an Authorization JWT whose `sha256` claim is the
 * base64 SHA-256 of the raw body. True only for a valid, current signature by our key.
 */
export function verifyLiveKitWebhook(input: {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly authorization: string | undefined;
  readonly body: Buffer;
  readonly now?: Date;
}): boolean {
  const token = input.authorization?.replace(/^Bearer\s+/iu, "");
  const parts = token?.split(".");
  if (parts?.length !== 3) return false;
  const [header, payload, signature] = parts as [string, string, string];
  try {
    if (
      (JSON.parse(Buffer.from(header, "base64url").toString()) as { alg?: string }).alg !== "HS256"
    )
      return false;
    const expected = Buffer.from(
      getCryptoProvider().hmac("sha256", input.apiSecret, `${header}.${payload}`, "base64url"),
    );
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      iss?: string;
      exp?: number;
      nbf?: number;
      sha256?: string;
    };
    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
    if (claims.iss !== input.apiKey) return false;
    if (typeof claims.exp === "number" && claims.exp < nowSeconds - 30) return false;
    if (typeof claims.nbf === "number" && claims.nbf > nowSeconds + 30) return false;
    const digest = createHash("sha256").update(input.body).digest("base64");
    return claims.sha256 === digest;
  } catch {
    return false;
  }
}

export interface LiveKitWebhookEvent {
  readonly event?: string;
  readonly id?: string;
  readonly createdAt?: number | string;
  readonly room?: { readonly name?: string; readonly sid?: string };
  readonly participant?: { readonly sid?: string; readonly identity?: string };
}

export interface LiveKitMediaEvent {
  readonly eventId: string;
  readonly orgId: string;
  readonly roomId: string;
  readonly event: MeetMediaEventType;
  readonly sessionId?: string;
  readonly participantId?: string;
  readonly occurredAt: Date;
}

const eventMap: Readonly<Record<string, MeetMediaEventType>> = {
  room_started: "conference.started",
  room_finished: "conference.ended",
  participant_joined: "participant.joined",
  participant_left: "participant.left",
};

/** Maps a LiveKit webhook onto Meet's lifecycle events; null for events Meet ignores. */
export function liveKitMediaEvent(body: LiveKitWebhookEvent): LiveKitMediaEvent | null {
  const event = body.event === undefined ? undefined : eventMap[body.event];
  const room = body.room?.name === undefined ? null : parseLiveKitRoomName(body.room.name);
  if (event === undefined || room === null || body.id === undefined || body.id.length > 200)
    return null;
  const createdAt = Number(body.createdAt);
  const occurredAt =
    Number.isFinite(createdAt) && createdAt > 0 ? new Date(createdAt * 1000) : new Date();
  const participant = event.startsWith("participant.");
  if (participant && body.participant?.sid === undefined) return null;
  return {
    eventId: `livekit:${body.id}`,
    orgId: room.orgId,
    roomId: room.roomId,
    event,
    ...(participant && body.participant?.sid !== undefined
      ? {
          sessionId: body.participant.sid,
          ...(body.participant.identity === undefined
            ? {}
            : { participantId: body.participant.identity.slice(0, 200) }),
        }
      : {}),
    occurredAt,
  };
}

/** Readiness: the LiveKit server answers its health endpoint. */
export async function liveKitHealthy(options: LiveKitOptions, fetcher: typeof fetch = fetch) {
  try {
    const response = await fetcher(new URL("/", options.internalUrl), {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function signHs256(payload: unknown, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = getCryptoProvider().hmac("sha256", secret, `${header}.${body}`, "base64url");
  return `${header}.${body}.${signature}`;
}
