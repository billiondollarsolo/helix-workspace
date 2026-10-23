/* The transcriber's seat in a LiveKit room, on @livekit/rtc-node. It joins as a
   hidden participant, hands each person's microphone audio (24 kHz mono) to the
   transcriber, and publishes captions as data packets. The native SDK loads on
   first use, so the API starts on hosts where no meeting is ever transcribed. */

import { SPEECH_SAMPLE_RATE } from "./realtime-speech.js";

export interface TranscriberSpeaker {
  readonly identity: string;
  readonly name: string;
}

export interface TranscriberRoomHandlers {
  /** A microphone track to transcribe; the iterable ends when it goes away. */
  readonly onSpeakerAudio: (
    speaker: TranscriberSpeaker,
    trackSid: string,
    audio: AsyncIterable<Int16Array>,
  ) => void;
  /** Someone joined; used to tell late joiners that transcription is on. */
  readonly onParticipantJoined: (identity: string) => void;
  /** The number of people present changed (agents and recorders aren't people). */
  readonly onPeopleChanged: (people: number) => void;
  readonly onDisconnected: () => void;
}

export interface TranscriberRoom {
  readonly people: () => number;
  readonly publish: (
    topic: string,
    message: object,
    destinationIdentities?: readonly string[],
  ) => Promise<void>;
  readonly close: () => Promise<void>;
}

export type ConnectTranscriberRoom = (
  url: string,
  token: string,
  handlers: TranscriberRoomHandlers,
) => Promise<TranscriberRoom>;

/** Recorders (EG_) and transcribers (TR_) sit in rooms without being people. */
export function isMeetAgentIdentity(identity: string): boolean {
  return identity.startsWith("EG_") || identity.startsWith("TR_");
}

export const connectLiveKitTranscriberRoom: ConnectTranscriberRoom = async (
  url,
  token,
  handlers,
) => {
  const rtc = await import("@livekit/rtc-node");
  const room = new rtc.Room();
  const people = () =>
    [...room.remoteParticipants.values()].filter(
      (participant) => !isMeetAgentIdentity(participant.identity),
    ).length;
  // Streams cancel when their track is unsubscribed or the room closes.
  const readers = new Map<string, ReadableStreamDefaultReader<{ data: Int16Array }>>();

  room.on(rtc.RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (
      publication.source !== rtc.TrackSource.SOURCE_MICROPHONE ||
      isMeetAgentIdentity(participant.identity) ||
      publication.sid === undefined
    )
      return;
    const sid = publication.sid;
    const reader = new rtc.AudioStream(track, SPEECH_SAMPLE_RATE, 1).getReader();
    readers.set(sid, reader);
    handlers.onSpeakerAudio(
      { identity: participant.identity, name: participant.name?.trim() || participant.identity },
      sid,
      (async function* () {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            // Nothing is sent for a muted microphone, so silence isn't billed.
            if (publication.muted !== true) yield value.data;
          }
        } finally {
          reader.releaseLock();
          if (readers.get(sid) === reader) readers.delete(sid);
        }
      })(),
    );
  });
  room.on(rtc.RoomEvent.TrackUnsubscribed, (_track, publication) => {
    if (publication.sid === undefined) return;
    void readers
      .get(publication.sid)
      ?.cancel()
      .catch(() => undefined);
  });
  room.on(rtc.RoomEvent.ParticipantConnected, (participant) => {
    if (!isMeetAgentIdentity(participant.identity))
      handlers.onParticipantJoined(participant.identity);
    handlers.onPeopleChanged(people());
  });
  room.on(rtc.RoomEvent.ParticipantDisconnected, () => {
    handlers.onPeopleChanged(people());
  });
  room.on(rtc.RoomEvent.Disconnected, () => {
    handlers.onDisconnected();
  });

  await room.connect(url, token, { autoSubscribe: true, dynacast: false });
  const encoder = new TextEncoder();
  return {
    people,
    async publish(topic, message, destinationIdentities) {
      await room.localParticipant?.publishData(encoder.encode(JSON.stringify(message)), {
        reliable: true,
        topic,
        ...(destinationIdentities === undefined
          ? {}
          : { destination_identities: [...destinationIdentities] }),
      });
    },
    async close() {
      for (const reader of readers.values()) await reader.cancel().catch(() => undefined);
      readers.clear();
      await room.disconnect();
    },
  };
};
