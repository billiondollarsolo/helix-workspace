/* LiveKit call: connects a Room with the server URL and access token from the
 * join response, publishes the pre-join microphone and camera choices, and
 * exposes call state + commands (see meet-call-controls.ts) plus the media
 * tracks the video grid attaches. Participant identity and room come from the
 * token; host controls are enforced server-side, never here. */

import {
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type AudioCaptureOptions,
  type Participant,
  type RemoteParticipant,
  type VideoCaptureOptions,
} from "livekit-client";
import { useEffect, useRef, useState } from "react";
import { randomId } from "@/lib/random-id";
import type { MeetTelemetryEvent } from "./api";
import {
  announceRecordingStarted,
  appendChat,
  MAX_CHAT_MESSAGE_LENGTH,
  type MeetCallCallbacks,
  type MeetCallCapabilities,
  type MeetCallCommands,
  type MeetCallControls,
  type MeetCallParticipant,
  type MeetCallState,
  type MeetInitialMedia,
} from "./meet-call-controls";

// ---- Public types ----

export interface LiveKitCallOptions {
  /** Bare LiveKit websocket origin, e.g. `wss://workspace.example.com`. */
  readonly serverUrl: string;
  /** LiveKit access token minted by Workspace for this participant. */
  readonly token: string;
  /** Fallback label for the local participant when the token carries no name. */
  readonly displayName: string;
  readonly initialRecordingActive: boolean;
  readonly media: MeetInitialMedia;
}

export interface UseLiveKitCallParams extends MeetCallCallbacks {
  /** When non-null, connect; null (or a change of url/token) disconnects. */
  readonly options: LiveKitCallOptions | null;
  /** The server says someone started waiting in the lobby (hosts only receive it). */
  readonly onLobbyWaiting?: () => void;
}

/** One video tile: a participant camera (or avatar) or a screen share. */
export interface MeetMediaTile {
  readonly key: string;
  readonly participantId: string;
  readonly name: string;
  readonly isLocal: boolean;
  readonly isScreenShare: boolean;
  /** Null while the camera is off or the track is not subscribed yet. */
  readonly videoTrack: Track | null;
  readonly audioMuted: boolean;
  readonly speaking: boolean;
  readonly handRaised: boolean;
}

export interface MeetMediaView {
  readonly tiles: readonly MeetMediaTile[];
  /** Remote audio to play (microphones and screen-share audio). */
  readonly audioTracks: readonly { readonly key: string; readonly track: Track }[];
  /** The browser blocked autoplay; a user gesture must call `startAudio`. */
  readonly audioPlaybackBlocked: boolean;
}

export interface LiveKitCallCommands extends MeetCallCommands {
  /** Resume remote audio after the browser blocked autoplay. */
  startAudio: () => void;
}

export interface LiveKitCallControls extends MeetCallControls {
  readonly commands: LiveKitCallCommands;
  readonly media: MeetMediaView;
}

// ---- Constants ----

export const LIVEKIT_CAPABILITIES: MeetCallCapabilities = {
  chat: true,
  raiseHand: true,
  screenShare: true,
  tileView: true,
  noiseSuppression: true,
};

const EMPTY_CAPABILITIES: MeetCallCapabilities = {
  chat: false,
  raiseHand: false,
  screenShare: false,
  tileView: false,
  noiseSuppression: false,
};

const EMPTY_STATE: MeetCallState = {
  isReady: false,
  isJoined: false,
  audioMuted: false,
  videoMuted: false,
  screenSharing: false,
  handRaised: false,
  capabilities: EMPTY_CAPABILITIES,
  tileView: true,
  noiseSuppressionEnabled: null,
  recordingActive: false,
  participants: [],
  activeSpeakerId: null,
  chatMessages: [],
  unreadChatCount: 0,
  loadError: null,
};

const EMPTY_MEDIA: MeetMediaView = { tiles: [], audioTracks: [], audioPlaybackBlocked: false };

