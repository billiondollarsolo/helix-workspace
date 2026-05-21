import type { FastifyInstance } from "fastify";
import type { JsonObject } from "@helix/sdk-types";
import { z } from "zod";
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
    metadata: z.record(z.unknown()).default({}),
  })
  .passthrough();

export interface RegisterMeetRoutesOptions {
  readonly store: MeetStore;
  readonly webhookSecret: string;
  readonly defaultOrgId?: string | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}

export async function registerMeetRoutes(
  app: FastifyInstance,
  options: RegisterMeetRoutesOptions,
): Promise<void> {
  app.post("/webhook/jitsi", async (request, reply) => {
    const receivedSecret =
      request.headers["x-helix-jitsi-secret"] ?? request.headers["x-jitsi-secret"];
    if (options.webhookSecret.length > 0 && receivedSecret !== options.webhookSecret) {
      return reply.code(401).send({ error: "Invalid Jitsi webhook secret." });
    }

    try {
      const body = jitsiWebhookSchema.parse(request.body);
      const event = body.event ?? body.eventName ?? body.event_name ?? body.type ?? "";
      if (!isRecordingEvent(event)) {
        return { ok: true, ignored: true, event };
      }
      const orgId = request.headers["x-helix-org-id"];
      const storageKey =
        body.storageKey ?? body.storage_key ?? body.fileKey ?? body.file_key ?? body.url;
      const roomId = body.roomId ?? body.room_id;
      const roomName = body.roomName ?? body.room_name ?? body.room;
      const byteSize = body.byteSize ?? body.byte_size ?? body.size;
      const mimeType = body.mimeType ?? body.mime_type;
      const startedAt = body.startedAt ?? body.started_at;
      const endedAt = body.endedAt ?? body.ended_at;
      if (storageKey === undefined) {
        return await reply
          .code(400)
          .send({ error: "Jitsi recording webhook requires storageKey, fileKey, or url." });
      }
      const attachment = await options.store.attachRecording({
        orgId:
          typeof orgId === "string"
            ? orgId
            : (options.defaultOrgId ?? "00000000-0000-0000-0000-000000000000"),
        ...(roomId === undefined ? {} : { roomId }),
        ...(roomName === undefined ? {} : { roomName }),
        storageKey,
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(byteSize === undefined ? {} : { byteSize }),
        ...(body.sha256 === undefined ? {} : { sha256: body.sha256 }),
        startedAt: startedAt === undefined || startedAt === null ? null : new Date(startedAt),
        endedAt: endedAt === undefined || endedAt === null ? null : new Date(endedAt),
        metadata: toJsonObject({ event, ...body.metadata }),
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
