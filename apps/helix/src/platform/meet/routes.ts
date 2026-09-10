import type { JsonObject } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import type { PlatformMetrics } from "../../api/metrics.js";
import { MEET_WEBHOOK_BODY_LIMIT_BYTES, readBoundedRequestBody } from "../../api/request-body.js";
import type { TenantStorageClient, TenantStorageResolver } from "../storage/tenant-resolver.js";
import { toJsonObject } from "../util/json.js";
import { verifyWebhookSignature } from "../webhooks/signatures.js";
import { meetGuestInviteTokenHash, verifyMeetGuestInviteToken } from "./guest-invites.js";
import { mintJitsiJwt } from "./jwt.js";
import type {
  MeetMediaEventType,
  MeetMediaWebhookStore,
  MeetRecordingUploadRecord,
  MeetStore,
} from "./store.js";
import { MEET_RECORDING_NOTICE_VERSION } from "./store.js";
import { buildJoinUrl, meetJwtFeatures } from "./tools.js";

const SIGNATURE_TOLERANCE_SECONDS = 300;
const UPLOAD_EXPIRY_SECONDS = 900;
const rawMeetBodies = new WeakMap<object, Buffer>();

export interface MeetRecordingScanner {
  scan(bytes: Buffer): Promise<MeetRecordingScanResult>;
  scanStream(bytes: AsyncIterable<Uint8Array>, byteSize: number): Promise<MeetRecordingScanResult>;
}

interface MeetRecordingScanResult {
  readonly infected: boolean;
  readonly signature: string | null;
  readonly scanned: boolean;
  readonly evidence: JsonObject;
}

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

