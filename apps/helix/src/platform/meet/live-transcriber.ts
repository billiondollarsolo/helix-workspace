/* Live transcription for LiveKit meetings. When a host turns transcription on,
   a hidden transcriber joins the room, streams each person's microphone to the
   workspace's realtime speech endpoint, saves finished lines into the meeting
   transcript, and sends captions to everyone in the call.

   It stops when the host turns it off, an administrator disables it, everyone
   leaves, the meeting ends, the speech provider fails, or after four hours. The
   transcript worker then saves the transcript to Drive and emails attendees. */

import {
  connectLiveKitTranscriberRoom,
  type ConnectTranscriberRoom,
  type TranscriberRoom,
  type TranscriberSpeaker,
} from "./livekit-transcriber-room.js";
import {
  LIVEKIT_MAX_TOKEN_TTL_SECONDS,
  liveKitRoomName,
  mintLiveKitToken,
  type LiveKitOptions,
} from "./livekit.js";
import {
  openRealtimeSpeechSession,
  SPEECH_SAMPLE_RATE,
  type OpenSpeechSession,
  type SpeechSession,
  type SpeechSettings,
} from "./realtime-speech.js";
import type { MeetTranscript, MeetTranscriptStore } from "./transcript-store.js";

/** Data-packet topic for captions and the transcribing state. */
export const MEET_CAPTIONS_TOPIC = "helix.captions";

export type MeetCaptionMessage =
  | {
      readonly v: 1;
      readonly type: "caption";
      readonly itemId: string;
      readonly speakerIdentity: string;
      readonly speakerName: string;
      readonly text: string;
      readonly final: boolean;
    }
  | { readonly v: 1; readonly type: "state"; readonly transcribing: boolean };

export interface LiveTranscriptionSettings {
  readonly enabled: boolean;
  readonly summarize: boolean;
  readonly apiKey?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly model?: string | undefined;
  readonly language?: string | undefined;
}

export interface MeetLiveTranscriberOptions {
  readonly store: Pick<
    MeetTranscriptStore,
    "begin" | "append" | "finish" | "heartbeat" | "requested" | "requestedRooms" | "clearRequested"
  >;
  readonly settings: (orgId: string) => Promise<LiveTranscriptionSettings>;
  readonly liveKit: LiveKitOptions;
  readonly connectRoom?: ConnectTranscriberRoom;
  readonly openSpeech?: OpenSpeechSession;
  readonly onError: (error: unknown) => void;
  readonly sweepMs?: number;
  readonly heartbeatMs?: number;
  /** How long the transcriber waits in a room with nobody left. */
  readonly aloneMs?: number;
  readonly maxMs?: number;
}

/** About 100 ms of audio per message to the speech provider. */
const SEND_SAMPLES = SPEECH_SAMPLE_RATE / 10;
const INTERIM_CAPTION_MS = 150;

interface ActiveTranscription {
  stop(reason: StopReason): Promise<void>;
  stopped(): boolean;
}

type StopReason = { readonly kind: "done" } | { readonly kind: "failed"; readonly message: string };

export class MeetLiveTranscriber {
  private readonly active = new Map<string, ActiveTranscription | "starting">();
  private sweepTimer: NodeJS.Timeout | undefined;
  private sweeping: Promise<void> | undefined;

  constructor(private readonly options: MeetLiveTranscriberOptions) {}

