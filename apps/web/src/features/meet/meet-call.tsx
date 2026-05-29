/* MeetCall — the in-call view. Dark theme regardless of the user's theme
   (`#0a0a0b` background). Top bar with title / live REC pill / meeting code /
   elapsed timer; a Jitsi External API embed (the real room, when a token was
   minted) or a placeholder when offline; a 76px control bar with controls
   wired through the External API; and an optional 320px in-call chat panel.

   The view is wired to a real backend room carried in via `session`: the
   subject/code come from `meet.create-room`/`meet.meetings.list`, the embed
   loads through JitsiMeetExternalAPI from the configured Jitsi domain, and
   Leave ends the room through `meet.end-room`. */

import { useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { sessionUserQueryOptions } from "@/lib/auth";
import { endMeetRoom } from "./api";
import { meetCallElapsedQueryOptions, meetQueryKeys } from "./queries";
import {
  useJitsiCall,
  type JitsiCallOptions,
  type JitsiChatMessage,
} from "./jitsi-external-api";
import type { MeetCallSession } from "./meet-shell";

const DARK_BORDER = "#27272d";
const DARK_BG = "#0a0a0b";
const DARK_PANEL = "#131316";

/** Format an elapsed-second count as `M:SS` or `H:MM:SS`. */
export function formatElapsed(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return hours > 0
    ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${String(minutes)}:${pad(seconds)}`;
}

export interface MeetCallProps {
  readonly session: MeetCallSession;
  readonly onLeave: () => void;
}

export function MeetCall({ session, onLeave }: MeetCallProps) {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery(sessionUserQueryOptions());
  const [chatOpen, setChatOpen] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const callStartRef = useRef(session.startedAtMs);
  const elapsedQuery = useQuery(meetCallElapsedQueryOptions(callStartRef.current));
  const elapsed = elapsedQuery.data ?? 0;

  const hasLiveRoom = session.roomId.length > 0 && session.token !== null;
  const jitsiHostRef = useRef<HTMLDivElement | null>(null);

  // Build the External API options only once we have a token; pass null
  // otherwise so the hook keeps the call torn down.
  const jitsiOptions = useMemo<JitsiCallOptions | null>(() => {
    if (!hasLiveRoom || session.token === null) return null;
    const displayName =
      sessionQuery.data?.name ?? sessionQuery.data?.email ?? "Helix user";
    return {
      domain: session.jitsiDomain,
      roomName: session.roomName,
      jwt: session.token,
      userInfo: {
        displayName,
        email: sessionQuery.data?.email ?? null,
      },
    };
  }, [
    hasLiveRoom,
    session.token,
    session.jitsiDomain,
    session.roomName,
    sessionQuery.data?.name,
    sessionQuery.data?.email,
  ]);

  // Leave → end the backend room (only when we own a real room), then exit.
  const leaveMutation = useMutation({
    mutationFn: async () => {
      if (hasLiveRoom) {
        await endMeetRoom(session.roomId);
      }
    },
    onMutate: () => {
      setLeaveError(null);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: meetQueryKeys.all });
      onLeave();
    },
    onError: (error: unknown) => {
      setLeaveError(error instanceof Error ? error.message : "Could not end the meeting.");
    },
  });

  const { state: call, commands } = useJitsiCall({
    options: jitsiOptions,
    hostRef: jitsiHostRef,
    onLeft: () => {
      // Jitsi hangup or readyToClose → run the same backend cleanup as the
      // Leave button so we don't leave a zombie room behind.
      if (!leaveMutation.isPending) {
        leaveMutation.mutate();
      }
    },
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: DARK_BG,
        color: "#ededee",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          height: 44,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 12,
          borderBottom: `1px solid ${DARK_BORDER}`,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icons.Video />
          <span style={{ fontWeight: 600 }}>{session.subject}</span>
        </div>
        {call.recordingActive ? (
          <span
            className="chip"
            style={{
              background: "rgba(220,38,38,0.15)",
              color: "#f87171",
              borderColor: "transparent",
            }}
          >
            <span className="chip-dot" />
            REC
          </span>
        ) : null}
        <span style={{ fontSize: "var(--text-meta)", color: "#a1a1aa" }}>
          helix.meet/{session.code}
        </span>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "#a1a1aa",
            fontSize: "var(--text-meta)",
          }}
        >
          <span style={{ fontVariantNumeric: "tabular-nums" }} aria-label="Elapsed time">
            {formatElapsed(elapsed)}
          </span>
          <button className="icon-btn" type="button" aria-label="Meeting settings">
            <Icons.Settings />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Main stage — Jitsi External API mounts its iframe inside the host
            ref. We always render the host so the ref stays attached. */}
        <div
          style={{
            flex: 1,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minWidth: 0,
          }}
        >
          <div
            style={{
              flex: 1,
              position: "relative",
              borderRadius: 8,
              overflow: "hidden",
              background: "#000",
              minHeight: 0,
            }}
          >
            <div
              ref={jitsiHostRef}
              style={{ position: "absolute", inset: 0 }}
              aria-label={`Jitsi meeting: ${session.subject}`}
            />
            {jitsiOptions === null ? (
              <Overlay message="Waiting for the meeting room to connect…" />
            ) : call.loadError !== null ? (
              <Overlay
                message={`Couldn't load Jitsi: ${call.loadError}`}
                tone="error"
              />
            ) : !call.isReady ? (
              <Overlay message="Loading meeting room…" />
            ) : !call.isJoined ? (
              <Overlay message="Joining…" />
            ) : null}
          </div>
        </div>

        {/* Participant rail */}
        {participantsOpen ? (
          <SidePanel
            title={`In this call (${String(call.participants.length + (call.isJoined ? 1 : 0))})`}
            onClose={() => {
              setParticipantsOpen(false);
            }}
            icon={<Icons.Users />}
          >
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {call.isJoined ? (
                <ParticipantRow
                  name={`${sessionQuery.data?.name ?? "You"} (you)`}
                  badge={call.audioMuted ? "muted" : null}
                />
              ) : null}
              {call.participants.map((p) => (
                <ParticipantRow key={p.id} name={p.displayName} />
              ))}
              {call.participants.length === 0 && call.isJoined ? (
                <li
                  style={{
                    padding: "12px 16px",
                    color: "#71717a",
                    fontSize: "var(--text-meta)",
                  }}
                >
                  No one else has joined yet.
                </li>
              ) : null}
            </ul>
          </SidePanel>
        ) : null}

        {/* In-call chat panel */}
        {chatOpen ? (
          <ChatPanel
            messages={call.chatMessages}
            onClose={() => {
              setChatOpen(false);
            }}
            onSend={(text) => {
              commands.sendChatMessage(text);
            }}
          />
        ) : null}
      </div>

      {/* Bottom control bar */}
      <div
        style={{
          position: "relative",
          height: 76,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          borderTop: `1px solid ${DARK_BORDER}`,
          padding: "0 16px",
          flexShrink: 0,
        }}
      >
        <CallControl
          label={call.audioMuted ? "Unmute microphone" : "Mute microphone"}
          danger={call.audioMuted}
          disabled={!call.isJoined}
          onClick={commands.toggleAudio}
        >
          {call.audioMuted ? <Icons.MicOff /> : <Icons.Mic />}
        </CallControl>
        <CallControl
          label={call.videoMuted ? "Turn on camera" : "Turn off camera"}
          danger={call.videoMuted}
          disabled={!call.isJoined}
          onClick={commands.toggleVideo}
        >
          {call.videoMuted ? <Icons.CamOff /> : <Icons.Video />}
        </CallControl>
        <CallControl
          label={call.screenSharing ? "Stop sharing screen" : "Share screen"}
          active={call.screenSharing}
          disabled={!call.isJoined}
          onClick={commands.toggleShareScreen}
        >
          <Icons.Screen />
        </CallControl>
        <CallControl
          label={call.handRaised ? "Lower hand" : "Raise hand"}
          active={call.handRaised}
          disabled={!call.isJoined}
          onClick={commands.toggleRaiseHand}
        >
          <Icons.Hand />
        </CallControl>
        <CallControl
          label={call.recordingActive ? "Stop recording" : "Start recording"}
          danger={call.recordingActive}
          disabled={!call.isJoined}
          onClick={() => {
            if (call.recordingActive) commands.stopRecording();
            else commands.startRecording();
          }}
        >
          <RecordIcon />
        </CallControl>
        <CallControl
          label={chatOpen ? "Hide in-call messages" : "Show in-call messages"}
          active={chatOpen}
          badge={call.unreadChatCount > 0 ? call.unreadChatCount : null}
          onClick={() => {
            setChatOpen((value) => {
              const next = !value;
              if (next) commands.markChatRead();
              return next;
            });
          }}
        >
          <Icons.Chat />
        </CallControl>

        <div style={{ width: 1, height: 28, background: DARK_BORDER, margin: "0 4px" }} />

        <button
          type="button"
          disabled={leaveMutation.isPending}
          onClick={() => {
            setLeaveError(null);
            commands.hangup();
            // hangup fires videoConferenceLeft which triggers backend cleanup
            // via onLeft; this is a belt-and-suspenders direct call too.
            leaveMutation.mutate();
          }}
          style={{
            height: 44,
            padding: "0 18px",
            borderRadius: 999,
            background: "#dc2626",
            color: "white",
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontWeight: 500,
            border: "none",
            cursor: leaveMutation.isPending ? "default" : "pointer",
            opacity: leaveMutation.isPending ? 0.7 : 1,
          }}
        >
          <Icons.Phone /> {leaveMutation.isPending ? "Leaving…" : "Leave"}
        </button>

        {leaveError !== null ? (
          <span
            role="alert"
            style={{
              position: "absolute",
              left: 16,
              fontSize: "var(--text-caption)",
              color: "#f87171",
            }}
          >
            {leaveError}
          </span>
        ) : null}

        <div
          style={{
            position: "absolute",
            right: 16,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <button
            className="btn sm"
            type="button"
            aria-label={
              participantsOpen ? "Hide participants" : "Show participants"
            }
            onClick={() => {
              setParticipantsOpen((v) => !v);
            }}
            style={{
              background: participantsOpen ? "var(--accent)" : "transparent",
              borderColor: DARK_BORDER,
              color: "#ededee",
            }}
          >
            <Icons.Users />
          </button>
        </div>
      </div>
    </div>
  );
}

