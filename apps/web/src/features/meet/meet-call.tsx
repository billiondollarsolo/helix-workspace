/* MeetCall — the in-call view. Dark theme regardless of the user's theme
   (`#0a0a0b` background). Top bar with title / REC pill / meeting code /
   elapsed timer; a Jitsi embed (the real room, when a token was minted) or a
   seed speaker stage as offline fallback; a 76px control bar; and an optional
   320px in-call chat panel.

   The view is wired to a real backend room carried in via `session`: the
   subject/code come from `meet.create-room`/`meet.meetings.list`, the embed
   loads the `meet.mint-token` join URL, and Leave ends the room through
   `meet.end-room`. */

import { useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { endMeetRoom } from "./api";
import { meetCallElapsedQueryOptions, meetQueryKeys } from "./queries";
import { CALL_MESSAGES, CALL_PARTICIPANTS, type MeetCallParticipant } from "./meet-seed";
import { MeetCallTile } from "./meet-call-tile";
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
  /** The live (or offline-fallback) call session for this in-call view. */
  readonly session: MeetCallSession;
  /** Called when the user has left the call (after `meet.end-room`). */
  readonly onLeave: () => void;
}

export function MeetCall({ session, onLeave }: MeetCallProps) {
  const queryClient = useQueryClient();
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  /* The call's wall-clock start. A 1s-refetch query re-renders the timer
     without a native interval (kept off the Pacer-banned timer APIs). */
  const callStartRef = useRef(session.startedAtMs);
  const elapsedQuery = useQuery(meetCallElapsedQueryOptions(callStartRef.current));
  const elapsed = elapsedQuery.data ?? 0;

  /* A real room + minted token → embed the live Jitsi call. Otherwise the
     offline-fallback seed stage renders. */
  const hasLiveRoom = session.roomId.length > 0;
  const embedUrl = session.joinUrl;

  /* Leave → end the backend room (only when we own a real room), then exit. */
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

  /* Reflect the local user's live mic/camera/hand state onto their tile. */
  const participants = useMemo<readonly MeetCallParticipant[]>(
    () =>
      CALL_PARTICIPANTS.map((participant) =>
        participant.you
          ? { ...participant, muted: !micOn, video: camOn, hand: handRaised }
          : participant,
      ),
    [micOn, camOn, handRaised],
  );

  const speaker =
    participants.find((participant) => participant.speaking) ?? participants[1];
  const others = participants.filter((participant) => participant.id !== speaker?.id);

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
        <span style={{ fontSize: 12, color: "#a1a1aa" }}>helix.meet/{session.code}</span>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "#a1a1aa",
            fontSize: 12,
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
        {/* Main stage — live Jitsi embed, or the offline-fallback seed stage. */}
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
          {embedUrl !== null ? (
            <iframe
              title={`Meeting: ${session.subject}`}
              src={embedUrl}
              allow="camera; microphone; fullscreen; display-capture; autoplay"
              style={{
                flex: 1,
                width: "100%",
                border: "none",
                borderRadius: 8,
                background: "#000",
                minHeight: 0,
              }}
            />
          ) : (
            <>
              <div style={{ flex: 1, minHeight: 0 }}>
                {speaker ? <MeetCallTile participant={speaker} big /> : null}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(5, 1fr)",
                  gap: 8,
                  flexShrink: 0,
                }}
              >
                {others.map((participant) => (
                  <MeetCallTile key={participant.id} participant={participant} />
                ))}
              </div>
            </>
          )}
        </div>

        {/* In-call chat panel */}
        {chatOpen ? (
          <div
            style={{
              width: 320,
              borderLeft: `1px solid ${DARK_BORDER}`,
              display: "flex",
              flexDirection: "column",
              background: DARK_PANEL,
            }}
            aria-label="In-call messages"
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
              <Icons.Chat />
              <span style={{ fontWeight: 600, fontSize: 13 }}>In-call messages</span>
              <button
                className="icon-btn"
                style={{ marginLeft: "auto" }}
                type="button"
                aria-label="Close in-call messages"
                onClick={() => {
                  setChatOpen(false);
                }}
              >
                <Icons.X />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
              {CALL_MESSAGES.map((message) => (
                <div key={message.id} style={{ marginBottom: 12 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 6,
                      marginBottom: 2,
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 500 }}>{message.name}</span>
                    <span style={{ fontSize: 10, color: "#71717a" }}>{message.time}</span>
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.5 }}>{message.text}</div>
                </div>
              ))}
            </div>
            <div style={{ padding: 10, borderTop: `1px solid ${DARK_BORDER}` }}>
              <input
                aria-label="Message everyone in the call"
                placeholder="Message everyone in the call"
                style={{
                  width: "100%",
                  height: 30,
                  padding: "0 10px",
                  borderRadius: 6,
                  border: `1px solid ${DARK_BORDER}`,
                  background: DARK_BG,
                  color: "#ededee",
                  outline: "none",
                  fontSize: 12,
                }}
              />
            </div>
          </div>
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
          label={micOn ? "Mute microphone" : "Unmute microphone"}
          danger={!micOn}
          onClick={() => {
            setMicOn((value) => !value);
          }}
        >
          {micOn ? <Icons.Mic /> : <Icons.MicOff />}
        </CallControl>
        <CallControl
          label={camOn ? "Turn off camera" : "Turn on camera"}
          danger={!camOn}
          onClick={() => {
            setCamOn((value) => !value);
          }}
        >
          {camOn ? <Icons.Video /> : <Icons.CamOff />}
        </CallControl>
        <CallControl
          label={screenSharing ? "Stop sharing screen" : "Share screen"}
          active={screenSharing}
          onClick={() => {
            setScreenSharing((value) => !value);
          }}
        >
          <Icons.Screen />
        </CallControl>
        <CallControl
          label={handRaised ? "Lower hand" : "Raise hand"}
          active={handRaised}
          onClick={() => {
            setHandRaised((value) => !value);
          }}
        >
          <Icons.Hand />
        </CallControl>
        <CallControl
          label={chatOpen ? "Hide in-call messages" : "Show in-call messages"}
          active={chatOpen}
          onClick={() => {
            setChatOpen((value) => !value);
          }}
        >
          <Icons.Chat />
        </CallControl>
        <CallControl
          label={aiOpen ? "Hide meeting AI" : "Meeting AI"}
          active={aiOpen}
          onClick={() => {
            setAiOpen((value) => !value);
          }}
        >
          <Icons.Sparkles />
        </CallControl>

        <div style={{ width: 1, height: 28, background: DARK_BORDER, margin: "0 4px" }} />

        <button
          type="button"
          disabled={leaveMutation.isPending}
          onClick={() => {
            setLeaveError(null);
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
              fontSize: 11,
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
            aria-label={`${String(participants.length)} participants`}
            style={{
              background: "transparent",
              borderColor: DARK_BORDER,
              color: "#ededee",
            }}
          >
            <Icons.Users /> {participants.length}
          </button>
        </div>
      </div>
    </div>
  );
}

function CallControl({
  label,
  children,
  onClick,
  active = false,
  danger = false,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly onClick: () => void;
  readonly active?: boolean;
  readonly danger?: boolean;
}) {
  const background = danger ? "#dc2626" : active ? "var(--accent)" : DARK_BORDER;
  const style: CSSProperties = {
    width: 44,
    height: 44,
    borderRadius: 999,
    background,
    color: "white",
    display: "grid",
    placeItems: "center",
    border: "none",
    cursor: "pointer",
  };
  return (
    <button type="button" onClick={onClick} aria-label={label} aria-pressed={active} style={style}>
      {children}
    </button>
  );
}
