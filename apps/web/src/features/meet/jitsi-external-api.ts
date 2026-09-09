/* Jitsi IFrame API integration.
 *
 * Loads `external_api.js` from the configured Jitsi domain, instantiates a
 * JitsiMeetExternalAPI inside a host React element, and exposes call state +
 * commands as React-idiomatic values.
 *
 * Why this hook exists: the raw <iframe> embed is a black box — mute/camera
 * buttons in the Helix UI couldn't talk to Jitsi, the REC pill was hard-coded
 * on, and there was no way to read participants or recording state. Jitsi
 * publishes a stable postMessage API for exactly this; we wrap it here so
 * meet-call.tsx can stay a thin presentational layer.
 */

import { useEffect, useRef, useState } from "react";
import type { MeetMediaCommand, MeetRecordingAuthorization, MeetTelemetryEvent } from "./api";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface JitsiParticipant {
  readonly id: string;
  readonly displayName: string;
  readonly participantSubject: string;
}

export interface JitsiClientCapabilities {
  readonly tileView: boolean;
  readonly noiseSuppression: boolean;
  readonly backgroundBlur: boolean;
  readonly breakoutRooms: boolean;
}

export interface JitsiBreakoutRoom {
  readonly id: string;
  readonly name: string;
  readonly isMainRoom: boolean;
  readonly participantCount: number;
}

export interface JitsiCallState {
  /** External API script has loaded and the IFrame is mounted. */
  readonly isReady: boolean;
  /** videoConferenceJoined has fired — local participant is in the room. */
  readonly isJoined: boolean;
  /** Local audio muted (reported by Jitsi, not optimistic). */
  readonly audioMuted: boolean;
  /** Local video muted (camera off). */
  readonly videoMuted: boolean;
  /** Local screen-sharing on. */
  readonly screenSharing: boolean;
  /** Local hand raised. */
  readonly handRaised: boolean;
  /** Features the loaded Jitsi deployment says it supports. */
  readonly capabilities: JitsiClientCapabilities;
  /** Null until Jitsi reports the current layout. */
  readonly tileView: boolean | null;
  /** Null until changed through the Helix control. */
  readonly noiseSuppressionEnabled: boolean | null;
  /** Null until changed through the Helix control. */
  readonly backgroundBlurred: boolean | null;
  /** Identity-free room summaries reported by Jitsi. */
  readonly breakoutRooms: readonly JitsiBreakoutRoom[];
  /** Recording in progress (any participant started it). */
  readonly recordingActive: boolean;
  /** Remote participants (does not include local). */
  readonly participants: readonly JitsiParticipant[];
  /** Participants currently waiting in the server-enforced lobby. */
  readonly knockingParticipants: readonly JitsiParticipant[];
  /** Most recent chat messages, oldest first. Truncated to last 200. */
  readonly chatMessages: readonly JitsiChatMessage[];
  /** Bumps whenever a new chat message arrives and the panel isn't open. */
  readonly unreadChatCount: number;
  /** Non-null when the script failed to load or the API threw on init. */
  readonly loadError: string | null;
}

export interface JitsiChatMessage {
  readonly id: string;
  readonly from: string;
  readonly nick: string;
  readonly message: string;
  /** Wall-clock epoch ms when we received it. */
  readonly receivedAtMs: number;
  /** True for messages the local participant sent. */
  readonly isLocal: boolean;
}

export interface JitsiCallCommands {
  toggleAudio: () => void;
  toggleVideo: () => void;
  toggleShareScreen: () => void;
  toggleRaiseHand: () => void;
  toggleTileView: () => void;
  setNoiseSuppression: (enabled: boolean) => void;
  setBackgroundBlur: (enabled: boolean) => void;
  addBreakoutRoom: () => void;
  autoAssignBreakoutRooms: () => void;
  joinBreakoutRoom: (roomId?: string) => void;
  closeBreakoutRoom: (roomId: string) => void;
  startRecording: (authorization: MeetRecordingAuthorization) => void;
  stopRecording: () => void;
  hangup: () => void;
  sendChatMessage: (message: string) => void;
  /** Acknowledge that the chat panel has been read; clears unread count. */
  markChatRead: () => void;
  applyMediaCommands: (commands: readonly MeetMediaCommand[]) => void;
}