function Overlay({
  message,
  tone = "info",
}: {
  readonly message: string;
  readonly tone?: "info" | "error";
}) {
  return (
    <div
      role="status"
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        placeItems: "center",
        background: tone === "error" ? "rgba(127,29,29,0.4)" : "rgba(0,0,0,0.65)",
        color: tone === "error" ? "#fecaca" : "#a1a1aa",
        fontSize: "var(--text-body-sm)",
        pointerEvents: "none",
      }}
    >
      {message}
    </div>
  );
}

function SidePanel({
  title,
  icon,
  children,
  onClose,
  ariaLabel,
}: {
  readonly title: string;
  readonly icon: React.ReactNode;
  readonly children: React.ReactNode;
  readonly onClose: () => void;
  readonly ariaLabel?: string;
}) {
  return (
    <div
      aria-label={ariaLabel ?? title}
      style={{
        width: 320,
        borderLeft: `1px solid ${DARK_BORDER}`,
        display: "flex",
        flexDirection: "column",
        background: DARK_PANEL,
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          borderBottom: `1px solid ${DARK_BORDER}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {icon}
        <span style={{ fontWeight: 600, fontSize: "var(--text-body-sm)" }}>{title}</span>
        <button
          className="icon-btn"
          style={{ marginLeft: "auto" }}
          type="button"
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          <Icons.X />
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>{children}</div>
    </div>
  );
}

function ParticipantRow({ name, badge }: { readonly name: string; readonly badge?: string | null }) {
  return (
    <li
      style={{
        padding: "10px 16px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        borderBottom: `1px solid ${DARK_BORDER}`,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 28,
          height: 28,
          borderRadius: 999,
          background: "#3f3f46",
          display: "grid",
          placeItems: "center",
          color: "#ededee",
          fontSize: 12,
        }}
      >
        {initials(name)}
      </span>
      <span style={{ flex: 1, fontSize: "var(--text-body-sm)" }}>{name}</span>
      {badge !== undefined && badge !== null ? (
        <span
          style={{
            fontSize: "var(--text-caption)",
            color: "#f87171",
          }}
        >
          {badge}
        </span>
      ) : null}
    </li>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === undefined) return "?";
  if (parts.length === 1) return (parts[0][0] ?? "?").toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return `${(parts[0][0] ?? "").toUpperCase()}${(last[0] ?? "").toUpperCase()}`;
}

function ChatPanel({
  messages,
  onSend,
  onClose,
}: {
  readonly messages: readonly JitsiChatMessage[];
  readonly onSend: (text: string) => void;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <SidePanel title="In-call messages" icon={<Icons.Chat />} onClose={onClose}>
      <div
        style={{
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {messages.length === 0 ? (
          <p
            style={{
              margin: 0,
              color: "#71717a",
              fontSize: "var(--text-meta)",
              textAlign: "center",
              padding: "24px 0",
            }}
          >
            No messages yet. Say hi.
          </p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                alignSelf: m.isLocal ? "flex-end" : "flex-start",
                maxWidth: "85%",
              }}
            >
              <span
                style={{
                  fontSize: "var(--text-caption)",
                  color: "#71717a",
                  textAlign: m.isLocal ? "right" : "left",
                }}
              >
                {m.nick}
              </span>
              <span
                style={{
                  background: m.isLocal ? "var(--accent)" : "#27272d",
                  color: "white",
                  padding: "6px 10px",
                  borderRadius: 10,
                  fontSize: "var(--text-body-sm)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {m.message}
              </span>
            </div>
          ))
        )}
      </div>
      <form
        style={{
          padding: 10,
          borderTop: `1px solid ${DARK_BORDER}`,
          display: "flex",
          gap: 6,
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim().length === 0) return;
          onSend(draft);
          setDraft("");
        }}
      >
        <input
          aria-label="Message everyone in the call"
          placeholder="Message everyone in the call"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          style={{
            flex: 1,
            height: 30,
            padding: "0 10px",
            borderRadius: 6,
            border: `1px solid ${DARK_BORDER}`,
            background: DARK_BG,
            color: "#ededee",
            outline: "none",
            fontSize: "var(--text-meta)",
          }}
        />
        <button
          type="submit"
          aria-label="Send message"
          disabled={draft.trim().length === 0}
          style={{
            height: 30,
            padding: "0 10px",
            borderRadius: 6,
            border: "none",
            background: "var(--accent)",
            color: "white",
            cursor: "pointer",
            opacity: draft.trim().length === 0 ? 0.5 : 1,
          }}
        >
          Send
        </button>
      </form>
    </SidePanel>
  );
}

function RecordIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5" fill="currentColor" />
    </svg>
  );
}

function CallControl({
  label,
  children,
  onClick,
  active = false,
  danger = false,
  disabled = false,
  badge,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly onClick: () => void;
  readonly active?: boolean;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly badge?: number | null;
}) {
  const background = danger ? "#dc2626" : active ? "var(--accent)" : DARK_BORDER;
  const style: CSSProperties = {
    position: "relative",
    width: 44,
    height: 44,
    borderRadius: 999,
    background,
    color: "white",
    display: "grid",
    placeItems: "center",
    border: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      style={style}
    >
      {children}
      {badge !== undefined && badge !== null && badge > 0 ? (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -2,
            right: -2,
            minWidth: 16,
            height: 16,
            padding: "0 4px",
            borderRadius: 999,
            background: "#dc2626",
            color: "white",
            fontSize: 10,
            fontWeight: 600,
            display: "grid",
            placeItems: "center",
          }}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
}
