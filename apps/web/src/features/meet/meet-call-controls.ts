/* Call controls: the state and commands MeetCall renders. The media hook
 * (`useLiveKitCall`) returns `{ state, commands }` in this shape and reports
 * the features it supports through `capabilities`, so the UI hides the rest
 * and new features can be switched on without reshaping the view. */

import type { MeetTelemetryEvent } from "./api";

export interface MeetCallParticipant {
  /** Media participant id (the LiveKit identity); sent as `mediaParticipantId`. */
  readonly id: string;
  readonly displayName: string;
  /** Stable subject (actor id or guest subject) the server authorizes against. */
  readonly participantSubject: string;
  readonly audioMuted: boolean;
  readonly speaking: boolean;
  readonly handRaised: boolean;
}

/** Features the media provider supports; unsupported controls are hidden. */
export interface MeetCallCapabilities {
  readonly chat: boolean;
  readonly raiseHand: boolean;
  readonly screenShare: boolean;
  readonly tileView: boolean;
  readonly noiseSuppression: boolean;
}

export interface MeetChatMessage {
  readonly id: string;
  readonly from: string;
  readonly nick: string;
  readonly message: string;
  /** Wall-clock epoch ms when we received it. */
  readonly receivedAtMs: number;
  /** True for messages the local participant sent. */
  readonly isLocal: boolean;
}

export interface MeetCallState {
  /** The media client is created and connecting. */
  readonly isReady: boolean;
  /** The local participant is in the room. */
  readonly isJoined: boolean;
  /** Local microphone muted (as published, not optimistic). */
  readonly audioMuted: boolean;
  /** Local camera off. */
  readonly videoMuted: boolean;
  /** Local screen share on. */
  readonly screenSharing: boolean;
  /** Local hand raised. */
  readonly handRaised: boolean;
  readonly capabilities: MeetCallCapabilities;
  /** Equal tiles (true) or the active speaker and screen share featured (false). */
  readonly tileView: boolean;
  /** Null until the provider reports it. */
  readonly noiseSuppressionEnabled: boolean | null;
  /** Server-reported recording state carried in from the join response. */
  readonly recordingActive: boolean;
  /** Remote participants (does not include local). */
  readonly participants: readonly MeetCallParticipant[];
  /** Id of the loudest participant (local or remote). */
  readonly activeSpeakerId: string | null;
  /** Most recent chat messages, oldest first. Truncated to the last 200. */
  readonly chatMessages: readonly MeetChatMessage[];
  /** Messages that arrived while the chat panel was closed. */
  readonly unreadChatCount: number;
  /** Non-null when connecting failed or the connection was lost. */
  readonly loadError: string | null;
}

export interface MeetCallCommands {
  toggleAudio: () => void;
  toggleVideo: () => void;
  toggleShareScreen: () => void;
  toggleRaiseHand: () => void;
  toggleTileView: () => void;
  setNoiseSuppression: (enabled: boolean) => void;
  hangup: () => void;
  sendChatMessage: (message: string) => void;
  /** Tell the hook whether the chat panel is showing; opening clears the unread count. */
  setChatPanelOpen: (open: boolean) => void;
}

export interface MeetCallControls {
  readonly state: MeetCallState;
  readonly commands: MeetCallCommands;
}

/** Pre-join choices: muted states and the chosen devices. */
export interface MeetInitialMedia {
  readonly audioMuted: boolean;
  readonly videoMuted: boolean;
  readonly audioInputId: string | null;
  readonly videoInputId: string | null;
}

/** Callbacks the media hook accepts. */
export interface MeetCallCallbacks {
  /** Fires once after the local participant left the room. */
  readonly onLeft?: () => void;
  /** Receives only bounded numeric/error-category telemetry; never media or identity. */
  readonly onTelemetry?: (event: MeetTelemetryEvent) => void;
}

export const MAX_CHAT_MESSAGES = 200;
/** Longest chat message accepted from the data channel. */
export const MAX_CHAT_MESSAGE_LENGTH = 4000;

export function appendChat(
  existing: readonly MeetChatMessage[],
  next: MeetChatMessage,
): readonly MeetChatMessage[] {
  if (existing.some((message) => message.id === next.id && message.from === next.from)) {
    return existing;
  }
  const combined = [...existing, next];
  return combined.length <= MAX_CHAT_MESSAGES
    ? combined
    : combined.slice(combined.length - MAX_CHAT_MESSAGES);
}

export function announceRecordingStarted(): void {
  if (typeof window === "undefined" || typeof SpeechSynthesisUtterance === "undefined") {
    return;
  }
  window.speechSynthesis.speak(new SpeechSynthesisUtterance("Recording started"));
}