/** Data-channel topic for in-call chat; payload is JSON `{ id, text }`. */
export const CHAT_TOPIC = "chat";
/** Data topic the server uses to tell hosts the lobby changed. */
export const LOBBY_TOPIC = "helix.lobby";
/** Participant attribute carrying the raised hand. */
export const HAND_ATTRIBUTE = "hand";
const HAND_RAISED = "raised";
const QUALITY_SAMPLE_INTERVAL_MS = 10_000;
const MAX_CHAT_ID_LENGTH = 100;

/** Events after which the participant/track snapshot is recomputed. */
const SNAPSHOT_EVENTS = [
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.ActiveSpeakersChanged,
  RoomEvent.ParticipantAttributesChanged,
  RoomEvent.ParticipantNameChanged,
  RoomEvent.AudioPlaybackStatusChanged,
  RoomEvent.ParticipantPermissionsChanged,
] as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---- Hook ----

export function useLiveKitCall({
  options,
  onLeft,
  onTelemetry,
  onLobbyWaiting,
}: UseLiveKitCallParams): LiveKitCallControls {
  const [state, setState] = useState<MeetCallState>(EMPTY_STATE);
  const [media, setMedia] = useState<MeetMediaView>(EMPTY_MEDIA);
  const roomRef = useRef<Room | null>(null);
  const syncRef = useRef<() => void>(() => undefined);
  const audioCaptureRef = useRef<AudioCaptureOptions>({});
  const chatOpenRef = useRef(false);
  // Latest callbacks and labels, read by long-lived room listeners without
  // reconnecting when the parent rebinds them.
  const onLeftRef = useRef(onLeft);
  onLeftRef.current = onLeft;
  const onTelemetryRef = useRef(onTelemetry);
  onTelemetryRef.current = onTelemetry;
  const onLobbyWaitingRef = useRef(onLobbyWaiting);
  onLobbyWaitingRef.current = onLobbyWaiting;
  const displayNameRef = useRef(options?.displayName ?? "You");
  displayNameRef.current = options?.displayName ?? displayNameRef.current;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const serverUrl = options?.serverUrl ?? null;
  const token = options?.token ?? null;

  useEffect(() => {
    const current = optionsRef.current;
    if (serverUrl === null || token === null || current === null) return;
    const initial = current.media;
    let disposed = false;
    let joined = false;
    let lastQualityAt = 0;
    const joinStartedAt = performance.now();
    const telemetry = (event: MeetTelemetryEvent) => onTelemetryRef.current?.(event);

    const audioCapture: AudioCaptureOptions = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(initial.audioInputId === null ? {} : { deviceId: { ideal: initial.audioInputId } }),
    };
    const videoCapture: VideoCaptureOptions =
      initial.videoInputId === null ? {} : { deviceId: { ideal: initial.videoInputId } };
    audioCaptureRef.current = audioCapture;

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: audioCapture,
      videoCaptureDefaults: videoCapture,
    });
    roomRef.current = room;
    chatOpenRef.current = false;

    setState({
      ...EMPTY_STATE,
      isReady: true,
      capabilities: LIVEKIT_CAPABILITIES,
      audioMuted: initial.audioMuted,
      videoMuted: initial.videoMuted,
      noiseSuppressionEnabled: true,
      recordingActive: current.initialRecordingActive,
    });
    setMedia(EMPTY_MEDIA);
    if (current.initialRecordingActive) announceRecordingStarted();

    const sync = () => {
      if (disposed || !joined) return;
      const snapshot = snapshotRoom(room, displayNameRef.current);
      setState((prev) => ({ ...prev, ...snapshot.state }));
      setMedia(snapshot.media);
    };
    syncRef.current = sync;
    for (const event of SNAPSHOT_EVENTS) room.on(event, sync);

    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (disposed) return;
      joined = false;
      setState((prev) => ({ ...prev, isJoined: false }));
      if (
        reason === DisconnectReason.CLIENT_INITIATED ||
        reason === DisconnectReason.PARTICIPANT_REMOVED ||
        reason === DisconnectReason.ROOM_DELETED
      ) {
        onLeftRef.current?.();
        return;
      }
      setState((prev) => ({
        ...prev,
        loadError: "The connection to the meeting was lost. Leave and join again.",
      }));
    });

    // LiveKit marks the room as recording while Egress runs, so every
    // participant sees recording start and stop live.
    let recordingActive = current.initialRecordingActive;
    const setRecording = (recording: boolean) => {
      if (disposed || recording === recordingActive) return;
      recordingActive = recording;
      if (recording) announceRecordingStarted();
      setState((prev) => ({ ...prev, recordingActive: recording }));
    };
    room.on(RoomEvent.RecordingStatusChanged, setRecording);

    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (disposed) return;
      // The server sends this only to hosts and co-hosts. It only triggers a
      // refetch of the lobby list, so who sent it doesn't matter.
      if (topic === LOBBY_TOPIC) {
        if (isLobbyWaiting(payload)) onLobbyWaitingRef.current?.();
        return;
      }
      if (topic !== CHAT_TOPIC) return;
      const parsed = parseChatPayload(payload);
      if (parsed === null) return;
      const from = participant?.identity ?? "unknown";
      setState((prev) => {
        const chatMessages = appendChat(prev.chatMessages, {
          id: parsed.id,
          from,
          nick: participantName(participant, "Guest"),
          message: parsed.text,
          receivedAtMs: Date.now(),
          isLocal: false,
        });
        if (chatMessages === prev.chatMessages) return prev;
        return {
          ...prev,
          chatMessages,
          unreadChatCount: chatOpenRef.current ? 0 : prev.unreadChatCount + 1,
        };
      });
    });

    room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (disposed || participant !== room.localParticipant) return;
      const score = qualityScore(quality);
      const at = Date.now();
      if (score === null || at - lastQualityAt < QUALITY_SAMPLE_INTERVAL_MS) return;
      lastQualityAt = at;
      telemetry({ event: "quality", connectionQuality: score });
    });

    room
      .connect(serverUrl, token)
      .then(async () => {
        if (disposed) return;
        joined = true;
        setState((prev) => ({ ...prev, isJoined: true, loadError: null }));
        // Err towards warning: a recording the room already reports turns the
        // notice on, but only a RecordingStatusChanged event clears the join
        // response's recordingActive=true (Egress may not have marked it yet).
        if (room.isRecording) setRecording(true);
        telemetry({
          event: "join_latency",
          joinLatencyMs: Math.max(0, performance.now() - joinStartedAt),
        });
        sync();
        const local = room.localParticipant;
        await Promise.all([
          initial.audioMuted
            ? Promise.resolve()
            : local.setMicrophoneEnabled(true).then(
                () => undefined,
                () => {
                  telemetry({ event: "device_failure", device: "microphone" });
                },
              ),
          initial.videoMuted
            ? Promise.resolve()
            : local.setCameraEnabled(true).then(
                () => undefined,
                () => {
                  telemetry({ event: "device_failure", device: "camera" });
                },
              ),
        ]);
        sync();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setState((prev) => ({ ...prev, loadError: connectErrorMessage(error) }));
      });

    return () => {
      disposed = true;
      room.removeAllListeners();
      void room.disconnect().catch(() => undefined);
      if (roomRef.current === room) roomRef.current = null;
      syncRef.current = () => undefined;
      setState(EMPTY_STATE);
      setMedia(EMPTY_MEDIA);
    };
    // Reconnect only when the room identity (url + token) changes; a late
    // display name or rebound callback must not tear down a live call.
  }, [serverUrl, token]);

  const local = () => {
    const room = roomRef.current;
    return room === null || room.state !== ConnectionState.Connected ? null : room.localParticipant;
  };
  const telemetry = (event: MeetTelemetryEvent) => onTelemetryRef.current?.(event);
  const resync = () => {
    syncRef.current();
  };

  const commands: LiveKitCallCommands = {
    toggleAudio: () => {
      const participant = local();
      if (participant === null) return;
      const enable = !participant.isMicrophoneEnabled;
      participant
        .setMicrophoneEnabled(enable, enable ? audioCaptureRef.current : undefined)
        .then(resync, () => {
          telemetry({ event: "device_failure", device: "microphone" });
          resync();
        });
    },
    toggleVideo: () => {
      const participant = local();
      if (participant === null) return;
      participant.setCameraEnabled(!participant.isCameraEnabled).then(resync, () => {
        telemetry({ event: "device_failure", device: "camera" });
        resync();
      });
    },
    toggleShareScreen: () => {
      const participant = local();
      if (participant === null) return;
      const enable = !participant.isScreenShareEnabled;
      participant
        .setScreenShareEnabled(enable, enable ? { audio: true } : undefined)
        .then(resync, (error: unknown) => {
          // Cancelling the browser picker is not a device failure.
          if (!(error instanceof DOMException && error.name === "NotAllowedError")) {
            telemetry({ event: "device_failure", device: "screen" });
          }
          resync();
        });
    },
    toggleRaiseHand: () => {
      const participant = local();
      if (participant === null) return;
      const raise = participant.attributes[HAND_ATTRIBUTE] !== HAND_RAISED;
      setState((prev) => ({ ...prev, handRaised: raise }));
      // An empty value removes the attribute.
      participant
        .setAttributes({ [HAND_ATTRIBUTE]: raise ? HAND_RAISED : "" })
        .then(resync, resync);
    },
    toggleTileView: () => {
      setState((prev) => ({ ...prev, tileView: !prev.tileView }));
    },
    setNoiseSuppression: (enabled) => {
      audioCaptureRef.current = { ...audioCaptureRef.current, noiseSuppression: enabled };
      setState((prev) => ({ ...prev, noiseSuppressionEnabled: enabled }));
      const track = local()?.getTrackPublication(Track.Source.Microphone)?.track;
      if (track !== undefined) {
        track.restartTrack(audioCaptureRef.current).catch(() => {
          telemetry({ event: "device_failure", device: "microphone" });
        });
      }
    },
    hangup: () => {
      const room = roomRef.current;
      if (room !== null) void room.disconnect().catch(() => undefined);
    },
    sendChatMessage: (message) => {
      const participant = local();
      const text = message.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH);
      if (participant === null || text.length === 0) return;
      const id = randomId();
      setState((prev) => ({
        ...prev,
        chatMessages: appendChat(prev.chatMessages, {
          id,
          from: participant.identity,
          nick: participantName(participant, displayNameRef.current),
          message: text,
          receivedAtMs: Date.now(),
          isLocal: true,
        }),
      }));
      participant
        .publishData(encoder.encode(JSON.stringify({ id, text })), {
          reliable: true,
          topic: CHAT_TOPIC,
        })
        .catch(() => undefined);
    },
    setChatPanelOpen: (open) => {
      chatOpenRef.current = open;
      if (open) {
        setState((prev) => (prev.unreadChatCount === 0 ? prev : { ...prev, unreadChatCount: 0 }));
      }
    },
    startAudio: () => {
      const room = roomRef.current;
      if (room !== null) room.startAudio().then(resync, () => undefined);
    },
  };

  return { state, commands, media };
}

