import type { IncomingMessage } from "node:http";
import { once } from "node:events";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket, { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { registerMeetTranscriptionRoutes, type MeetTranscriptionOptions } from "./transcription.js";
import type { MeetTranscript } from "./transcript-store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const roomId = "22222222-2222-4222-8222-222222222222";
const secret = "test-service-secret-".repeat(3);
const capture: MeetTranscript = {
  id: "33333333-3333-4333-8333-333333333333",
  org_id: orgId,
  room_id: roomId,
  owner_actor_id: "44444444-4444-4444-8444-444444444444",
  status: "capturing",
  started_at: new Date(),
  ended_at: null,
  attempts: 0,
  error: null,
  transcript_object_id: null,
  summary_object_id: null,
  summary_requested: false,
};

it("passes the selected speech model and private credentials to the proxy and stores final captions", async () => {
  const proxy = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(proxy, "listening");
  const address = proxy.address();
  if (typeof address === "string" || !address) throw new Error("No proxy address");
  const store: MeetTranscriptionOptions["store"] = {
    requested: vi.fn(async () => true),
    begin: vi.fn(async () => capture),
    append: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
  };
  const app = Fastify();
  await app.register(websocket);
  await registerMeetTranscriptionRoutes(app, {
    store,
    secret,
    proxyUrl: `ws://127.0.0.1:${String(address.port)}`,
    settings: async () => ({
      enabled: true,
      summarize: false,
      apiKey: "speech-secret",
      endpoint: "wss://speech.example/v1/realtime?intent=transcription",
      model: "selected-speech-model",
    }),
    onError: (error) => {
      throw error;
    },
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const connected = new Promise<{ upstream: WebSocket; request: IncomingMessage }>((resolve) => {
      proxy.once("connection", (upstream, request) => {
        resolve({ upstream, request });
      });
    });
    const socket = new WebSocket(
      `${baseUrl.replace("http:", "ws:")}/internal/meet/transcribe?orgId=${orgId}&roomId=${roomId}`,
      {
        headers: { authorization: `Bearer ${secret}` },
      },
    );
    await once(socket, "open");
    const { upstream, request } = await connected;
    const url = new URL(request.url ?? "", "http://proxy");
    expect(url.searchParams.get("model")).toBe("selected-speech-model");
    expect(url.searchParams.get("provider")).toBe("openai_custom");
    expect(request.headers["x-custom-openai-api-key"]).toBe("speech-secret");
    expect(url.href).not.toContain("speech-secret");
    expect(store.begin).toHaveBeenCalledWith(orgId, roomId, false);
    const result = {
      type: "transcription-result",
      is_interim: false,
      transcript: [{ text: "A fictional meeting caption." }],
      participant: { id: "person", name: "Speaker" },
      timestamp: Date.now(),
    };
    const caption = once(socket, "message");
    upstream.send(JSON.stringify(result));
    await caption;
    await vi.waitFor(() => {
      expect(store.append).toHaveBeenCalledWith(capture, {
        text: "A fictional meeting caption.",
        speaker: "Speaker",
        spokenAt: new Date(result.timestamp),
      });
    });
    socket.close();
    await vi.waitFor(() => {
      expect(store.finish).toHaveBeenCalledWith(capture);
    });
    const denied = await app.inject({
      method: "POST",
      url: "/internal/meet/capture-state",
      payload: { orgId, roomId },
    });
    expect(denied.statusCode).toBe(401);
  } finally {
    for (const client of proxy.clients) client.terminate();
    await app.close();
    await new Promise<void>((resolve, reject) => {
      proxy.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