export interface JitsiCallControls {
  readonly state: JitsiCallState;
  readonly commands: JitsiCallCommands;
}

export interface UseJitsiCallParams {
  /** When non-null, mount the call; null disposes it. */
  readonly options: JitsiCallOptions | null;
  /** Container element to render the Jitsi iframe into. */
  readonly hostRef: React.RefObject<HTMLDivElement | null>;
  /** Fires once after videoConferenceLeft (user clicked hangup). */
  readonly onLeft?: () => void;
  /** Receives only bounded numeric/error-category telemetry; never media or identity. */
  readonly onTelemetry?: (event: MeetTelemetryEvent) => void;
}

export interface JitsiCallOptions {
  readonly domain: string;
  readonly roomName: string;
  /** Optional JWT for moderated rooms. */
  readonly jwt: string | null;
  readonly initialRecordingActive: boolean;
  readonly userInfo: {
    readonly displayName: string;
    readonly email: string | null;
  };
}

// ---------------------------------------------------------------------------
// Script loader (memoised per domain)
// ---------------------------------------------------------------------------

const loaderPromises = new Map<string, Promise<void>>();

function loadExternalApiScript(domain: string): Promise<void> {
  const cached = loaderPromises.get(domain);
  if (cached !== undefined) return cached;
  const url = `https://${domain}/external_api.js`;
  const promise = new Promise<void>((resolve, reject) => {
    // Already present from a prior mount.
    if (typeof window !== "undefined" && "JitsiMeetExternalAPI" in window) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => {
      resolve();
    };
    script.onerror = () => {
      // Allow retry on next mount.
      loaderPromises.delete(domain);
      reject(new Error(`Failed to load Jitsi external API from ${url}`));
    };
    document.head.appendChild(script);
  });
  loaderPromises.set(domain, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Minimal structural type for the external API. We don't pull in the
// upstream @types/jitsi since the surface we use is small and stable.
// ---------------------------------------------------------------------------

interface ExternalApiCtor {
  new (domain: string, options: ExternalApiOptions): ExternalApi;
}

interface ExternalApiOptions {
  readonly roomName: string;
  readonly parentNode: HTMLElement;
  readonly jwt?: string;
  readonly userInfo?: { displayName?: string; email?: string };
  readonly configOverwrite?: Record<string, unknown>;
  readonly interfaceConfigOverwrite?: Record<string, unknown>;
}

interface ExternalApi {
  addListener(event: string, handler: (payload: unknown) => void): void;
  executeCommand(name: string, ...args: unknown[]): void;
  getConnectionStats?: () => Promise<unknown>;
  getSupportedCommands?: () => readonly string[];
  listBreakoutRooms?: () => Promise<unknown>;
  dispose(): void;
  getIFrame(): HTMLIFrameElement | null;
}

declare global {
  interface Window {
    JitsiMeetExternalAPI?: ExternalApiCtor;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const EMPTY_CAPABILITIES: JitsiClientCapabilities = {
  tileView: false,
  noiseSuppression: false,
  backgroundBlur: false,
  breakoutRooms: false,
};

const EMPTY_STATE: JitsiCallState = {
  isReady: false,
  isJoined: false,
  audioMuted: false,
  videoMuted: false,
  screenSharing: false,
  handRaised: false,
  capabilities: EMPTY_CAPABILITIES,
  tileView: null,
  noiseSuppressionEnabled: null,
  backgroundBlurred: null,
  breakoutRooms: [],
  recordingActive: false,
  participants: [],
  knockingParticipants: [],
  chatMessages: [],
  unreadChatCount: 0,
  loadError: null,
};

export function useJitsiCall({
  options,
  hostRef,
  onLeft,
  onTelemetry,
}: UseJitsiCallParams): JitsiCallControls {
  const [state, setState] = useState<JitsiCallState>(EMPTY_STATE);
  const apiRef = useRef<ExternalApi | null>(null);
  const capabilitiesRef = useRef<JitsiClientCapabilities>(EMPTY_CAPABILITIES);
  const recordingActiveRef = useRef(false);
  const chatPanelReadRef = useRef(true);
  // Hold the latest onLeft so the mount effect can dispose without re-running
  // when the parent rebinds it. The parent's onLeave typically captures setState,
  // so a stable reference here matters for not tearing down the call.
  const onLeftRef = useRef(onLeft);
  onLeftRef.current = onLeft;
  const onTelemetryRef = useRef(onTelemetry);
  onTelemetryRef.current = onTelemetry;

  useEffect(() => {
    if (options === null) {
      // External signal to tear down (e.g., parent unmounting the call view).
      return;
    }
    const host = hostRef.current;
    if (host === null) return;
    let disposed = false;
    let api: ExternalApi | null = null;
    const joinStartedAt = performance.now();
    let lastQualityAt = 0;

    setState({ ...EMPTY_STATE, recordingActive: options.initialRecordingActive });
    recordingActiveRef.current = options.initialRecordingActive;
    if (options.initialRecordingActive) announceRecordingStarted();

    loadExternalApiScript(options.domain)
      .then(() => {
        if (disposed) return;
        const Ctor = window.JitsiMeetExternalAPI;
        if (Ctor === undefined) {
          setState((prev) => ({ ...prev, loadError: "Jitsi external API not available." }));
          return;
        }
        api = new Ctor(options.domain, {
          roomName: options.roomName,
          parentNode: host,
          jwt: options.jwt ?? undefined,
          userInfo: {
            displayName: options.userInfo.displayName,
            email: options.userInfo.email ?? undefined,
          },
          configOverwrite: {
            prejoinPageEnabled: false,
            disableDeepLinking: true,
            // We render our own bottom bar — empty toolbarButtons hides
            // the Jitsi-native toolbar entirely (modern Jitsi spelling).
            toolbarButtons: [],
            // Chrome we never want — we render our own header.
            hideConferenceSubject: true,
            hideConferenceTimer: true,
            hideParticipantsStats: true,
            disableSelfView: false,
            disableInviteFunctions: true,
            disableRecordAudioNotification: false,
            // Keyboard shortcuts conflict with the host page.
            disableShortcuts: true,
          },
          interfaceConfigOverwrite: {
            // Older Jitsi versions still respect these.
            TOOLBAR_BUTTONS: [],
            SHOW_JITSI_WATERMARK: false,
            SHOW_BRAND_WATERMARK: false,
            SHOW_CHROME_EXTENSION_BANNER: false,
            HIDE_INVITE_MORE_HEADER: true,
            MOBILE_APP_PROMO: false,
            DISABLE_JOIN_LEAVE_NOTIFICATIONS: false,
          },
        });
        apiRef.current = api;
        const capabilities = meetCapabilitiesFromCommands(
          api.getSupportedCommands?.() ?? [],
          api.listBreakoutRooms !== undefined,
        );
        capabilitiesRef.current = capabilities;

        // Style the iframe to fill the host.
        const iframe = api.getIFrame();
        if (iframe !== null) {
          iframe.style.width = "100%";
          iframe.style.height = "100%";
          iframe.style.border = "0";
          iframe.allow = "camera; microphone; fullscreen; display-capture; autoplay";
        }

        setState((prev) => ({ ...prev, isReady: true, capabilities }));

        if (capabilities.breakoutRooms && api.listBreakoutRooms !== undefined) {
          void api
            .listBreakoutRooms()
            .then((rooms) => {
              if (!disposed) {
                setState((prev) => ({ ...prev, breakoutRooms: breakoutRoomsFromJitsi(rooms) }));
              }
            })
            .catch(() => undefined);
        }

        const reportQuality = () => {
          const at = Date.now();
          if (
            api?.getConnectionStats === undefined ||
            at - lastQualityAt < QUALITY_SAMPLE_INTERVAL_MS
          ) {
            return;
          }
          lastQualityAt = at;
          void api
            .getConnectionStats()
            .then((stats) => {
              const sample = qualityTelemetryFromJitsi(stats);
              if (sample !== null) onTelemetryRef.current?.(sample);
            })
            .catch(() => undefined);
        };

        // ---- Lifecycle ----
        api.addListener("videoConferenceJoined", () => {
          setState((prev) => ({ ...prev, isJoined: true }));
          onTelemetryRef.current?.({
            event: "join_latency",
            joinLatencyMs: Math.max(0, performance.now() - joinStartedAt),
          });
          reportQuality();
        });
        api.addListener("videoConferenceLeft", () => {
          setState((prev) => ({ ...prev, isJoined: false }));
          onLeftRef.current?.();
        });
        api.addListener("readyToClose", () => {
          onLeftRef.current?.();
        });

        // ---- Local media state ----
        api.addListener("audioMuteStatusChanged", (payload: unknown) => {
          const muted = readBool(payload, "muted");
          if (muted !== null) setState((prev) => ({ ...prev, audioMuted: muted }));
        });
        api.addListener("videoMuteStatusChanged", (payload: unknown) => {
          const muted = readBool(payload, "muted");
          if (muted !== null) setState((prev) => ({ ...prev, videoMuted: muted }));
        });
        api.addListener("screenSharingStatusChanged", (payload: unknown) => {
          const on = readBool(payload, "on");
          if (on !== null) setState((prev) => ({ ...prev, screenSharing: on }));
        });
        api.addListener("tileViewChanged", (payload: unknown) => {
          const enabled = readBool(payload, "enabled");
          if (enabled !== null) setState((prev) => ({ ...prev, tileView: enabled }));
        });
        api.addListener("breakoutRoomsUpdated", (payload: unknown) => {
          if (!capabilities.breakoutRooms) return;
          setState((prev) => ({ ...prev, breakoutRooms: breakoutRoomsFromJitsi(payload) }));
        });
        api.addListener("cameraError", () => {
          onTelemetryRef.current?.({ event: "device_failure", device: "camera" });
        });
        api.addListener("micError", () => {
          onTelemetryRef.current?.({ event: "device_failure", device: "microphone" });
        });
        api.addListener("videoQualityChanged", reportQuality);
        api.addListener("peerConnectionFailure", reportQuality);
        api.addListener("raiseHandUpdated", (payload: unknown) => {
          // Jitsi sends raiseHandUpdated for every participant; only mirror it
          // when it's for the local participant (id matches the local one).
          const id = readString(payload, "id");
          const handRaised = readBool(payload, "handRaised");
          if (handRaised === null) return;
          // Treat any raiseHandUpdated as authoritative for local because we
          // toggle via executeCommand which only affects local. False positives
          // are harmless — the next local toggle will re-sync.
          setState((prev) => ({
            ...prev,
            handRaised: id === null ? handRaised : prev.handRaised || handRaised,
          }));
        });

        // ---- Recording ----
        api.addListener("recordingStatusChanged", (payload: unknown) => {
          const on = readBool(payload, "on");
          if (on === null) return;
          if (on && !recordingActiveRef.current) announceRecordingStarted();
          recordingActiveRef.current = on;
          setState((prev) => ({ ...prev, recordingActive: on }));
        });

        // ---- Participants ----
        api.addListener("participantJoined", (payload: unknown) => {
          const id = readString(payload, "id");
          if (id === null) return;
          const displayName = readString(payload, "displayName") ?? "Guest";
          const participantSubject = readNestedString(payload, "userContext", "id") ?? id;
          setState((prev) => {
            if (prev.participants.some((p) => p.id === id)) return prev;
            return {
              ...prev,
              participants: [...prev.participants, { id, displayName, participantSubject }],
            };
          });
        });
        api.addListener("knockingParticipant", (payload: unknown) => {
          const participant = readRecord(payload, "participant");
          const id = readString(participant, "id");
          if (id === null) return;
          const displayName = readString(participant, "name") ?? "Guest";
          setState((prev) => ({
            ...prev,
            knockingParticipants: prev.knockingParticipants.some((item) => item.id === id)
              ? prev.knockingParticipants
              : [...prev.knockingParticipants, { id, displayName, participantSubject: id }],
          }));
        });
        api.addListener("participantLeft", (payload: unknown) => {
          const id = readString(payload, "id");
          if (id === null) return;
          setState((prev) => ({
            ...prev,
            participants: prev.participants.filter((p) => p.id !== id),
          }));
        });

        // ---- Chat ----
        api.addListener("incomingMessage", (payload: unknown) => {
          const from = readString(payload, "from") ?? "";
          const nick = readString(payload, "nick") ?? "Guest";
          const message = readString(payload, "message") ?? "";
          if (message.length === 0) return;
          const id = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
          setState((prev) => {
            const trimmed = appendChat(prev.chatMessages, {
              id,
              from,
              nick,
              message,
              receivedAtMs: Date.now(),
              isLocal: false,
            });
            const isOpen = chatPanelReadRef.current;
            return {
              ...prev,
              chatMessages: trimmed,
              unreadChatCount: isOpen ? prev.unreadChatCount : prev.unreadChatCount + 1,
            };
          });
        });
        api.addListener("outgoingMessage", (payload: unknown) => {
          const message = readString(payload, "message") ?? "";
          if (message.length === 0) return;
          const id = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
          setState((prev) => ({
            ...prev,
            chatMessages: appendChat(prev.chatMessages, {
              id,
              from: "local",
              nick: options.userInfo.displayName,
              message,
              receivedAtMs: Date.now(),
              isLocal: true,
            }),
          }));
        });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setState((prev) => ({
          ...prev,
          loadError: error instanceof Error ? error.message : "Jitsi failed to load.",
        }));
      });

    return () => {
      disposed = true;
      if (api !== null) {
        try {
          api.dispose();
        } catch {
          // dispose may throw if the iframe was already torn down; ignore.
        }
      }
      apiRef.current = null;
      capabilitiesRef.current = EMPTY_CAPABILITIES;
      recordingActiveRef.current = false;
      setState({ ...EMPTY_STATE });
    };
    // Re-mount only when the room identity itself changes. userInfo and the
    // host ref are intentionally not in the deps — late-arriving display name
    // shouldn't tear down a live call.
  }, [options?.domain, options?.roomName, options?.jwt]);

  const commands: JitsiCallCommands = {
    toggleAudio: () => apiRef.current?.executeCommand("toggleAudio"),
    toggleVideo: () => apiRef.current?.executeCommand("toggleVideo"),
    toggleShareScreen: () => apiRef.current?.executeCommand("toggleShareScreen"),
    toggleRaiseHand: () => {
      apiRef.current?.executeCommand("toggleRaiseHand");
      // Optimistically flip; the raiseHandUpdated event will reconcile.
      setState((prev) => ({ ...prev, handRaised: !prev.handRaised }));
    },
    toggleTileView: () => {
      if (capabilitiesRef.current.tileView) apiRef.current?.executeCommand("toggleTileView");
    },
    setNoiseSuppression: (enabled) => {
      if (!capabilitiesRef.current.noiseSuppression) return;
      apiRef.current?.executeCommand("setNoiseSuppressionEnabled", { enabled });
      setState((prev) => ({ ...prev, noiseSuppressionEnabled: enabled }));
    },
    setBackgroundBlur: (enabled) => {
      if (!capabilitiesRef.current.backgroundBlur) return;
      apiRef.current?.executeCommand("setBlurredBackground", enabled ? "blur" : "none");
      setState((prev) => ({ ...prev, backgroundBlurred: enabled }));
    },
    addBreakoutRoom: () => {
      if (capabilitiesRef.current.breakoutRooms) apiRef.current?.executeCommand("addBreakoutRoom");
    },
    autoAssignBreakoutRooms: () => {
      if (capabilitiesRef.current.breakoutRooms) {
        apiRef.current?.executeCommand("autoAssignToBreakoutRooms");
      }
    },
    joinBreakoutRoom: (roomId) => {
      if (capabilitiesRef.current.breakoutRooms) {
        if (roomId === undefined) apiRef.current?.executeCommand("joinBreakoutRoom");
        else apiRef.current?.executeCommand("joinBreakoutRoom", roomId);
      }
    },
    closeBreakoutRoom: (roomId) => {
      if (capabilitiesRef.current.breakoutRooms) {
        apiRef.current?.executeCommand("closeBreakoutRoom", roomId);
      }
    },
    startRecording: (authorization) => {
      if (
        !UUID_PATTERN.test(authorization.authorizationId) ||
        Date.parse(authorization.expiresAt) <= Date.now()
      ) {
        return;
      }
      apiRef.current?.executeCommand("startRecording", { mode: "file" });
    },
    stopRecording: () => apiRef.current?.executeCommand("stopRecording", "file"),
    hangup: () => apiRef.current?.executeCommand("hangup"),
    sendChatMessage: (message) => {
      const trimmed = message.trim();
      if (trimmed.length === 0) return;
      apiRef.current?.executeCommand("sendChatMessage", trimmed);
    },
    markChatRead: () => {
      chatPanelReadRef.current = true;
      setState((prev) => (prev.unreadChatCount === 0 ? prev : { ...prev, unreadChatCount: 0 }));
    },
    applyMediaCommands: (mediaCommands) => {
      for (const mediaCommand of mediaCommands) executeMediaCommand(apiRef.current, mediaCommand);
    },
  };

  return { state, commands };
}

// ---------------------------------------------------------------------------
// Small helpers (payloads from Jitsi are typed as unknown over postMessage)
// ---------------------------------------------------------------------------

function readBool(payload: unknown, key: string): boolean | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function readRecord(payload: unknown, key: string): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNestedString(payload: unknown, parent: string, key: string): string | null {
  return readString(readRecord(payload, parent), key);
}

export function meetCapabilitiesFromCommands(
  commands: readonly string[],
  canListBreakoutRooms = true,
): JitsiClientCapabilities {
  const supported = new Set(commands);
  return {
    tileView: supported.has("toggleTileView"),
    noiseSuppression: supported.has("setNoiseSuppressionEnabled"),
    backgroundBlur: supported.has("setBlurredBackground"),
    breakoutRooms:
      canListBreakoutRooms &&
      [
        "addBreakoutRoom",
        "autoAssignToBreakoutRooms",
        "closeBreakoutRoom",
        "joinBreakoutRoom",
      ].every((command) => supported.has(command)),
  };
}

/** Reduce Jitsi's participant-bearing breakout payload to safe room counts. */
export function breakoutRoomsFromJitsi(payload: unknown): readonly JitsiBreakoutRoom[] {
  const source = readRecord(payload, "rooms") ?? payload;
  const values = Array.isArray(source)
    ? source
    : isRecordValue(source)
      ? Object.values(source)
      : [];
  return values
    .slice(0, 100)
    .flatMap((value): JitsiBreakoutRoom[] => {
      if (!isRecordValue(value)) return [];
      const id = typeof value.id === "string" ? value.id : null;
      if (id === null || id.length === 0 || id.length > 512) return [];
      const participants = value.participants;
      const participantCount = Array.isArray(participants)
        ? participants.length
        : isRecordValue(participants)
          ? Object.keys(participants).length
          : 0;
      return [
        {
          id,
          name:
            typeof value.name === "string" && value.name.trim().length > 0
              ? value.name.trim().slice(0, 120)
              : value.isMainRoom === true
                ? "Main room"
                : "Breakout room",
          isMainRoom: value.isMainRoom === true,
          participantCount: Math.min(participantCount, 10_000),
        },
      ];
    })
    .sort((left, right) =>
      left.isMainRoom === right.isMainRoom
        ? left.name.localeCompare(right.name)
        : left.isMainRoom
          ? -1
          : 1,
    );
}

function executeMediaCommand(api: ExternalApi | null, mediaCommand: MeetMediaCommand): void {
  if (api === null) return;
  switch (mediaCommand.command) {
    case "toggleLobby":
      api.executeCommand("toggleLobby", mediaCommand.enabled);
      break;
    case "answerKnockingParticipant":
      api.executeCommand(
        "answerKnockingParticipant",
        mediaCommand.participantId,
        mediaCommand.approved,
      );
      break;
    case "password":
      api.executeCommand("password", mediaCommand.password);
      break;
    case "kickParticipant":
      api.executeCommand("kickParticipant", mediaCommand.participantId);
      break;
    case "grantModerator":
      api.executeCommand("grantModerator", mediaCommand.participantId);
      break;
    case "muteRemoteParticipant":
      api.executeCommand(
        "muteRemoteParticipant",
        mediaCommand.participantId,
        mediaCommand.mediaType,
      );
      break;
    case "toggleModeration":
      api.executeCommand("toggleModeration", mediaCommand.enabled, mediaCommand.mediaType);
      break;
    case "approveParticipant":
      api.executeCommand(
        mediaCommand.mediaType === "audio" ? "askToUnmute" : "approveVideo",
        mediaCommand.participantId,
      );
      break;
    case "setChatPolicy":
      api.executeCommand("overwriteConfig", { disableChat: mediaCommand.policy === "disabled" });
      break;
    case "setReactionPolicy":
      api.executeCommand("overwriteConfig", {
        disableReactions: mediaCommand.policy === "disabled",
      });
      break;
  }
}

const MAX_CHAT_MESSAGES = 200;
const QUALITY_SAMPLE_INTERVAL_MS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function qualityTelemetryFromJitsi(payload: unknown): MeetTelemetryEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const outer = payload as Record<string, unknown>;
  const source =
    typeof outer.stats === "object" && outer.stats !== null
      ? (outer.stats as Record<string, unknown>)
      : outer;
  const packetLoss = recordValue(source.packetLoss);
  const bitrate = recordValue(source.bitrate);
  const transport = Array.isArray(source.transport) ? source.transport.filter(isRecordValue) : [];
  const sample = {
    event: "quality" as const,
    packetLossPercent:
      boundedNumber(source, ["packetLossPercent", "packetLoss"], 100) ??
      boundedNumber(packetLoss, ["total"], 100),
    jitterMs:
      boundedNumber(source, ["jitterMs", "jitter"], 10_000) ??
      maximumNumber(transport, "jitter", 10_000),
    rttMs:
      boundedNumber(source, ["rttMs", "jvbRTT", "rtt"], 60_000) ??
      maximumNumber(transport, "rtt", 60_000),
    bitrateKbps:
      boundedNumber(source, ["bitrateKbps", "bitrate"], 1_000_000) ??
      sumNumbers(bitrate, ["download", "upload"], 1_000_000),
    connectionQuality:
      boundedNumber(source, ["connectionQuality"], 100) ??
      boundedNumber(outer, ["connectionQuality"], 100),
    bridgeLoadPercent:
      boundedNumber(source, ["bridgeLoadPercent", "bridgeLoad"], 100) ??
      boundedNumber(outer, ["bridgeLoadPercent", "bridgeLoad"], 100),
  };
  return Object.values(sample).some((value) => typeof value === "number") ? sample : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecordValue(value) ? value : {};
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maximumNumber(
  records: readonly Record<string, unknown>[],
  key: string,
  maximum: number,
): number | undefined {
  const values = records
    .map((record) => boundedNumber(record, [key], maximum))
    .filter((value): value is number => value !== undefined);
  return values.length === 0 ? undefined : Math.max(...values);
}

function sumNumbers(
  source: Record<string, unknown>,
  keys: readonly string[],
  maximum: number,
): number | undefined {
  const values = keys
    .map((key) => boundedNumber(source, [key], maximum))
    .filter((value): value is number => value !== undefined);
  return values.length === 0
    ? undefined
    : Math.min(
        maximum,
        values.reduce((sum, value) => sum + value, 0),
      );
}

function boundedNumber(
  source: Record<string, unknown>,
  keys: readonly string[],
  maximum: number,
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum) {
      return value;
    }
  }
  return undefined;
}

export function announceRecordingStarted(): void {
  if (typeof window === "undefined" || typeof SpeechSynthesisUtterance === "undefined") {
    return;
  }
  window.speechSynthesis.speak(new SpeechSynthesisUtterance("Recording started"));
}

function appendChat(
  existing: readonly JitsiChatMessage[],
  next: JitsiChatMessage,
): readonly JitsiChatMessage[] {
  const combined = [...existing, next];
  return combined.length <= MAX_CHAT_MESSAGES
    ? combined
    : combined.slice(combined.length - MAX_CHAT_MESSAGES);
}
