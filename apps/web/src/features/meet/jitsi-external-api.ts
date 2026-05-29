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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface JitsiParticipant {
  readonly id: string;
  readonly displayName: string;
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
  /** Recording in progress (any participant started it). */
  readonly recordingActive: boolean;
  /** Remote participants (does not include local). */
  readonly participants: readonly JitsiParticipant[];
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
  startRecording: () => void;
  stopRecording: () => void;
  hangup: () => void;
  sendChatMessage: (message: string) => void;
  /** Acknowledge that the chat panel has been read; clears unread count. */
  markChatRead: () => void;
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
}

export interface JitsiCallOptions {
  readonly domain: string;
  readonly roomName: string;
  /** Optional JWT for moderated rooms. */
  readonly jwt: string | null;
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

const EMPTY_STATE: JitsiCallState = {
  isReady: false,
  isJoined: false,
  audioMuted: false,
  videoMuted: false,
  screenSharing: false,
  handRaised: false,
  recordingActive: false,
  participants: [],
  chatMessages: [],
  unreadChatCount: 0,
  loadError: null,
};

export function useJitsiCall({ options, hostRef, onLeft }: UseJitsiCallParams): JitsiCallControls {
  const [state, setState] = useState<JitsiCallState>(EMPTY_STATE);
  const apiRef = useRef<ExternalApi | null>(null);
  const chatPanelReadRef = useRef(true);
  // Hold the latest onLeft so the mount effect can dispose without re-running
  // when the parent rebinds it. The parent's onLeave typically captures setState,
  // so a stable reference here matters for not tearing down the call.
  const onLeftRef = useRef(onLeft);
  onLeftRef.current = onLeft;

  useEffect(() => {
    if (options === null) {
      // External signal to tear down (e.g., parent unmounting the call view).
      return;
    }
    const host = hostRef.current;
    if (host === null) return;
    let disposed = false;
    let api: ExternalApi | null = null;

    setState({ ...EMPTY_STATE });

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

        // Style the iframe to fill the host.
        const iframe = api.getIFrame();
        if (iframe !== null) {
          iframe.style.width = "100%";
          iframe.style.height = "100%";
          iframe.style.border = "0";
          iframe.allow = "camera; microphone; fullscreen; display-capture; autoplay";
        }

        setState((prev) => ({ ...prev, isReady: true }));

        // ---- Lifecycle ----
        api.addListener("videoConferenceJoined", () => {
          setState((prev) => ({ ...prev, isJoined: true }));
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
          if (on !== null) setState((prev) => ({ ...prev, recordingActive: on }));
        });

        // ---- Participants ----
        api.addListener("participantJoined", (payload: unknown) => {
          const id = readString(payload, "id");
          if (id === null) return;
          const displayName = readString(payload, "displayName") ?? "Guest";
          setState((prev) => {
            if (prev.participants.some((p) => p.id === id)) return prev;
            return {
              ...prev,
              participants: [...prev.participants, { id, displayName }],
            };
          });
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
    startRecording: () => apiRef.current?.executeCommand("startRecording", { mode: "file" }),
    stopRecording: () => apiRef.current?.executeCommand("stopRecording", "file"),
    hangup: () => apiRef.current?.executeCommand("hangup"),
    sendChatMessage: (message) => {
      const trimmed = message.trim();
      if (trimmed.length === 0) return;
      apiRef.current?.executeCommand("sendChatMessage", trimmed);
    },
    markChatRead: () => {
      chatPanelReadRef.current = true;
      setState((prev) =>
        prev.unreadChatCount === 0 ? prev : { ...prev, unreadChatCount: 0 },
      );
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

const MAX_CHAT_MESSAGES = 200;

function appendChat(
  existing: readonly JitsiChatMessage[],
  next: JitsiChatMessage,
): readonly JitsiChatMessage[] {
  const combined = [...existing, next];
  return combined.length <= MAX_CHAT_MESSAGES
    ? combined
    : combined.slice(combined.length - MAX_CHAT_MESSAGES);
}
