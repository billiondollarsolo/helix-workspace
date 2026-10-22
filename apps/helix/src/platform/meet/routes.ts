import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import type { PlatformMetrics } from "../../api/metrics.js";
import { MEET_WEBHOOK_BODY_LIMIT_BYTES, readBoundedRequestBody } from "../../api/request-body.js";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
import { detachedFromTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { meetGuestInviteTokenHash, verifyMeetGuestInviteToken } from "./guest-invites.js";
import {
  liveKitJoin,
  liveKitMediaEvent,
  verifyLiveKitWebhook,
  type LiveKitOptions,
  type LiveKitWebhookEvent,
} from "./livekit.js";
import type { EgressRecordingDeps } from "./egress-recording.js";
import type { MeetEgressRecordingStore } from "./egress-store.js";
import { createLiveKitRooms, type LiveKitRooms } from "./livekit-rooms.js";
import type { MeetLobbyStore } from "./lobby-store.js";
import { handleEgressWebhook } from "./egress-webhook.js";
import type { MeetRecordingScanner } from "./recording-files.js";
import type { MeetMediaWebhookStore, MeetStore } from "./store.js";
import { MEET_RECORDING_NOTICE_VERSION } from "./store.js";
import { meetJwtFeatures } from "./tools.js";

const LIVEKIT_WEBHOOK_PATH = "/webhook/livekit";
/** How often a waiting guest checks back. */
const LOBBY_RETRY_MS = 3_000;
/** LiveKit data topic that tells hosts the lobby changed. */
export const MEET_LOBBY_TOPIC = "helix.lobby";
const REPLAY_WINDOW_SECONDS = 300;
const rawMeetBodies = new WeakMap<object, Buffer>();

const guestJoinSchema = z.object({
  token: z.string().min(80).max(2048),
  email: z
    .string()
    .email()
    .transform((email) => email.toLowerCase()),
  name: z.string().trim().min(1).max(100),
  recordingNoticeAccepted: z.literal(true),
  recordingNoticeVersion: z.literal(MEET_RECORDING_NOTICE_VERSION),
  deviceId: z.string().uuid(),
  joinGrantId: z.string().uuid(),
});

export interface RegisterMeetRoutesOptions {
  readonly store: MeetStore & MeetMediaWebhookStore;
  readonly liveKit: LiveKitOptions;
  /** Verifies guest invitations (see MeetMediaConfig.guestInviteSecret). */
  readonly guestInviteSecret: string;
  readonly storageResolver?: TenantStorageResolver | undefined;
  readonly recordingScanner?: MeetRecordingScanner | undefined;
  readonly requireRecordingScanner?: boolean | undefined;
  readonly requireRecordingEncryption?: boolean | undefined;
  /** Egress recordings: the upload records and the directory Egress writes into. */
  readonly recordings?: MeetEgressRecordingStore | undefined;
  readonly recordingDir?: string | undefined;
  /** Runs after each recording is saved. */
  readonly onRecordingSaved?: EgressRecordingDeps["onSaved"];
  /** The lobby; without it guests join directly. */
  readonly lobby?: MeetLobbyStore | undefined;
  /** LiveKit's room service, to tell hosts someone is waiting; defaults to the configured server. */
  readonly rooms?: LiveKitRooms | undefined;
  readonly metrics?: PlatformMetrics | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}

export async function registerMeetRoutes(
  app: FastifyInstance,
  options: RegisterMeetRoutesOptions,
): Promise<void> {
  if (options.guestInviteSecret.length === 0) {
    throw new Error("Meet guest invite secret is required.");
  }
  const now = options.now ?? (() => new Date());
  let rooms: LiveKitRooms | undefined = options.rooms;
  // Hosts in the call refresh their lobby list when told; it is only a nudge.
  const notifyHosts = (room: { orgId: string; id: string }, moderatorIds: readonly string[]) => {
    rooms ??= createLiveKitRooms(options.liveKit);
    void rooms
      .sendData(room.orgId, room.id, {
        topic: MEET_LOBBY_TOPIC,
        payload: { type: "lobby.waiting" },
        to: moderatorIds,
      })
      .catch((error: unknown) => options.onError?.(error));
  };

  app.post("/api/meet/guest/join", async (request, reply) => {
    const parsed = guestJoinSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Recording notice consent is required to join." });
    }
    const input = parsed.data;
    const at = now();
    const claims = verifyMeetGuestInviteToken(options.guestInviteSecret, input.token, at);
    if (claims === null) return reply.code(404).send({ error: "Unknown meeting invitation." });
    // The signed invite names its organization, which need not be the one this
    // host's request context is bound to.
    return detachedFromTenantPostgresContext(async () => {
      const resolved = await options.store.resolveGuestInvite({
        ...claims,
        email: input.email,
        tokenHash: meetGuestInviteTokenHash(input.token),
        now: at,
      });
      if (resolved === null) return reply.code(404).send({ error: "Unknown meeting invitation." });
      const participantSubject = `guest:${resolved.invite.id}`;
      const entry = await options.lobby?.enter({
        orgId: resolved.room.orgId,
        roomId: resolved.room.id,
        participantSubject,
        displayName: input.name,
      });
      if (entry === null) return reply.code(404).send({ error: "Unknown meeting invitation." });
      if (entry?.status === "denied") {
        return reply.code(403).send({ error: "The host didn't let you in.", denied: true });
      }
      if (entry?.status === "waiting") {
        if (entry.first && entry.moderatorIds.length > 0)
          notifyHosts(resolved.room, entry.moderatorIds);
        reply.header("cache-control", "no-store");
        return reply.code(202).send({ waiting: true, retryAfterMs: LOBBY_RETRY_MS });
      }
      const controls = await options.store.authorizeJoin?.({
        orgId: resolved.room.orgId,
        roomId: resolved.room.id,
        participantSubject,
      });
      if (controls === null || controls === undefined) {
        return reply
          .code(403)
          .send({ error: "Meeting entry is locked or this participant is banned." });
      }
      const ttlSeconds = Math.min(
        5 * 60,
        Math.max(1, Math.floor((resolved.invite.expiresAt.getTime() - at.getTime()) / 1000)),
      );
      const consented = await options.store.recordGuestRecordingConsent({
        orgId: resolved.room.orgId,
        roomId: resolved.room.id,
        guestInviteId: resolved.invite.id,
        joinGrantId: input.joinGrantId,
        deviceId: input.deviceId,
        expiresAt: new Date(at.getTime() + ttlSeconds * 1_000),
      });
      if (!consented) {
        return reply.code(409).send({ error: "Recording notice consent could not be recorded." });
      }
      const join = liveKitJoin(options.liveKit, {
        orgId: resolved.room.orgId,
        roomId: resolved.room.id,
        identity: participantSubject,
        name: input.name,
        moderator: false,
        features: meetJwtFeatures(controls, participantSubject, false),
        consentVersion: MEET_RECORDING_NOTICE_VERSION,
        ttlSeconds,
        now: at,
      });
      reply.header("cache-control", "no-store");
      return {
        roomId: resolved.room.id,
        roomName: resolved.room.roomName,
        mediaDomain: resolved.room.mediaDomain,
        ...join,
        lobbyRequired: resolved.room.lobbyEnabled,
        canStartRecording: false,
        recordingNoticeVersion: MEET_RECORDING_NOTICE_VERSION,
        recordingActive: resolved.room.recordingActive ?? false,
        controls,
        canModerate: false,
      };
    });
  });

  // LiveKit signs the raw body, so keep it before parsing (it uses application/webhook+json).
  app.addHook("preParsing", (request, _reply, payload, done) => {
    if (request.url.split("?", 1)[0] !== LIVEKIT_WEBHOOK_PATH) {
      done(null, payload);
      return;
    }
    void readBoundedRequestBody(payload, MEET_WEBHOOK_BODY_LIMIT_BYTES)
      .then((rawBody) => {
        rawMeetBodies.set(request, rawBody);
        const replay = Readable.from(rawBody);
        (replay as Readable & { receivedEncodedLength?: number }).receivedEncodedLength =
          rawBody.length;
        done(null, replay);
      })
      .catch((error: unknown) => {
        done(error instanceof Error ? error : new Error("Unable to read Meet webhook body"));
      });
  });
  if (!app.hasContentTypeParser("application/webhook+json")) {
    app.addContentTypeParser(
      "application/webhook+json",
      { parseAs: "string" },
      (_request, body, done) => {
        try {
          done(null, JSON.parse(String(body)) as unknown);
        } catch (error) {
          done(error instanceof Error ? error : new Error("Invalid JSON"), undefined);
        }
      },
    );
  }

  app.post(
    LIVEKIT_WEBHOOK_PATH,
    { bodyLimit: MEET_WEBHOOK_BODY_LIMIT_BYTES },
    async (request, reply) => {
      if (request.headers["x-helix-org-id"] !== undefined) {
        return reply.code(400).send({ error: "Meet webhook tenant headers are not accepted." });
      }
      const raw = await authenticateLiveKitRequest(request, options, now());
      if (raw === null) return reply.code(401).send({ error: "Invalid Meet webhook signature." });
      if (raw === false) return reply.code(409).send({ error: "Meet webhook replay rejected." });
      try {
        // Each event names its own organization; leave the request's tenant
        // context so every organization's meetings (and the background
        // recording promotion) get their own.
        return await detachedFromTenantPostgresContext(async () => {
          const body = (parseRawJson(raw) ?? {}) as LiveKitWebhookEvent & { egressInfo?: unknown };
          if (options.recordings !== undefined && options.recordingDir !== undefined) {
            const egress = await handleEgressWebhook(
              {
                store: options.store,
                recordings: options.recordings,
                recordingDir: options.recordingDir,
                storageResolver: options.storageResolver,
                scanner: options.recordingScanner,
                requireScanner: options.requireRecordingScanner,
                requireEncryption: options.requireRecordingEncryption,
                onSaved: options.onRecordingSaved,
                now,
                onError: options.onError,
              },
              body,
            );
            if (egress.handled) return egress.body;
          }
          const event = liveKitMediaEvent(body);
          if (event === null) return { ok: true, ignored: true };
          const lifecycle = await options.store.applyMediaEvent(event);
          if (lifecycle !== null && !lifecycle.duplicate)
            recordLifecycleMetrics(options, event.event, lifecycle);
          // An unknown room never becomes known: answer 200 so LiveKit doesn't retry.
          return lifecycle === null ? { ok: true, ignored: true } : { ok: true, lifecycle };
        });
      } catch (error) {
        options.onError?.(error);
        throw error;
      }
    },
  );
}

