/* One speaker's live transcription over the OpenAI realtime transcription
   protocol (also served by compatible self-hosted speech services). Audio goes
   in as 24 kHz mono PCM16; text comes back as interim deltas and a final line
   per utterance, which the server splits on pauses. */

import WebSocket, { type RawData } from "ws";

export const SPEECH_SAMPLE_RATE = 24_000;

export interface SpeechSettings {
  /** wss URL of the realtime endpoint, already allowlisted. */
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  /** ISO-639-1 hint, e.g. "en"; omitted lets the model detect it. */
  readonly language?: string | undefined;
}

export interface SpeechText {
  readonly itemId: string;
  /** Interim: the utterance so far. Final: the finished line. */
  readonly text: string;
  readonly final: boolean;
}

export interface SpeechSession {
  send(pcm: Int16Array): void;
  close(): void;
}

export interface SpeechSessionHandlers {
  readonly onText: (text: SpeechText) => void;
  /** The connection ended or failed; the session is unusable afterwards. */
  readonly onClosed: (reason: string) => void;
}

export type OpenSpeechSession = (
  settings: SpeechSettings,
  handlers: SpeechSessionHandlers,
) => SpeechSession;

const MAX_BUFFERED_BYTES = 1_000_000;
const MAX_PENDING_SAMPLES = SPEECH_SAMPLE_RATE * 10;

export const openRealtimeSpeechSession: OpenSpeechSession = (settings, handlers) => {
  const socket = new WebSocket(settings.endpoint, {
    headers: { authorization: `Bearer ${settings.apiKey}` },
    handshakeTimeout: 10_000,
    maxPayload: 512_000,
  });
  let closed = false;
  let configured = false;
  let triedLegacy = false;
  // Audio that arrives before the connection opens, capped at ten seconds.
  let pending: Int16Array[] = [];
  let pendingSamples = 0;
  const interim = new Map<string, string>();

  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    pending = [];
    socket.removeAllListeners();
    socket.on("error", () => undefined);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
      socket.terminate();
    handlers.onClosed(reason);
  };
  const sendJson = (message: object) => {
    socket.send(JSON.stringify(message));
  };
  const sendAudio = (pcm: Int16Array) => {
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      finish("Speech provider is too slow.");
      return;
    }
    sendJson({
      type: "input_audio_buffer.append",
      audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"),
    });
  };

  socket.on("open", () => {
    sendJson(speechSessionUpdate(settings));
    for (const chunk of pending) sendAudio(chunk);
    pending = [];
    pendingSamples = 0;
  });
  socket.on("message", (data) => {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(rawText(data)) as RealtimeEvent;
    } catch {
      finish("Speech provider sent an unreadable message.");
      return;
    }
    switch (event.type) {
      case "session.created":
      case "transcription_session.created":
        return;
      case "session.updated":
      case "transcription_session.updated":
        configured = true;
        return;
      case "conversation.item.input_audio_transcription.delta": {
        if (typeof event.item_id !== "string" || typeof event.delta !== "string") return;
        const text = `${interim.get(event.item_id) ?? ""}${event.delta}`.slice(-4_000);
        interim.set(event.item_id, text);
        handlers.onText({ itemId: event.item_id, text, final: false });
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        if (typeof event.item_id !== "string") return;
        interim.delete(event.item_id);
        const text = typeof event.transcript === "string" ? event.transcript.trim() : "";
        if (text) handlers.onText({ itemId: event.item_id, text, final: true });
        return;
      }
      case "error": {
        // Older and self-hosted servers only know the beta session message.
        if (!configured && !triedLegacy) {
          triedLegacy = true;
          sendJson(legacySpeechSessionUpdate(settings));
          return;
        }
        const message = typeof event.error?.message === "string" ? event.error.message : "";
        finish(`Speech provider error${message ? `: ${message.slice(0, 200)}` : "."}`);
        return;
      }
      default:
        return;
    }
  });
  socket.on("error", () => {
    finish("Speech provider connection failed. Check the Meet AI provider.");
  });
  socket.on("close", () => {
    finish("Speech provider connection ended.");
  });

  return {
    send(pcm) {
      if (closed) return;
      if (socket.readyState === WebSocket.OPEN) {
        sendAudio(pcm);
        return;
      }
      if (pendingSamples + pcm.length > MAX_PENDING_SAMPLES) return;
      pending.push(pcm);
      pendingSamples += pcm.length;
    },
    close() {
      finish("closed");
    },
  };
};

interface RealtimeEvent {
  readonly type?: string;
  readonly item_id?: unknown;
  readonly delta?: unknown;
  readonly transcript?: unknown;
  readonly error?: { readonly message?: unknown };
}

const turnDetection = {
  type: "server_vad",
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 500,
};

export function speechSessionUpdate(settings: SpeechSettings) {
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: SPEECH_SAMPLE_RATE },
          noise_reduction: { type: "near_field" },
          transcription: transcriptionModel(settings),
          turn_detection: turnDetection,
        },
      },
    },
  };
}

export function legacySpeechSessionUpdate(settings: SpeechSettings) {
  return {
    type: "transcription_session.update",
    session: {
      input_audio_format: "pcm16",
      input_audio_noise_reduction: { type: "near_field" },
      input_audio_transcription: transcriptionModel(settings),
      turn_detection: turnDetection,
    },
  };
}

function transcriptionModel(settings: SpeechSettings) {
  return {
    model: settings.model,
    ...(settings.language ? { language: settings.language } : {}),
  };
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString();
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return Buffer.from(data).toString();
}
