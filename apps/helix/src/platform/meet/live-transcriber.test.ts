import { describe, expect, it, vi } from "vitest";
import type {
  ConnectTranscriberRoom,
  TranscriberRoomHandlers,
} from "./livekit-transcriber-room.js";
import {
  MeetLiveTranscriber,
  signallingUrl,
  type LiveTranscriptionSettings,
} from "./live-transcriber.js";
import type { OpenSpeechSession, SpeechSessionHandlers } from "./realtime-speech.js";
import type { MeetTranscript, TranscriptSegment } from "./transcript-store.js";

const ORG = "org-1";
const ROOM = "room-1";
const settings: LiveTranscriptionSettings = {
  enabled: true,
  summarize: false,
  apiKey: "sk-test",
  endpoint: "wss://api.openai.com/v1/realtime?intent=transcription",
  model: "gpt-4o-transcribe",
};

function capture(): MeetTranscript {
  return {
    id: "cap-1",
    org_id: ORG,
    room_id: ROOM,
    owner_actor_id: "host",
    status: "capturing",
    started_at: new Date(),
    ended_at: null,
    attempts: 0,
    error: null,
    transcript_object_id: null,
    summary_object_id: null,
    summary_requested: false,
  };
}

function setup(options: { people?: number; current?: () => LiveTranscriptionSettings } = {}) {
  const segments: TranscriptSegment[] = [];
  let requested = true;
  const store = {
    begin: vi.fn(async () => capture()),
    append: vi.fn(async (_capture: MeetTranscript, segment: TranscriptSegment) => {
      segments.push(segment);
    }),
    finish: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    requested: vi.fn(async () => requested),
    requestedRooms: vi.fn(async () => [{ orgId: ORG, roomId: ROOM }]),
    clearRequested: vi.fn(async () => {
      requested = false;
    }),
  };
  const published: { topic: string; message: object; to?: readonly string[] }[] = [];
  const room = {
    handlers: undefined as TranscriberRoomHandlers | undefined,
    url: "",
    token: "",
    closed: false,
    people: options.people ?? 1,
  };
  const connectRoom: ConnectTranscriberRoom = async (url, token, handlers) => {
    room.url = url;
    room.token = token;
    room.handlers = handlers;
    return {
      people: () => room.people,
      publish: async (topic, message, to) => {
        published.push({ topic, message, ...(to === undefined ? {} : { to }) });
      },
      close: async () => {
        room.closed = true;
      },
    };
  };
  const speech: { handlers: SpeechSessionHandlers; sent: Int16Array[]; closed: boolean }[] = [];
  const openSpeech: OpenSpeechSession = (_settings, handlers) => {
    const session = { handlers, sent: [] as Int16Array[], closed: false };
    speech.push(session);
    return {
      send: (pcm) => session.sent.push(pcm),
      close: () => {
        session.closed = true;
      },
    };
  };
  const errors: unknown[] = [];
  const transcriber = new MeetLiveTranscriber({
    store,
    settings: async () => options.current?.() ?? settings,
    liveKit: {
      apiKey: "key",
      apiSecret: "secret-secret-secret-secret-secret",
      publicUrl: "wss://workspace.example.test",
      internalUrl: "http://livekit:7880",
    },
    connectRoom,
    openSpeech,
    onError: (error) => errors.push(error),
    heartbeatMs: 20,
    aloneMs: 30,
  });
  return {
    transcriber,
    store,
    room,
    published,
    speech,
    segments,
    errors,
    stopRequest: () => {
      requested = false;
    },
  };
}

