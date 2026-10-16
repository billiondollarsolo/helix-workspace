import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import type { MeetTranscriptStore, MeetTranscript, TranscriptSegment } from "./transcript-store.js";

const roomSchema = z.object({ orgId: z.string().uuid(), roomId: z.string().uuid() });
const resultSchema = z.object({
  type: z.literal("transcription-result"),
  is_interim: z.boolean(),
  transcript: z.array(z.object({ text: z.string().max(16000) })).max(1),
  participant: z.object({ id: z.string().min(1).max(200), name: z.string().max(200).optional() }),
  timestamp: z.number().finite(),
});

export function parseTranscriptionResult(raw: string): TranscriptSegment | null {
  const parsed = resultSchema.safeParse(JSON.parse(raw));
  if (!parsed.success || parsed.data.is_interim) return null;
  const value = parsed.data;
  const text = value.transcript[0]?.text.trim();
  if (!text) return null;
  const spokenAt = new Date(value.timestamp);
  if (
    !Number.isFinite(spokenAt.getTime()) ||
    Math.abs(Date.now() - spokenAt.getTime()) > 86_400_000
  )
    throw new Error("Transcriber returned an invalid timestamp.");
  return { text, spokenAt, speaker: value.participant.name?.trim() || value.participant.id };
}

export interface MeetTranscriptionOptions {
  readonly store: Pick<
    MeetTranscriptStore,
    "requested" | "begin" | "append" | "finish" | "heartbeat"
  >;
  readonly secret: string;
  readonly proxyUrl: string;
  readonly settings: (orgId: string) => Promise<{
    enabled: boolean;
    summarize: boolean;
    apiKey?: string | undefined;
    endpoint?: string | undefined;
    model?: string | undefined;
  }>;
  readonly onError: (error: unknown) => void;
}

export function authorizedTranscriber(header: unknown, secret: string): boolean {
  if (typeof header !== "string" || secret.length < 32) return false;
  const supplied = Buffer.from(header),
    expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function registerMeetTranscriptionRoutes(
  app: FastifyInstance,
  options: MeetTranscriptionOptions,
): Promise<void> {
  app.post("/internal/meet/capture-state", { bodyLimit: 4096 }, async (request, reply) => {
    if (!authorizedTranscriber(request.headers.authorization, options.secret))
      return reply.code(401).send({ error: "Invalid capture service credential." });
    const input = roomSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "Invalid meeting identity." });
    const settings = await options.settings(input.data.orgId);
    return {
      transcription:
        settings.enabled &&
        Boolean(settings.apiKey) &&
        (await options.store.requested(input.data.orgId, input.data.roomId)),
    };
  });

  app.get("/internal/meet/transcribe", { websocket: true }, (socket, request) => {
    let upstream: WebSocket | undefined;
    let capture: MeetTranscript | undefined;
    let closed = false;
    let pending: Promise<void> = Promise.resolve();
    let pendingBytes = 0;
    let heartbeat: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const close = (reason: string) => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(deadline);
      upstream?.close();
      socket.close(1011, reason);
    };
    socket.on("error", () => {
      close("Meeting transcription connection failed.");
    });
    // Attach immediately: frames may arrive while the tenant configuration loads.
    const waiting: Buffer[] = [];
    let waitingBytes = 0;
    socket.on("message", (data, isBinary) => {
      if (closed) return;
      const bytes = frameBytes(data);
      if (isBinary || bytes.length > 512_000) {
        close("Invalid transcription frame.");
        return;
      }
      if (upstream?.readyState === WebSocket.OPEN) {
        if (upstream.bufferedAmount > 2_000_000) {
          close("Transcription connection is too slow.");
          return;
        }
        upstream.send(bytes.toString());
      } else {
        waitingBytes += bytes.length;
        if (waitingBytes > 2_000_000) {
          close("Transcription service did not become ready.");
          return;
        }
        waiting.push(bytes);
      }
    });
    socket.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(deadline);
      upstream?.close();
      void pending
        .then(async () => {
          if (capture) await options.store.finish(capture);
        })
        .catch(options.onError);
    });
    void (async () => {
      if (!authorizedTranscriber(request.headers.authorization, options.secret)) {
        close("Unauthorized transcription service.");
        return;
      }
      const input = roomSchema.safeParse(request.query);
      if (!input.success) {
        close("Invalid meeting identity.");
        return;
      }
      const { orgId, roomId } = input.data;
      const settings = await options.settings(orgId);
      if (!settings.enabled || !settings.apiKey || !settings.endpoint || !settings.model) {
        close("Transcription is not configured.");
        return;
      }
      capture = (await options.store.begin(orgId, roomId, settings.summarize)) ?? undefined;
      if (!capture || socket.readyState !== WebSocket.OPEN) {
        if (capture) await options.store.finish(capture);
        close("Transcription is already active or was not requested.");
        return;
      }
      const url = new URL("/transcribe", options.proxyUrl);
      url.searchParams.set("sessionId", capture.id);
      url.searchParams.set("provider", "openai_custom");
      url.searchParams.set("model", settings.model);
      url.searchParams.set("openaiCustomUrl", settings.endpoint);
      url.searchParams.set("sendBack", "true");
      url.searchParams.set("sendBackInterim", "true");
      upstream = new WebSocket(url, {
        headers: { "X-Custom-Openai-Api-Key": settings.apiKey },
        handshakeTimeout: 10_000,
        maxPayload: 512_000,
      });
      upstream.on("open", () => {
        for (const frame of waiting) upstream?.send(frame.toString());
        waiting.length = 0;
      });
      upstream.on("error", () => {
        close("Speech provider connection failed. Check the Meet AI provider.");
      });
      upstream.on("close", () => {
        close("Speech provider connection ended.");
      });
      upstream.on("message", (data) => {
        const raw = frameBytes(data).toString();
        if (socket.bufferedAmount > 2_000_000) {
          close("Meeting captions connection is too slow.");
          return;
        }
        try {
          const segment = parseTranscriptionResult(raw);
          if (segment && capture) {
            const current = capture;
            pendingBytes += Buffer.byteLength(raw);
            if (pendingBytes > 2_000_000) {
              close("Transcript storage is too slow.");
              return;
            }
            pending = pending
              .then(() => options.store.append(current, segment))
              .finally(() => {
                pendingBytes -= Buffer.byteLength(raw);
              });
            void pending.catch((error: unknown) => {
              options.onError(error);
              close("Transcript could not be saved.");
            });
          }
          if (socket.readyState === WebSocket.OPEN) socket.send(raw);
        } catch {
          close("Speech provider returned an invalid transcript.");
        }
      });
      heartbeat = setInterval(() => {
        void (async () => {
          if (!capture || closed) return;
          if (
            !(await options.settings(orgId)).enabled ||
            !(await options.store.requested(orgId, roomId))
          ) {
            close("Transcription stopped.");
            return;
          }
          await options.store.heartbeat(capture);
        })().catch((error: unknown) => {
          options.onError(error);
          close("Transcription authorization could not be checked.");
        });
      }, 10_000);
      heartbeat.unref();
      deadline = setTimeout(
        () => {
          close("The four-hour transcription limit was reached.");
        },
        4 * 60 * 60_000,
      );
      deadline.unref();
    })().catch((error: unknown) => {
      options.onError(error);
      close("Meeting transcription could not start.");
    });
  });
}

function frameBytes(data: RawData): Buffer {
  return Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
}