// ---- Snapshot (pure reads of the Room) ----

interface RoomSnapshot {
  readonly state: Pick<
    MeetCallState,
    | "audioMuted"
    | "videoMuted"
    | "screenSharing"
    | "handRaised"
    | "participants"
    | "activeSpeakerId"
    | "capabilities"
  >;
  readonly media: MeetMediaView;
}

export function snapshotRoom(room: Room, localName: string): RoomSnapshot {
  const local = room.localParticipant;
  const remotes = [...room.remoteParticipants.values()].sort(
    (left, right) => (left.joinedAt?.getTime() ?? 0) - (right.joinedAt?.getTime() ?? 0),
  );
  const tiles: MeetMediaTile[] = [];
  const audioTracks: { key: string; track: Track }[] = [];
  for (const participant of [local, ...remotes]) {
    const isLocal = participant === local;
    tiles.push(...participantTiles(participant, isLocal, isLocal ? localName : "Guest"));
    if (!isLocal) {
      for (const source of [Track.Source.Microphone, Track.Source.ScreenShareAudio]) {
        const track = participant.getTrackPublication(source)?.track;
        if (track !== undefined) {
          audioTracks.push({ key: `${participant.identity}:${source}`, track });
        }
      }
    }
  }
  return {
    state: {
      audioMuted: !local.isMicrophoneEnabled,
      videoMuted: !local.isCameraEnabled,
      screenSharing: local.isScreenShareEnabled,
      handRaised: local.attributes[HAND_ATTRIBUTE] === HAND_RAISED,
      participants: remotes.map(toCallParticipant),
      activeSpeakerId: room.activeSpeakers[0]?.identity ?? null,
      capabilities: capabilitiesFor(local.permissions),
    },
    media: { tiles, audioTracks, audioPlaybackBlocked: !room.canPlaybackAudio },
  };
}

