import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { JsonObject } from "@helix/sdk-types";
import { z } from "zod3";
import type { TenantStorageClient, TenantStorageResolver } from "../storage/tenant-resolver.js";
import type { MeetStore } from "./store.js";

const jitsiWebhookSchema = z
  .object({
    event: z.string().min(1).optional(),
    eventName: z.string().min(1).optional(),
    event_name: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    roomId: z.string().uuid().optional(),
    room_id: z.string().uuid().optional(),
    roomName: z.string().min(1).optional(),
    room_name: z.string().min(1).optional(),
    room: z.string().min(1).optional(),
    storageKey: z.string().min(1).optional(),
    storage_key: z.string().min(1).optional(),
    fileKey: z.string().min(1).optional(),
    file_key: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    mimeType: z.string().min(1).optional(),
    mime_type: z.string().min(1).optional(),
    byteSize: z.number().int().min(0).optional(),
    byte_size: z.number().int().min(0).optional(),
    size: z.number().int().min(0).optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .nullable()
      .optional(),
    startedAt: z.string().datetime().nullable().optional(),
    started_at: z.string().datetime().nullable().optional(),
    endedAt: z.string().datetime().nullable().optional(),
    ended_at: z.string().datetime().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    uploadId: z.string().uuid().optional(),
    upload_id: z.string().uuid().optional(),
  })
  .passthrough();