async function* frames(...chunks: Int16Array[]) {
  for (const chunk of chunks) yield chunk;
}
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("live transcriber", () => {
  it("joins hidden, streams each speaker, saves final lines and sends captions", async () => {
    const t = setup();
    await t.transcriber.requested(ORG, ROOM, true);
    expect(t.transcriber.isActive(ORG, ROOM)).toBe(true);
    expect(t.room.url).toBe("ws://livekit:7880");
    const grant = JSON.parse(
      Buffer.from(t.room.token.split(".")[1] ?? "", "base64url").toString(),
    ) as { sub: string; video: { hidden?: boolean; canPublish: boolean; canSubscribe: boolean } };
    expect(grant.sub).toBe("TR_cap-1");
    expect(grant.video).toMatchObject({ hidden: true, canPublish: false, canSubscribe: true });
    expect(t.published[0]).toEqual({
      topic: "helix.captions",
      message: { v: 1, type: "state", transcribing: true },
    });

    // 150 ms of audio in 10 ms frames goes out as one 100 ms batch.
    t.room.handlers?.onSpeakerAudio(
      { identity: "u1", name: "Hana" },
      "TR_mic",
      frames(...Array.from({ length: 15 }, () => new Int16Array(240).fill(7))),
    );
    await wait();
    expect(t.speech[0]?.sent.map((chunk) => chunk.length)).toEqual([2400]);

    t.speech[0]?.handlers.onText({ itemId: "a", text: "Hello", final: false });
    t.speech[0]?.handlers.onText({ itemId: "a", text: "Hello there.", final: true });
    await wait();
    expect(t.segments).toEqual([
      expect.objectContaining({ speaker: "Hana", text: "Hello there." }),
    ]);
    expect(t.published.slice(1).map((entry) => entry.message)).toEqual([
      {
        v: 1,
        type: "caption",
        itemId: "TR_mic:a",
        speakerIdentity: "u1",
        speakerName: "Hana",
        text: "Hello",
        final: false,
      },
      {
        v: 1,
        type: "caption",
        itemId: "TR_mic:a",
        speakerIdentity: "u1",
        speakerName: "Hana",
        text: "Hello there.",
        final: true,
      },
    ]);

    t.room.handlers?.onParticipantJoined("u2");
    expect(t.published.at(-1)).toEqual({
      topic: "helix.captions",
      message: { v: 1, type: "state", transcribing: true },
      to: ["u2"],
    });

    await t.transcriber.requested(ORG, ROOM, false);
    expect(t.room.closed).toBe(true);
    expect(t.speech[0]?.closed).toBe(true);
    expect(t.store.finish).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cap-1" }),
      undefined,
    );
    expect(t.store.clearRequested).not.toHaveBeenCalled();
    expect(t.published.at(-1)?.message).toEqual({ v: 1, type: "state", transcribing: false });
    expect(t.transcriber.isActive(ORG, ROOM)).toBe(false);
  });

  it("doesn't start when transcription is off or already captured elsewhere", async () => {
    const off = setup({ current: () => ({ enabled: false, summarize: false }) });
    await off.transcriber.ensure(ORG, ROOM);
    expect(off.store.begin).not.toHaveBeenCalled();

    const elsewhere = setup();
    elsewhere.store.begin.mockResolvedValueOnce(null as never);
    await elsewhere.transcriber.ensure(ORG, ROOM);
    expect(elsewhere.room.handlers).toBeUndefined();
    expect(elsewhere.transcriber.isActive(ORG, ROOM)).toBe(false);
  });

  it("stops when the host's request goes away, and leaves an empty room", async () => {
    const t = setup();
    await t.transcriber.sweep();
    expect(t.transcriber.isActive(ORG, ROOM)).toBe(true);
    t.stopRequest();
    await wait(60);
    expect(t.room.closed).toBe(true);
    expect(t.transcriber.isActive(ORG, ROOM)).toBe(false);

    const empty = setup({ people: 0 });
    await empty.transcriber.ensure(ORG, ROOM);
    await wait(60);
    expect(empty.room.closed).toBe(true);
  });

  it("stops with the provider's error and turns the request off so it doesn't loop", async () => {
    const t = setup();
    await t.transcriber.ensure(ORG, ROOM);
    t.room.handlers?.onSpeakerAudio({ identity: "u1", name: "Hana" }, "mic", frames());
    t.speech[0]?.handlers.onClosed("Speech provider error: invalid key");
    await wait();
    expect(t.store.finish).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cap-1" }),
      "Speech provider error: invalid key",
    );
    expect(t.store.clearRequested).toHaveBeenCalledWith(ORG, ROOM);
    expect(t.transcriber.isActive(ORG, ROOM)).toBe(false);
  });

  it("records a failure when it can't join the room", async () => {
    const t = setup();
    const failing = new MeetLiveTranscriber({
      store: t.store,
      settings: async () => settings,
      liveKit: {
        apiKey: "k",
        apiSecret: "s",
        publicUrl: "wss://x",
        internalUrl: "http://livekit:7880",
      },
      connectRoom: async () => {
        throw new Error("connection refused");
      },
      onError: () => undefined,
    });
    await failing.ensure(ORG, ROOM);
    expect(t.store.finish).toHaveBeenCalledWith(
      expect.anything(),
      "Live transcription could not join the meeting.",
    );
    expect(t.store.clearRequested).toHaveBeenCalled();
    expect(failing.isActive(ORG, ROOM)).toBe(false);
  });

  it("uses LiveKit's internal address for signalling", () => {
    expect(signallingUrl("https://livekit.internal:7880/")).toBe("wss://livekit.internal:7880");
  });
});