const recordingUploadPrepareSchema = z
  .object({
    orgId: z.string().uuid(),
    roomId: z.string().uuid().optional(),
    roomName: z.string().trim().min(1).max(255).optional(),
    mimeType: z.string().min(1),
    byteSize: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/iu),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable().optional(),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict()
  .refine((value) => (value.roomId === undefined) !== (value.roomName === undefined), {
    message: "Exactly one of roomId or roomName is required.",
  });

const jitsiWebhookSchema = z
  .object({
    event: z.string().min(1),
    eventId: z.string().min(1).max(200).optional(),
    orgId: z.string().uuid().optional(),
    uploadId: z.string().uuid().optional(),
    roomId: z.string().uuid().optional(),
    roomName: z.string().min(1).optional(),
    sessionId: z.string().min(1).max(200).optional(),
    participantId: z.string().min(1).max(200).optional(),
    occurredAt: z.string().datetime().optional(),
    storageKey: z.string().min(1).optional(),
    mimeType: z.string().min(1).optional(),
    byteSize: z.number().int().positive().optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/iu)
      .optional(),
    startedAt: z.string().datetime().nullable().optional(),
    endedAt: z.string().datetime().nullable().optional(),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict();

export interface RegisterMeetRoutesOptions {
  readonly store: MeetStore & MeetMediaWebhookStore;
  readonly webhookSecret: string;
  readonly jwtSecret: string;
  readonly jwtIssuer?: string | undefined;
  readonly jwtAudience?: string | undefined;
  readonly jwtSubject: string;
  readonly jitsiPublicUrl?: string | undefined;
  readonly guestInviteSecret?: string | undefined;
  readonly storageResolver?: TenantStorageResolver | undefined;
  readonly recordingScanner?: MeetRecordingScanner | undefined;
  readonly requireRecordingScanner?: boolean | undefined;
  readonly requireRecordingEncryption?: boolean | undefined;
  readonly metrics?: PlatformMetrics | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}

export async function registerMeetRoutes(
  app: FastifyInstance,
  options: RegisterMeetRoutesOptions,
): Promise<void> {
  if (options.webhookSecret.length === 0) {
    throw new Error("Meet webhook secret is required.");
  }
  const now = options.now ?? (() => new Date());

  app.post("/api/meet/guest/join", async (request, reply) => {
    const parsed = guestJoinSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Recording notice consent is required to join." });
    }
    const input = parsed.data;
    const at = now();
    const claims = verifyMeetGuestInviteToken(
      options.guestInviteSecret ?? options.jwtSecret,
      input.token,
      at,
    );
    if (claims === null) return reply.code(404).send({ error: "Unknown meeting invitation." });
    const resolved = await options.store.resolveGuestInvite({
      ...claims,
      email: input.email,
      tokenHash: meetGuestInviteTokenHash(input.token),
      now: at,
    });
    if (resolved === null) return reply.code(404).send({ error: "Unknown meeting invitation." });
    const participantSubject = `guest:${resolved.invite.id}`;
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
    const minted = mintJitsiJwt({
      secret: options.jwtSecret,
      issuer: options.jwtIssuer ?? "helix",
      audience: options.jwtAudience,
      subject: options.jwtSubject,
      room: resolved.room.roomName,
      ttlSeconds,
      now: at,
      user: {
        id: participantSubject,
        name: input.name,
        email: input.email,
        moderator: false,
      },
      features: meetJwtFeatures(controls, participantSubject, false),
    });
    reply.header("cache-control", "no-store");
    return {
      roomId: resolved.room.id,
      roomName: resolved.room.roomName,
      joinUrl: buildJoinUrl(
        resolved.room.jitsiDomain,
        resolved.room.roomName,
        minted.token,
        options.jitsiPublicUrl,
      ),
      token: minted.token,
      expiresAt: minted.expiresAt.toISOString(),
      lobbyRequired: resolved.room.lobbyEnabled,
      canStartRecording: false,
      recordingNoticeVersion: MEET_RECORDING_NOTICE_VERSION,
      recordingActive: resolved.room.recordingActive ?? false,
      controls,
      canModerate: false,
    };
  });

  app.addHook("preParsing", (request, _reply, payload, done) => {
    if (!isMeetMediaPath(request.url)) {
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

  app.post(
    "/internal/meet/recording-uploads",
    { bodyLimit: MEET_WEBHOOK_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const raw = await authenticateMediaRequest(request, options, now());
      if (raw === null) {
        return reply.code(401).send({ error: "Invalid Meet webhook signature." });
      }
      if (raw === false) {
        return reply.code(409).send({ error: "Meet webhook replay rejected." });
      }

      try {
        const parsed = recordingUploadPrepareSchema.safeParse(parseRawJson(raw));
        if (!parsed.success) {
          return await reply.code(400).send({ error: "Invalid Meet recording upload request." });
        }
        if (options.storageResolver === undefined) {
          return await reply
            .code(503)
            .send({ error: "Meet recording upload storage is not configured." });
        }
        const body = parsed.data;
        const mediaValidation = validateRecordingMedia(body);
        if (mediaValidation !== null) {
          return await reply.code(400).send({ error: mediaValidation });
        }
        const room =
          body.roomId === undefined
            ? await options.store.getRoomByName({
                orgId: body.orgId,
                roomName: body.roomName ?? "",
              })
            : await options.store.getRoomById({ orgId: body.orgId, roomId: body.roomId });
        if (room === null) {
          return await reply.code(404).send({ error: "Unknown Meet room for recording upload." });
        }
        if (
          !(await options.store.claimRecordingUploadAuthorization({
            orgId: room.orgId,
            roomId: room.id,
            startedAt: new Date(body.startedAt),
          }))
        ) {
          return await reply
            .code(403)
            .send({ error: "Meet recording start was not authorized by participant consent." });
        }
        const storage = await options.storageResolver({ orgId: room.orgId });
        if (
          storage?.client.presignPutUrl === undefined &&
          storage?.client.presignPutRequest === undefined
        ) {
          return await reply
            .code(503)
            .send({ error: "Meet recording upload storage does not support presigned uploads." });
        }

        const uploadId = randomUUID();
        const storageKey = `recordings/${storageKeySegment(room.roomName)}/${uploadId}.${extensionForMimeType(body.mimeType)}`;
        const expiresAt = new Date(now().getTime() + UPLOAD_EXPIRY_SECONDS * 1000);
        const uploadOptions = {
          expiresSeconds: UPLOAD_EXPIRY_SECONDS,
          contentType: body.mimeType,
          metadata: { uploadId, orgId: room.orgId, roomId: room.id },
        };
        const upload =
          storage.client.presignPutRequest === undefined
            ? {
                url: await storage.client.presignPutUrl?.(storageKey, uploadOptions),
                headers: { "content-type": body.mimeType },
              }
            : await storage.client.presignPutRequest(storageKey, uploadOptions);
        if (upload.url === undefined) {
          return await reply
            .code(503)
            .send({ error: "Meet recording upload storage does not support presigned uploads." });
        }
        if (
          options.requireRecordingEncryption === true &&
          !("x-amz-server-side-encryption" in upload.headers)
        ) {
          return await reply
            .code(503)
            .send({ error: "Meet recording encrypted storage is not configured." });
        }
        const prepared = await options.store.prepareRecordingUpload({
          id: uploadId,
          orgId: room.orgId,
          roomId: room.id,
          storageKey,
          mimeType: body.mimeType,
          byteSize: body.byteSize,
          sha256: body.sha256.toLowerCase(),
          expiresAt,
        });
        if (!prepared) {
          return await reply
            .code(409)
            .send({ error: "Meet recording upload could not be prepared." });
        }
        return {
          uploadId,
          storageKey,
          uploadUrl: upload.url,
          headers: upload.headers,
          expiresAt: expiresAt.toISOString(),
          completeWebhook: "/webhook/jitsi",
        };
      } catch (error) {
        options.onError?.(error);
        throw error;
      }
    },
  );

  app.post(
    "/webhook/jitsi",
    { bodyLimit: MEET_WEBHOOK_BODY_LIMIT_BYTES },
    async (request, reply) => {
      if (request.headers["x-helix-org-id"] !== undefined) {
        return reply.code(400).send({ error: "Meet webhook tenant headers are not accepted." });
      }
      const raw = await authenticateMediaRequest(request, options, now());
      if (raw === null) {
        return reply.code(401).send({ error: "Invalid Meet webhook signature." });
      }
      if (raw === false) {
        return reply.code(409).send({ error: "Meet webhook replay rejected." });
      }

      try {
        const parsed = jitsiWebhookSchema.safeParse(parseRawJson(raw));
        if (!parsed.success) {
          return await reply.code(400).send({ error: "Invalid Meet recording webhook." });
        }
        const body = parsed.data;
        const lifecycleEvent = normalizeLifecycleEvent(body.event);
        if (lifecycleEvent !== null) {
          if (
            body.eventId === undefined ||
            body.orgId === undefined ||
            body.roomId === undefined ||
            body.occurredAt === undefined ||
            (lifecycleEvent.startsWith("participant.") && body.sessionId === undefined)
          ) {
            return await reply.code(400).send({ error: "Invalid Meet lifecycle webhook." });
          }
          if (
            lifecycleEvent === "recording.started" &&
            !(await options.store.claimRecordingStartAuthorization({
              orgId: body.orgId,
              roomId: body.roomId,
              startedAt: new Date(body.occurredAt),
            }))
          ) {
            return await reply
              .code(403)
              .send({ error: "Meet recording start was not authorized by participant consent." });
          }
          const lifecycle = await options.store.applyMediaEvent({
            eventId: body.eventId,
            orgId: body.orgId,
            roomId: body.roomId,
            ...(body.roomName === undefined ? {} : { roomName: body.roomName }),
            event: lifecycleEvent,
            ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
            ...(body.participantId === undefined ? {} : { participantId: body.participantId }),
            occurredAt: new Date(body.occurredAt),
          });
          if (lifecycle !== null && !lifecycle.duplicate) {
            if (lifecycleEvent === "participant.joined") {
              options.metrics?.recordMeetParticipantEvent({ event: "joined" });
              if (lifecycle.reconnected === true) {
                options.metrics?.recordMeetParticipantEvent({ event: "reconnected" });
              }
            } else if (lifecycleEvent === "participant.left") {
              options.metrics?.recordMeetParticipantEvent({
                event: "left",
                ...(lifecycle.participantDurationSeconds === undefined
                  ? {}
                  : { durationSeconds: lifecycle.participantDurationSeconds }),
              });
            }
            if (
              lifecycleEvent.startsWith("participant.") ||
              lifecycleEvent.startsWith("conference.")
            ) {
              options.metrics?.recordMeetQuality({
                bridgeParticipantCount: lifecycle.activeParticipantCount,
              });
            }
          }
          return lifecycle === null
            ? await reply.code(404).send({ error: "Unknown Meet room." })
            : { ok: true, lifecycle };
        }
        if (!isRecordingEvent(body.event)) {
          return { ok: true, ignored: true, event: body.event };
        }
        if (body.uploadId === undefined) {
          return await reply.code(400).send({ error: "Invalid Meet recording webhook." });
        }
        if (
          body.startedAt === undefined ||
          body.startedAt === null ||
          body.endedAt === undefined ||
          body.endedAt === null ||
          new Date(body.endedAt) < new Date(body.startedAt)
        ) {
          return await reply.code(400).send({ error: "Meet recording duration is invalid." });
        }
        if (
          body.orgId !== undefined ||
          body.eventId !== undefined ||
          body.occurredAt !== undefined
        ) {
          return await reply.code(400).send({ error: "Invalid Meet recording webhook." });
        }
        const prepared = await options.store.getRecordingUpload(body.uploadId);
        if (
          prepared === null ||
          prepared.completedAt !== null ||
          prepared.expiresAt.getTime() <= now().getTime()
        ) {
          return await reply
            .code(409)
            .send({ error: "Unknown or completed Meet recording upload." });
        }
        if (!completionMatchesPrepared(body, prepared)) {
          return await reply
            .code(400)
            .send({ error: "Meet recording webhook does not match its prepared upload." });
        }
        if (body.metadata.uploaded !== true) {
          return await reply
            .code(400)
            .send({ error: "Meet recording webhook requires uploaded=true." });
        }
        if (options.storageResolver === undefined) {
          return await reply
            .code(503)
            .send({ error: "Meet recording upload storage is not configured." });
        }
        const storage = await options.storageResolver({ orgId: prepared.orgId });
        if (storage === undefined) {
          return await reply
            .code(503)
            .send({ error: "Meet recording upload storage is not configured." });
        }
        if (options.requireRecordingScanner === true && options.recordingScanner === undefined) {
          return await reply
            .code(503)
            .send({ error: "Meet recording antivirus scanning is unavailable." });
        }
        const preparedValidation = await validatePreparedRecordingObject({
          storage: storage.client,
          prepared,
          scanner: options.recordingScanner,
        });
        if (!preparedValidation.ok) {
          await storage.client.delete(prepared.storageKey);
          return await reply
            .code(preparedValidation.unavailable ? 503 : 400)
            .send({ error: preparedValidation.error });
        }
        if (
          !(await options.store.markRecordingUploadReady(prepared.id, preparedValidation.evidence))
        ) {
          return await reply.code(409).send({ error: "Meet recording upload is not promotable." });
        }

        const attachment = await options.store.attachRecording({
          orgId: prepared.orgId,
          roomId: prepared.roomId,
          storageKey: prepared.storageKey,
          mimeType: prepared.mimeType,
          byteSize: prepared.byteSize,
          sha256: prepared.sha256,
          startedAt: new Date(body.startedAt),
          endedAt: new Date(body.endedAt),
          metadata: toJsonObject({
            event: body.event,
            uploadId: body.uploadId,
            ...body.metadata,
            durationSeconds: Math.floor(
              (new Date(body.endedAt).getTime() - new Date(body.startedAt).getTime()) / 1_000,
            ),
            validation: preparedValidation.evidence,
          }),
        });
        if (attachment === null) {
          return await reply.code(409).send({ error: "Prepared Meet room is unavailable." });
        }
        if (!(await options.store.completeRecordingUpload(prepared.id))) {
          return await reply.code(409).send({ error: "Meet webhook replay rejected." });
        }
        return { ok: true, attachment };
      } catch (error) {
        options.onError?.(error);
        throw error;
      }
    },
  );
}

async function authenticateMediaRequest(
  request: FastifyRequest,
  options: RegisterMeetRoutesOptions,
  now: Date,
): Promise<Buffer | null | false> {
  const raw = rawMeetBodies.get(request);
  const signature = stringHeader(request.headers["x-helix-signature"]);
  if (
    raw === undefined ||
    signature === undefined ||
    !verifyWebhookSignature({
      payload: raw,
      secret: options.webhookSecret,
      header: signature,
      toleranceSeconds: SIGNATURE_TOLERANCE_SECONDS,
      now,
    })
  ) {
    return null;
  }
  const receiptId = createHash("sha256")
    .update(request.url.split("?", 1)[0] ?? request.url)
    .update("\0")
    .update(signature)
    .digest("hex");
  const claimed = await options.store.claimMediaWebhook({
    id: receiptId,
    expiresAt: new Date(now.getTime() + SIGNATURE_TOLERANCE_SECONDS * 1000),
  });
  return claimed ? raw : false;
}

function completionMatchesPrepared(
  body: z.infer<typeof jitsiWebhookSchema>,
  prepared: MeetRecordingUploadRecord,
): boolean {
  return (
    (body.roomId === undefined || body.roomId === prepared.roomId) &&
    (body.roomName === undefined || body.roomName === prepared.roomName) &&
    (body.storageKey === undefined || body.storageKey === prepared.storageKey) &&
    (body.mimeType === undefined ||
      normalizedMimeType(body.mimeType) === normalizedMimeType(prepared.mimeType)) &&
    (body.byteSize === undefined || body.byteSize === prepared.byteSize) &&
    (body.sha256 === undefined || body.sha256.toLowerCase() === prepared.sha256)
  );
}

function isMeetMediaPath(url: string): boolean {
  const path = url.split("?", 1)[0];
  return path === "/webhook/jitsi" || path === "/internal/meet/recording-uploads";
}

function parseRawJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Jitsi spells the "recording is ready" event differently across versions. */
const recordingEventNames: ReadonlySet<string> = new Set([
  "recording.uploaded",
  "recording.done",
  "recording.completed",
  "recording.upload.finished",
  "recording.file.uploaded",
]);

function isRecordingEvent(event: string): boolean {
  return recordingEventNames.has(event.toLowerCase().replace(/[_-]+/g, "."));
}

function normalizeLifecycleEvent(event: string): MeetMediaEventType | null {
  const normalized = event.toLowerCase().replace(/[_-]+/gu, ".");
  return normalized === "conference.started" ||
    normalized === "conference.ended" ||
    normalized === "participant.joined" ||
    normalized === "participant.left" ||
    normalized === "recording.started" ||
    normalized === "recording.ended"
    ? normalized
    : null;
}

function storageKeySegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/^\/+|\/+$/gu, "")
    .replace(/[^A-Za-z0-9_.-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return normalized.length === 0 || normalized.includes("..") ? "recording" : normalized;
}

function extensionForMimeType(mimeType: string): "mp4" | "webm" {
  return normalizedMimeType(mimeType) === "video/webm" ? "webm" : "mp4";
}

function validateRecordingMedia(input: {
  readonly mimeType: string;
  readonly byteSize: number;
}): string | null {
  if (!isSupportedRecordingMimeType(input.mimeType)) {
    return "Meet recording media must be video/mp4 or video/webm.";
  }
  return input.byteSize <= 0 ? "Meet recording media byteSize must be greater than zero." : null;
}

function isSupportedRecordingMimeType(mimeType: string): boolean {
  const normalized = normalizedMimeType(mimeType);
  return normalized === "video/mp4" || normalized === "video/webm";
}

async function validatePreparedRecordingObject(input: {
  readonly storage: TenantStorageClient;
  readonly prepared: MeetRecordingUploadRecord;
  readonly scanner?: MeetRecordingScanner | undefined;
}): Promise<
  | { readonly ok: true; readonly evidence: JsonObject }
  | { readonly ok: false; readonly error: string; readonly unavailable?: boolean }
> {
  const object = await input.storage.get(input.prepared.storageKey);
  if (object === null) {
    return { ok: false, error: "Prepared Meet recording object was not found in tenant storage." };
  }
  if (
    object.contentType !== undefined &&
    normalizedMimeType(object.contentType) !== normalizedMimeType(input.prepared.mimeType)
  ) {
    return {
      ok: false,
      error: "Prepared Meet recording object content type does not match the prepared upload.",
    };
  }
  const body = await inspectStorageObjectBody(object.body, input.scanner, input.prepared.byteSize);
  const mediaError = validateMediaSignature(body.prefix, input.prepared.mimeType);
  if (mediaError !== null) {
    return { ok: false, error: mediaError };
  }
  if (body.byteLength !== input.prepared.byteSize) {
    return {
      ok: false,
      error: "Prepared Meet recording object byte size does not match the prepared upload.",
    };
  }
  if (body.sha256 !== input.prepared.sha256) {
    return {
      ok: false,
      error: "Prepared Meet recording object sha256 does not match the prepared upload.",
    };
  }
  const metadata = normalizeMetadata(object.metadata);
  if (metadata.uploadid !== input.prepared.id) {
    return {
      ok: false,
      error: "Prepared Meet recording object metadata does not match the uploadId.",
    };
  }
  if (metadata.orgid !== input.prepared.orgId) {
    return {
      ok: false,
      error: "Prepared Meet recording object metadata does not match the org id.",
    };
  }
  if (metadata.roomid !== input.prepared.roomId) {
    return {
      ok: false,
      error: "Prepared Meet recording object metadata does not match the room id.",
    };
  }
  if (body.scan?.infected === true) {
    return {
      ok: false,
      error: `Prepared Meet recording failed antivirus scanning${body.scan.signature === null ? "." : `: ${body.scan.signature}.`}`,
    };
  }
  if (body.scan?.scanned === false) {
    return {
      ok: false,
      unavailable: true,
      error: "Meet recording antivirus scanner did not scan the complete object.",
    };
  }
  return {
    ok: true,
    evidence: toJsonObject({
      status: "ready",
      byteSize: body.byteLength,
      sha256: body.sha256,
      mimeType: normalizedMimeType(input.prepared.mimeType),
      antivirus: body.scan?.evidence ?? { required: false },
    }),
  };
}

async function inspectStorageObjectBody(
  body: AsyncIterable<Uint8Array> | Uint8Array,
  scanner: MeetRecordingScanner | undefined,
  expectedByteSize: number,
): Promise<{
  readonly byteLength: number;
  readonly prefix: Buffer;
  readonly sha256: string;
  readonly scan: MeetRecordingScanResult | undefined;
}> {
  const hash = createHash("sha256");
  const prefixChunks: Uint8Array[] = [];
  let prefixLength = 0;
  let byteLength = 0;
  const observe = (chunk: Uint8Array): void => {
    byteLength += chunk.byteLength;
    hash.update(chunk);
    if (prefixLength < 12) {
      const slice = chunk.subarray(0, Math.min(chunk.byteLength, 12 - prefixLength));
      prefixChunks.push(slice);
      prefixLength += slice.byteLength;
    }
  };
  let scan: MeetRecordingScanResult | undefined;
  if (body instanceof Uint8Array) {
    observe(body);
    scan = await scanner?.scan(Buffer.from(body));
  } else if (scanner !== undefined) {
    const observed = (async function* (): AsyncIterable<Uint8Array> {
      for await (const chunk of body) {
        observe(chunk);
        yield chunk;
      }
    })();
    scan = await scanner.scanStream(observed, expectedByteSize);
  } else {
    for await (const chunk of body) {
      observe(chunk);
    }
  }
  return {
    byteLength,
    prefix: Buffer.concat(prefixChunks.map((chunk) => Buffer.from(chunk))),
    sha256: hash.digest("hex"),
    scan,
  };
}

function normalizeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function normalizedMimeType(mimeType: string): string {
  return mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
}

function validateMediaSignature(bytes: Buffer, mimeType: string): string | null {
  const mismatch = "Prepared Meet recording object bytes do not match the declared media type.";
  switch (normalizedMimeType(mimeType)) {
    // EBML header magic.
    case "video/webm":
      return bytes.byteLength >= 4 &&
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3
        ? null
        : mismatch;
    // ISO base media file format box type at offset 4.
    case "video/mp4":
      return bytes.byteLength >= 8 && bytes.subarray(4, 8).toString("ascii") === "ftyp"
        ? null
        : mismatch;
    // Unknown media types are not signature-checked here; the mime allowlist above already ran.
    default:
      return null;
  }
}