const recordingUploadPrepareSchema = z
  .object({
    roomId: z.string().uuid().optional(),
    room_id: z.string().uuid().optional(),
    roomName: z.string().min(1).optional(),
    room_name: z.string().min(1).optional(),
    room: z.string().min(1).optional(),
    mimeType: z.string().min(1).default("video/mp4"),
    mime_type: z.string().min(1).optional(),
    byteSize: z.number().int().min(0).optional(),
    byte_size: z.number().int().min(0).optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .nullable()
      .optional(),
    startedAt: z.string().datetime().nullable().optional(),
    started_at: z.string().datetime().nullable().optional(),
    endedAt: z.string().datetime().nullable().optional(),
    ended_at: z.string().datetime().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

export interface RegisterMeetRoutesOptions {
  readonly store: MeetStore;
  readonly webhookSecret: string;
  readonly defaultOrgId?: string | undefined;
  readonly storageResolver?: TenantStorageResolver | undefined;
  readonly requirePreparedRecordingUpload?: boolean | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}

export async function registerMeetRoutes(
  app: FastifyInstance,
  options: RegisterMeetRoutesOptions,
): Promise<void> {
  app.post("/internal/meet/recording-uploads", async (request, reply) => {
    if (!acceptJitsiSecret(request.headers, options.webhookSecret)) {
      return reply.code(401).send({ error: "Invalid Jitsi webhook secret." });
    }

    try {
      const orgId = stringHeader(request.headers["x-helix-org-id"]);
      if (orgId === undefined) {
        return await reply
          .code(400)
          .send({ error: "Meet recording upload preparation requires X-Helix-Org-Id." });
      }
      if (options.storageResolver === undefined) {
        return await reply
          .code(503)
          .send({ error: "Meet recording upload storage is not configured." });
      }

      const body = recordingUploadPrepareSchema.parse(request.body);
      const roomId = body.roomId ?? body.room_id;
      const roomName = body.roomName ?? body.room_name ?? body.room;
      const mimeType = body.mime_type ?? body.mimeType;
      const mediaValidation = validateRecordingMedia({
        mimeType,
        byteSize: body.byteSize ?? body.byte_size,
        sha256: body.sha256,
        requireCompleteMetadata: false,
      });
      if (mediaValidation !== null) {
        return await reply.code(400).send({ error: mediaValidation });
      }
      if (roomId === undefined && roomName === undefined) {
        return await reply
          .code(400)
          .send({ error: "Meet recording upload preparation requires roomId or roomName." });
      }
      if (roomId !== undefined) {
        const room = await options.store.getRoomById({ orgId, roomId });
        if (room === null) {
          return await reply.code(404).send({ error: "Unknown Meet room for recording upload." });
        }
      }
      if (roomName !== undefined) {
        const room = await options.store.getRoomByName({ orgId, roomName });
        if (room === null) {
          return await reply.code(404).send({ error: "Unknown Meet room for recording upload." });
        }
      }

      const storage = await options.storageResolver({ orgId });
      if (
        storage?.client.presignPutUrl === undefined &&
        storage?.client.presignPutRequest === undefined
      ) {
        return await reply
          .code(503)
          .send({ error: "Meet recording upload storage does not support presigned uploads." });
      }
      const uploadId = randomUUID();
      const storageKey = `recordings/${storageKeySegment(roomId ?? roomName ?? "room")}/${uploadId}.${extensionForMimeType(mimeType)}`;
      const expiresSeconds = 900;
      const uploadOptions = {
        expiresSeconds,
        contentType: mimeType,
        metadata: {
          uploadId,
          orgId,
          ...(roomId === undefined ? {} : { roomId }),
          ...(roomName === undefined ? {} : { roomName }),
        },
      };
      const upload =
        storage.client.presignPutRequest === undefined
          ? {
              url: await storage.client.presignPutUrl?.(storageKey, uploadOptions),
              headers: { "content-type": mimeType },
            }
          : await storage.client.presignPutRequest(storageKey, uploadOptions);
      if (upload.url === undefined) {
        return await reply
          .code(503)
          .send({ error: "Meet recording upload storage does not support presigned uploads." });
      }
      return {
        uploadId,
        storageKey,
        uploadUrl: upload.url,
        headers: upload.headers,
        expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString(),
        completeWebhook: "/webhook/jitsi",
      };
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  });

  app.post("/webhook/jitsi", async (request, reply) => {
    if (!acceptJitsiSecret(request.headers, options.webhookSecret)) {
      return reply.code(401).send({ error: "Invalid Jitsi webhook secret." });
    }

    try {
      const body = jitsiWebhookSchema.parse(request.body);
      const event = body.event ?? body.eventName ?? body.event_name ?? body.type ?? "";
      if (!isRecordingEvent(event)) {
        return { ok: true, ignored: true, event };
      }
      const storageKey =
        body.storageKey ?? body.storage_key ?? body.fileKey ?? body.file_key ?? body.url;
      const roomId = body.roomId ?? body.room_id;
      const roomName = body.roomName ?? body.room_name ?? body.room;
      const byteSize = body.byteSize ?? body.byte_size ?? body.size;
      const mimeType = body.mimeType ?? body.mime_type;
      const startedAt = body.startedAt ?? body.started_at;
      const endedAt = body.endedAt ?? body.ended_at;
      const uploadId = body.uploadId ?? body.upload_id;
      const requirePreparedUpload = options.requirePreparedRecordingUpload === true;
      const headerOrgId = stringHeader(request.headers["x-helix-org-id"]);
      const effectiveOrgId =
        headerOrgId ?? options.defaultOrgId ?? "00000000-0000-0000-0000-000000000000";
      if (storageKey === undefined) {
        return await reply
          .code(400)
          .send({ error: "Jitsi recording webhook requires storageKey, fileKey, or url." });
      }
      const isPreparedUploadCompletion =
        uploadId !== undefined && isPreparedRecordingStorageKey(storageKey, uploadId);
      const mediaValidation = validateRecordingMedia({
        mimeType,
        byteSize,
        sha256: body.sha256,
        requireCompleteMetadata: requirePreparedUpload || isPreparedUploadCompletion,
      });
      if (mediaValidation !== null) {
        return await reply.code(400).send({ error: mediaValidation });
      }
      if (requirePreparedUpload) {
        if (uploadId === undefined) {
          return await reply
            .code(400)
            .send({ error: "Jitsi recording webhook requires uploadId in prepared-upload mode." });
        }
        if (!isPreparedRecordingStorageKey(storageKey, uploadId)) {
          return await reply.code(400).send({
            error: "Jitsi recording webhook storageKey does not match the prepared uploadId.",
          });
        }
        if (body.metadata.uploaded !== true) {
          return await reply.code(400).send({
            error: "Jitsi recording webhook requires uploaded=true in prepared-upload mode.",
          });
        }
      }
      if (isPreparedUploadCompletion) {
        if (options.storageResolver === undefined) {
          return await reply
            .code(503)
            .send({ error: "Meet recording upload storage is not configured." });
        }
        const storage = await options.storageResolver({ orgId: effectiveOrgId });
        if (storage === undefined) {
          return await reply
            .code(503)
            .send({ error: "Meet recording upload storage is not configured." });
        }
        const preparedValidation = await validatePreparedRecordingObject({
          storage: storage.client,
          storageKey,
          uploadId,
          orgId: effectiveOrgId,
          mimeType,
          byteSize,
          sha256: body.sha256,
        });
        if (preparedValidation !== null) {
          return await reply.code(400).send({ error: preparedValidation });
        }
      }
      const attachment = await options.store.attachRecording({
        orgId: effectiveOrgId,
        ...(roomId === undefined ? {} : { roomId }),
        ...(roomName === undefined ? {} : { roomName }),
        storageKey,
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(byteSize === undefined ? {} : { byteSize }),
        ...(body.sha256 === undefined ? {} : { sha256: body.sha256 }),
        startedAt: startedAt === undefined || startedAt === null ? null : new Date(startedAt),
        endedAt: endedAt === undefined || endedAt === null ? null : new Date(endedAt),
        metadata: toJsonObject({
          event,
          ...(uploadId === undefined ? {} : { uploadId }),
          ...body.metadata,
        }),
      });
      if (attachment === null) {
        return await reply.code(404).send({ error: "Unknown Meet room for recording webhook." });
      }
      return { ok: true, attachment };
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  });
}

function acceptJitsiSecret(
  headers: { readonly [key: string]: string | string[] | undefined },
  expected: string,
): boolean {
  if (expected.length === 0) {
    return true;
  }
  const received = stringHeader(headers["x-helix-jitsi-secret"] ?? headers["x-jitsi-secret"]);
  return received === expected;
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecordingEvent(event: string): boolean {
  const normalized = event.toLowerCase().replace(/[_-]+/g, ".");
  return [
    "recording.uploaded",
    "recording.done",
    "recording.completed",
    "recording.upload.finished",
    "recording.file.uploaded",
  ].includes(normalized);
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function storageKeySegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/^\/+/u, "")
    .replace(/[^A-Za-z0-9_.-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return normalized.length === 0 || normalized.includes("..") ? "recording" : normalized;
}

function extensionForMimeType(mimeType: string): "mp4" | "webm" {
  return mimeType.toLowerCase().includes("webm") ? "webm" : "mp4";
}

function validateRecordingMedia(input: {
  readonly mimeType: string | undefined;
  readonly byteSize: number | undefined;
  readonly sha256: string | null | undefined;
  readonly requireCompleteMetadata: boolean;
}): string | null {
  if (input.mimeType !== undefined && !isSupportedRecordingMimeType(input.mimeType)) {
    return "Meet recording media must be video/mp4 or video/webm.";
  }
  if (input.byteSize !== undefined && input.byteSize <= 0) {
    return "Meet recording media byteSize must be greater than zero.";
  }
  if (!input.requireCompleteMetadata) {
    return null;
  }
  if (input.mimeType === undefined) {
    return "Meet recording webhook requires mimeType in prepared-upload mode.";
  }
  if (input.byteSize === undefined) {
    return "Meet recording webhook requires byteSize in prepared-upload mode.";
  }
  if (input.sha256 === undefined || input.sha256 === null) {
    return "Meet recording webhook requires sha256 in prepared-upload mode.";
  }
  return null;
}

function isSupportedRecordingMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim();
  return normalized === "video/mp4" || normalized === "video/webm";
}

function isPreparedRecordingStorageKey(storageKey: string, uploadId: string): boolean {
  const normalized = storageKey.replace(/^\/+/u, "");
  return (
    normalized.startsWith("recordings/") &&
    (normalized.endsWith(`/${uploadId}.mp4`) || normalized.endsWith(`/${uploadId}.webm`))
  );
}

async function validatePreparedRecordingObject(input: {
  readonly storage: TenantStorageClient;
  readonly storageKey: string;
  readonly uploadId: string;
  readonly orgId: string;
  readonly mimeType: string | undefined;
  readonly byteSize: number | undefined;
  readonly sha256: string | null | undefined;
}): Promise<string | null> {
  const object = await input.storage.get(input.storageKey);
  if (object === null) {
    return "Prepared Meet recording object was not found in tenant storage.";
  }
  const objectMimeType = object.contentType;
  if (objectMimeType !== undefined && !isSupportedRecordingMimeType(objectMimeType)) {
    return "Prepared Meet recording object media must be video/mp4 or video/webm.";
  }
  if (
    input.mimeType !== undefined &&
    objectMimeType !== undefined &&
    normalizedMimeType(input.mimeType) !== normalizedMimeType(objectMimeType)
  ) {
    return "Prepared Meet recording object content type does not match the webhook mimeType.";
  }
  const body = await inspectStorageObjectBody(object.body);
  const mediaSignatureValidation =
    input.mimeType === undefined ? null : validateMediaSignature(body.prefix, input.mimeType);
  if (mediaSignatureValidation !== null) {
    return mediaSignatureValidation;
  }
  if (input.byteSize !== undefined && body.byteLength !== input.byteSize) {
    return "Prepared Meet recording object byte size does not match the webhook byteSize.";
  }
  if (
    input.sha256 !== undefined &&
    input.sha256 !== null &&
    body.sha256 !== input.sha256.toLowerCase()
  ) {
    return "Prepared Meet recording object sha256 does not match the webhook sha256.";
  }
  const metadata = normalizeMetadata(object.metadata);
  const objectUploadId = metadata.uploadid;
  if (objectUploadId !== undefined && objectUploadId !== input.uploadId) {
    return "Prepared Meet recording object metadata does not match the uploadId.";
  }
  const objectOrgId = metadata.orgid;
  if (objectOrgId !== undefined && objectOrgId !== input.orgId) {
    return "Prepared Meet recording object metadata does not match the org id.";
  }
  return null;
}

async function inspectStorageObjectBody(
  body: AsyncIterable<Uint8Array> | Uint8Array,
): Promise<{ readonly byteLength: number; readonly prefix: Buffer; readonly sha256: string }> {
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
  if (body instanceof Uint8Array) {
    observe(body);
  } else {
    for await (const chunk of body) {
      observe(chunk);
    }
  }
  return {
    byteLength,
    prefix: Buffer.concat(prefixChunks.map((chunk) => Buffer.from(chunk))),
    sha256: hash.digest("hex"),
  };
}

function normalizeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function normalizedMimeType(mimeType: string): string {
  return mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
}

function validateMediaSignature(bytes: Buffer, mimeType: string): string | null {
  const normalized = normalizedMimeType(mimeType);
  const matches =
    normalized === "video/webm"
      ? bytes.byteLength >= 4 &&
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3
      : normalized === "video/mp4"
        ? bytes.byteLength >= 8 && bytes.subarray(4, 8).toString("ascii") === "ftyp"
        : true;
  return matches
    ? null
    : "Prepared Meet recording object bytes do not match the declared media type.";
}
