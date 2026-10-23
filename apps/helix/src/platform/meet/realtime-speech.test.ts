import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { openRealtimeSpeechSession, type SpeechText } from "./realtime-speech.js";

let server: WebSocketServer | undefined;
afterEach(async () => {
  const current = server;
  server = undefined;
  if (current === undefined) return;
  await new Promise<void>((resolve) => {
    current.close(() => {
      resolve();
    });
  });
});

async function fakeProvider(reply: (message: { type: string }, socket: WebSocket) => void) {
  const received: { type: string; [key: string]: unknown }[] = [];
  const headers: string[] = [];
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (socket, request) => {
    headers.push(String(request.headers.authorization));
    socket.on("message", (data) => {
      const message = JSON.parse(Buffer.from(data as Buffer).toString()) as { type: string };
      received.push(message);
      reply(message, socket);
    });
  });
  await new Promise((resolve) => server?.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `ws://127.0.0.1:${String(port)}/v1/realtime?intent=transcription`,
    received,
    headers,
  };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe("realtime speech session", () => {
  it("configures transcription, streams audio and reports interim and final text", async () => {
    const provider = await fakeProvider((message, socket) => {
      if (message.type === "session.update")
        socket.send(JSON.stringify({ type: "session.updated" }));
      if (message.type === "input_audio_buffer.append") {
        socket.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.delta",
            item_id: "i1",
            delta: "Hello",
          }),
        );
        socket.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.delta",
            item_id: "i1",
            delta: " there",
          }),
        );
        socket.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "i1",
            transcript: " Hello there. ",
          }),
        );
      }
    });
    const texts: SpeechText[] = [];
    const session = openRealtimeSpeechSession(
      {
        endpoint: provider.endpoint,
        apiKey: "sk-test",
        model: "gpt-4o-transcribe",
        language: "en",
      },
      { onText: (text) => texts.push(text), onClosed: () => undefined },
    );
    session.send(new Int16Array([1, -1, 2]));
    await until(() => texts.length === 3);
    session.close();

    expect(provider.headers).toEqual(["Bearer sk-test"]);
    expect(provider.received[0]).toMatchObject({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: { model: "gpt-4o-transcribe", language: "en" },
          },
        },
      },
    });
    expect(provider.received[1]).toEqual({
      type: "input_audio_buffer.append",
      audio: Buffer.from(new Int16Array([1, -1, 2]).buffer).toString("base64"),
    });
    expect(texts).toEqual([
      { itemId: "i1", text: "Hello", final: false },
      { itemId: "i1", text: "Hello there", final: false },
      { itemId: "i1", text: "Hello there.", final: true },
    ]);
  });

  it("falls back to the beta session message once, then reports provider errors", async () => {
    const provider = await fakeProvider((message, socket) => {
      socket.send(
        JSON.stringify({ type: "error", error: { message: `unsupported ${message.type}` } }),
      );
    });
    const closed: string[] = [];
    openRealtimeSpeechSession(
      { endpoint: provider.endpoint, apiKey: "sk-test", model: "whisper-1" },
      { onText: () => undefined, onClosed: (reason) => closed.push(reason) },
    );
    await until(() => closed.length === 1);
    expect(provider.received.map((message) => message.type)).toEqual([
      "session.update",
      "transcription_session.update",
    ]);
    expect(provider.received[1]).toMatchObject({
      session: { input_audio_format: "pcm16", input_audio_transcription: { model: "whisper-1" } },
    });
    expect(closed[0]).toBe("Speech provider error: unsupported transcription_session.update");
  });

  it("reports a provider it can't reach", async () => {
    const closed: string[] = [];
    openRealtimeSpeechSession(
      { endpoint: "ws://127.0.0.1:1/v1/realtime", apiKey: "sk-test", model: "m" },
      { onText: () => undefined, onClosed: (reason) => closed.push(reason) },
    );
    await until(() => closed.length === 1);
    expect(closed[0]).toContain("Speech provider connection failed");
  });
});