/* The token grants decide what this participant may do: chat off removes
   canPublishData, screen share off drops it from canPublishSources, and the
   raised hand needs permission to update its own attributes. */
export function capabilitiesFor(permissions: Participant["permissions"]): MeetCallCapabilities {
  if (permissions === undefined) return LIVEKIT_CAPABILITIES;
  const sources = permissions.canPublishSources.map((source) => Track.sourceFromProto(source));
  return {
    ...LIVEKIT_CAPABILITIES,
    chat: permissions.canPublishData,
    raiseHand: permissions.canUpdateMetadata,
    screenShare:
      permissions.canPublish &&
      (sources.length === 0 || sources.includes(Track.Source.ScreenShare)),
  };
}

function participantTiles(
  participant: Participant,
  isLocal: boolean,
  fallbackName: string,
): MeetMediaTile[] {
  const name = participantName(participant, fallbackName);
  const camera = participant.getTrackPublication(Track.Source.Camera);
  const screen = participant.getTrackPublication(Track.Source.ScreenShare);
  const base = {
    participantId: participant.identity,
    name,
    isLocal,
    audioMuted: !participant.isMicrophoneEnabled,
    speaking: participant.isSpeaking,
    handRaised: participant.attributes[HAND_ATTRIBUTE] === HAND_RAISED,
  };
  const tiles: MeetMediaTile[] = [
    {
      ...base,
      key: `${participant.identity}:camera`,
      isScreenShare: false,
      videoTrack: camera !== undefined && !camera.isMuted ? (camera.track ?? null) : null,
    },
  ];
  if (screen?.track !== undefined && !screen.isMuted) {
    tiles.push({
      ...base,
      key: `${participant.identity}:screen`,
      isScreenShare: true,
      videoTrack: screen.track,
    });
  }
  return tiles;
}