  /** Resumes requested transcriptions after a restart and polls for new ones. */
  async start(): Promise<void> {
    if (this.sweepTimer !== undefined) return;
    await this.sweep().catch(this.options.onError);
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch(this.options.onError);
    }, this.options.sweepMs ?? 15_000);
    this.sweepTimer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    await this.sweeping;
    const running = [...this.active.values()].filter(
      (entry): entry is ActiveTranscription => entry !== "starting",
    );
    await Promise.all(running.map((entry) => entry.stop({ kind: "done" })));
  }

  async sweep(): Promise<void> {
    if (this.sweeping !== undefined) return this.sweeping;
    const run = (async () => {
      for (const room of await this.options.store.requestedRooms(25))
        await this.ensure(room.orgId, room.roomId);
    })().finally(() => {
      this.sweeping = undefined;
    });
    this.sweeping = run;
    return run;
  }

  /** The host turned transcription on or off. */
  async requested(orgId: string, roomId: string, enabled: boolean): Promise<void> {
    if (enabled) {
      await this.ensure(orgId, roomId);
      return;
    }
    const entry = this.active.get(key(orgId, roomId));
    if (entry !== undefined && entry !== "starting") await entry.stop({ kind: "done" });
  }

  isActive(orgId: string, roomId: string): boolean {
    return this.active.has(key(orgId, roomId));
  }

  /** Starts transcribing the room unless it already is (here or elsewhere). */
  async ensure(orgId: string, roomId: string): Promise<void> {
    const id = key(orgId, roomId);
    if (this.active.has(id)) return;
    this.active.set(id, "starting");
    try {
      const settings = await this.options.settings(orgId);
      const speech = speechSettings(settings);
      if (speech === null) return;
      const capture = await this.options.store.begin(orgId, roomId, settings.summarize);
      if (capture === null) return;
      const running = await this.run(capture, speech).catch(async (error: unknown) => {
        this.options.onError(error);
        await this.options.store
          .finish(capture, "Live transcription could not join the meeting.")
          .catch(this.options.onError);
        await this.options.store.clearRequested(orgId, roomId).catch(this.options.onError);
        return null;
      });
      if (running !== null && !running.stopped()) {
        this.active.set(id, running);
        return;
      }
    } finally {
      if (this.active.get(id) === "starting") this.active.delete(id);
    }
  }

  private async run(capture: MeetTranscript, speech: SpeechSettings): Promise<ActiveTranscription> {
    const { store, onError } = this.options;
    const orgId = capture.org_id;
    const roomId = capture.room_id;
    const openSpeech = this.options.openSpeech ?? openRealtimeSpeechSession;
    const speakers = new Map<string, SpeechSession>();
    let room: TranscriberRoom | undefined;
    let stopping: Promise<void> | undefined;
    let saving: Promise<void> = Promise.resolve();
    let aloneTimer: NodeJS.Timeout | undefined;

    const publish = (message: MeetCaptionMessage, to?: readonly string[]) => {
      void room?.publish(MEET_CAPTIONS_TOPIC, message, to).catch(() => undefined);
    };

    const stop = (reason: StopReason): Promise<void> => {
      stopping ??= (async () => {
        clearInterval(heartbeat);
        clearTimeout(deadline);
        clearTimeout(aloneTimer);
        for (const session of speakers.values()) session.close();
        speakers.clear();
        if (room !== undefined) {
          await room
            .publish(MEET_CAPTIONS_TOPIC, { v: 1, type: "state", transcribing: false })
            .catch(() => undefined);
          await room.close().catch(onError);
        }
        await saving.catch(() => undefined);
        await store
          .finish(capture, reason.kind === "failed" ? reason.message : undefined)
          .catch(onError);
        // A failure would otherwise restart on the next sweep and fail again.
        if (reason.kind === "failed") await store.clearRequested(orgId, roomId).catch(onError);
        if (this.active.get(key(orgId, roomId)) === active) this.active.delete(key(orgId, roomId));
      })();
      return stopping;
    };
    const active: ActiveTranscription = { stop, stopped: () => stopping !== undefined };

    const transcribe = (
      speaker: TranscriberSpeaker,
      trackSid: string,
      audio: AsyncIterable<Int16Array>,
    ) => {
      const startedAt = new Map<string, Date>();
      const lastInterim = new Map<string, number>();
      const session = openSpeech(speech, {
        onText: (text) => {
          const itemId = `${trackSid}:${text.itemId}`;
          if (!startedAt.has(itemId)) startedAt.set(itemId, new Date());
          if (!text.final) {
            const now = Date.now();
            if (now - (lastInterim.get(itemId) ?? 0) < INTERIM_CAPTION_MS) return;
            lastInterim.set(itemId, now);
          }
          publish({
            v: 1,
            type: "caption",
            itemId,
            speakerIdentity: speaker.identity,
            speakerName: speaker.name,
            text: text.text,
            final: text.final,
          });
          if (!text.final) return;
          const spokenAt = startedAt.get(itemId) ?? new Date();
          startedAt.delete(itemId);
          lastInterim.delete(itemId);
          saving = saving
            .then(() => store.append(capture, { speaker: speaker.name, spokenAt, text: text.text }))
            .catch((error: unknown) => {
              onError(error);
              void stop({
                kind: "failed",
                message: error instanceof Error ? error.message : "Transcript could not be saved.",
              });
            });
        },
        onClosed: (reason) => {
          if (speakers.get(trackSid) !== session) return;
          speakers.delete(trackSid);
          if (reason !== "closed") void stop({ kind: "failed", message: reason });
        },
      });
      speakers.set(trackSid, session);
      void (async () => {
        let batch = new Int16Array(SEND_SAMPLES);
        let filled = 0;
        for await (const frame of audio) {
          if (stopping !== undefined) return;
          let offset = 0;
          while (offset < frame.length) {
            const take = Math.min(SEND_SAMPLES - filled, frame.length - offset);
            batch.set(frame.subarray(offset, offset + take), filled);
            filled += take;
            offset += take;
            if (filled === SEND_SAMPLES) {
              session.send(batch);
              batch = new Int16Array(SEND_SAMPLES);
              filled = 0;
            }
          }
        }
      })()
        .catch(onError)
        .finally(() => {
          if (speakers.get(trackSid) === session) {
            speakers.delete(trackSid);
            session.close();
          }
        });
    };

    const onPeople = (people: number) => {
      clearTimeout(aloneTimer);
      aloneTimer = undefined;
      if (people > 0) return;
      aloneTimer = setTimeout(() => {
        void stop({ kind: "done" });
      }, this.options.aloneMs ?? 15_000);
      aloneTimer.unref();
    };

    const heartbeat = setInterval(() => {
      void (async () => {
        if (stopping !== undefined) return;
        if (
          speechSettings(await this.options.settings(orgId)) === null ||
          !(await store.requested(orgId, roomId))
        ) {
          await stop({ kind: "done" });
          return;
        }
        await store.heartbeat(capture);
      })().catch(onError);
    }, this.options.heartbeatMs ?? 10_000);
    heartbeat.unref();
    const deadline = setTimeout(
      () => {
        void stop({ kind: "failed", message: "The four-hour transcription limit was reached." });
      },
      this.options.maxMs ?? 4 * 60 * 60_000,
    );
    deadline.unref();

    const roomName = liveKitRoomName(orgId, roomId);
    const { token } = mintLiveKitToken({
      apiKey: this.options.liveKit.apiKey,
      apiSecret: this.options.liveKit.apiSecret,
      identity: `TR_${capture.id}`,
      name: "Live transcription",
      room: roomName,
      grants: {
        roomAdmin: false,
        canPublish: false,
        canSubscribe: true,
        canPublishData: true,
        canPublishSources: [],
        hidden: true,
      },
      ttlSeconds: LIVEKIT_MAX_TOKEN_TTL_SECONDS,
    });
    try {
      room = await (this.options.connectRoom ?? connectLiveKitTranscriberRoom)(
        signallingUrl(this.options.liveKit.internalUrl),
        token,
        {
          onSpeakerAudio: transcribe,
          onParticipantJoined: (identity) => {
            publish({ v: 1, type: "state", transcribing: true }, [identity]);
          },
          onPeopleChanged: onPeople,
          onDisconnected: () => {
            void stop({ kind: "done" });
          },
        },
      );
    } catch (error) {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      throw error;
    }
    publish({ v: 1, type: "state", transcribing: true });
    onPeople(room.people());
    return active;
  }
}

function key(orgId: string, roomId: string): string {
  return `${orgId}:${roomId}`;
}

function speechSettings(settings: LiveTranscriptionSettings): SpeechSettings | null {
  if (!settings.enabled || !settings.apiKey || !settings.endpoint || !settings.model) return null;
  return {
    endpoint: settings.endpoint,
    apiKey: settings.apiKey,
    model: settings.model,
    language: settings.language,
  };
}

/** LiveKit's internal HTTP address, as the WebSocket address its SDKs connect to. */
export function signallingUrl(internalUrl: string): string {
  const url = new URL(internalUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href.replace(/\/$/u, "");
}