function recordLifecycleMetrics(
  options: RegisterMeetRoutesOptions,
  event: string,
  lifecycle: NonNullable<Awaited<ReturnType<MeetMediaWebhookStore["applyMediaEvent"]>>>,
) {
  if (event === "participant.joined") {
    options.metrics?.recordMeetParticipantEvent({ event: "joined" });
    if (lifecycle.reconnected === true)
      options.metrics?.recordMeetParticipantEvent({ event: "reconnected" });
  } else if (event === "participant.left") {
    options.metrics?.recordMeetParticipantEvent({
      event: "left",
      ...(lifecycle.participantDurationSeconds === undefined
        ? {}
        : { durationSeconds: lifecycle.participantDurationSeconds }),
    });
  }
  options.metrics?.recordMeetQuality({
    bridgeParticipantCount: lifecycle.activeParticipantCount,
  });
}

/** Verifies LiveKit's signature and rejects a replayed delivery. */
async function authenticateLiveKitRequest(
  request: FastifyRequest,
  options: RegisterMeetRoutesOptions,
  at: Date,
): Promise<Buffer | null | false> {
  const raw = rawMeetBodies.get(request);
  const authorization = request.headers.authorization;
  if (
    raw === undefined ||
    !verifyLiveKitWebhook({
      apiKey: options.liveKit.apiKey,
      apiSecret: options.liveKit.apiSecret,
      authorization,
      body: raw,
      now: at,
    })
  )
    return null;
  const receiptId = createHash("sha256")
    .update(LIVEKIT_WEBHOOK_PATH)
    .update("\0")
    .update(authorization ?? "")
    .digest("hex");
  const claimed = await options.store.claimMediaWebhook({
    id: receiptId,
    expiresAt: new Date(at.getTime() + REPLAY_WINDOW_SECONDS * 1000),
  });
  return claimed ? raw : false;
}

function parseRawJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}