function toCallParticipant(participant: RemoteParticipant): MeetCallParticipant {
  return {
    id: participant.identity,
    displayName: participantName(participant, "Guest"),
    participantSubject: participant.identity,
    audioMuted: !participant.isMicrophoneEnabled,
    speaking: participant.isSpeaking,
    handRaised: participant.attributes[HAND_ATTRIBUTE] === HAND_RAISED,
  };
}

function participantName(participant: Participant | undefined, fallback: string): string {
  const name = participant?.name?.trim();
  return name !== undefined && name.length > 0 ? name : fallback;
}

/** Accepts only `{ id: string, text: string }` within bounds; anything else is dropped. */
export function parseChatPayload(
  payload: Uint8Array,
): { readonly id: string; readonly text: string } | null {
  try {
    const value: unknown = JSON.parse(decoder.decode(payload));
    if (typeof value !== "object" || value === null) return null;
    const { id, text } = value as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_CHAT_ID_LENGTH) return null;
    if (typeof text !== "string") return null;
    const trimmed = text.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH);
    return trimmed.length === 0 ? null : { id, text: trimmed };
  } catch {
    return null;
  }
}

/** True for the server's `{ "type": "lobby.waiting" }` nudge. */
export function isLobbyWaiting(payload: Uint8Array): boolean {
  try {
    const value: unknown = JSON.parse(decoder.decode(payload));
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<string, unknown>).type === "lobby.waiting"
    );
  } catch {
    return false;
  }
}

/** LiveKit connection quality as the bounded 0–100 score the telemetry API accepts. */
export function qualityScore(quality: ConnectionQuality): number | null {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return 100;
    case ConnectionQuality.Good:
      return 70;
    case ConnectionQuality.Poor:
      return 30;
    case ConnectionQuality.Lost:
      return 0;
    default:
      return null;
  }
}

function connectErrorMessage(error: unknown): string {
  const detail = error instanceof Error && error.message.length > 0 ? ` (${error.message})` : "";
  return `Couldn't connect to the meeting server${detail}. Check your connection and join again.`;
}
