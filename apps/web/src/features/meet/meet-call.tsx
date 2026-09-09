/* MeetCall — the in-call view. Dark theme regardless of the user's theme
   (`#0a0a0b` background). Top bar with title / live REC pill / meeting code /
   elapsed timer; a Jitsi External API embed (the real room, when a token was
   minted) or a placeholder when offline; a 76px control bar with controls
   wired through the External API; and an optional 320px in-call chat panel.

   The view is wired to a real backend room carried in via `session`: the
   subject/code come from `meet.create-room`/`meet.meetings.list`, the embed
   loads through JitsiMeetExternalAPI from the configured Jitsi domain, and
   Leave disconnects only the local participant. */

import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { sessionUserQueryOptions } from "@/lib/auth";
import { meetCallElapsedQueryOptions } from "./queries";
import {
  applyMeetHostControl,
  authorizeMeetRecordingStart,
  recordMeetTelemetry,
  type MeetTelemetryEvent,
  type MeetHostControl,
} from "./api";
import {
  useJitsiCall,
  type JitsiCallCommands,
  type JitsiCallOptions,
  type JitsiCallState,
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
  const sessionQuery = useQuery(sessionUserQueryOptions());
  const [chatOpen, setChatOpen] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [hostControlsOpen, setHostControlsOpen] = useState(false);
  const [callOptionsOpen, setCallOptionsOpen] = useState(false);
  const [controls, setControls] = useState(session.controls);
  const leftRef = useRef(false);

  const callStartRef = useRef(session.startedAtMs);
  const elapsedQuery = useQuery(meetCallElapsedQueryOptions(callStartRef.current));
  const elapsed = elapsedQuery.data ?? 0;

  const hasLiveRoom = session.roomId.length > 0;
  const jitsiHostRef = useRef<HTMLDivElement | null>(null);

  // Build the External API options only once we have a token; pass null
  // otherwise so the hook keeps the call torn down.
  const jitsiOptions = useMemo<JitsiCallOptions | null>(() => {
    if (!hasLiveRoom || session.token === null) return null;
    const displayName = sessionQuery.data?.name ?? sessionQuery.data?.email ?? "Helix user";
    return {
      domain: session.jitsiDomain,
      roomName: session.roomName,
      jwt: session.token,
      initialRecordingActive: session.recordingActive,
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
    session.recordingActive,
    sessionQuery.data?.name,
    sessionQuery.data?.email,
  ]);

  const leave = useCallback(() => {
    if (leftRef.current) return;
    leftRef.current = true;
    onLeave();
  }, [onLeave]);
  const reportTelemetry = useCallback(
    (event: MeetTelemetryEvent) => {
      void recordMeetTelemetry(session.roomId, event).catch(() => undefined);
    },
    [session.roomId],
  );

  const { state: call, commands } = useJitsiCall({
    options: jitsiOptions,
    hostRef: jitsiHostRef,
    onLeft: leave,
    onTelemetry: reportTelemetry,
  });
  const recordingAuthorization = useMutation({
    mutationFn: () => authorizeMeetRecordingStart(session.roomId),
    onMutate: () => undefined,
    onSuccess: commands.startRecording,
    onError: () => undefined,
  });
  const hostControl = useMutation({
    mutationFn: (control: MeetHostControl) => applyMeetHostControl(session.roomId, control),
    onMutate: () => undefined,
    onSuccess: (result) => {
      setControls(result.state);
      commands.applyMediaCommands(result.mediaCommands);
    },
    onError: () => undefined,
  });
  const applyControl = (control: MeetHostControl) => {
    if (!hostControl.isPending) hostControl.mutate(control);
  };

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
          <button
            className="icon-btn"
            type="button"
            aria-label="Meeting settings"
            disabled={!session.canModerate}
            onClick={() => {
              setHostControlsOpen((value) => !value);
            }}
          >
            <Icons.Settings />
          </button>
        </div>
      </div>

      <RecordingNotice active={call.recordingActive} />

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
              <Overlay message={`Couldn't load Jitsi: ${call.loadError}`} tone="error" />
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
                <ParticipantRow key={p.id} name={p.displayName}>
                  {session.canModerate ? (
                    <span style={{ display: "flex", gap: 4 }}>
                      <MiniAction
                        label="Mute"
                        onClick={() => {
                          applyControl({
                            action: "mute",
                            participantSubject: p.participantSubject,
                            mediaParticipantId: p.id,
                            mediaType: "audio",
                          });
                        }}
                      />
                      <MiniAction
                        label="Present"
                        onClick={() => {
                          applyControl({
                            action: "set_presenter",
                            policy: "selected",
                            participantSubject: p.participantSubject,
                            mediaParticipantId: p.id,
                          });
                        }}
                      />
                      {UUID_PATTERN.test(p.participantSubject) ? (
                        <>
                          <MiniAction
                            label="Cohost"
                            onClick={() => {
                              applyControl({
                                action: "set_cohost",
                                actorId: p.participantSubject,
                                mediaParticipantId: p.id,
                                enabled: true,
                              });
                            }}
                          />
                          {controls.hostActorId === sessionQuery.data?.actorId ? (
                            <MiniAction
                              label="Transfer host"
                              onClick={() => {
                                applyControl({
                                  action: "transfer_host",
                                  actorId: p.participantSubject,
                                  mediaParticipantId: p.id,
                                });
                              }}
                            />
                          ) : null}
                        </>
                      ) : null}
                      <MiniAction
                        label="Remove"
                        onClick={() => {
                          applyControl({
                            action: "remove",
                            participantSubject: p.participantSubject,
                            mediaParticipantId: p.id,
                            ban: false,
                          });
                        }}
                      />
                      <MiniAction
                        label="Ban"
                        onClick={() => {
                          applyControl({
                            action: "remove",
                            participantSubject: p.participantSubject,
                            mediaParticipantId: p.id,
                            ban: true,
                          });
                        }}
                      />
                    </span>
                  ) : null}
                </ParticipantRow>
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

        {session.canModerate && hostControlsOpen ? (
          <SidePanel
            title="Host controls"
            onClose={() => {
              setHostControlsOpen(false);
            }}
            icon={<Icons.Settings />}
          >
            <div style={{ padding: 12, display: "grid", gap: 8 }}>
              <PolicyButton
                label={`Lobby: ${controls.lobbyEnabled ? "on" : "off"}`}
                onClick={() => {
                  applyControl({ action: "set_lobby", enabled: !controls.lobbyEnabled });
                }}
              />
              <PolicyButton
                label={`Meeting: ${controls.locked ? "locked" : "open"}`}
                onClick={() => {
                  applyControl({ action: "set_lock", locked: !controls.locked });
                }}
              />
              <PolicyButton
                label={`Microphones: ${controls.mutePolicy}`}
                onClick={() => {
                  applyControl({
                    action: "set_mute_policy",
                    policy: controls.mutePolicy === "open" ? "moderated" : "open",
                  });
                }}
              />
              <PolicyButton
                label={`Presenters: ${controls.presenterPolicy}`}
                onClick={() => {
                  applyControl({
                    action: "set_presenter",
                    policy: controls.presenterPolicy === "everyone" ? "hosts" : "everyone",
                  });
                }}
              />
              <PolicyButton
                label={`Chat: ${controls.chatPolicy}`}
                onClick={() => {
                  applyControl({
                    action: "set_chat_policy",
                    policy: controls.chatPolicy === "everyone" ? "disabled" : "everyone",
                  });
                }}
              />
              <PolicyButton
                label={`Reactions: ${controls.reactionPolicy}`}
                onClick={() => {
                  applyControl({
                    action: "set_reaction_policy",
                    policy: controls.reactionPolicy === "everyone" ? "disabled" : "everyone",
                  });
                }}
              />
              {call.knockingParticipants.map((participant) => (
                <PolicyButton
                  key={participant.id}
                  label={`Admit ${participant.displayName}`}
                  onClick={() => {
                    applyControl({
                      action: "admit",
                      participantSubject: participant.participantSubject,
                      mediaParticipantId: participant.id,
                    });
                  }}
                />
              ))}
              <small style={{ color: "#a1a1aa" }}>Policy version {controls.version}</small>
            </div>
          </SidePanel>
        ) : null}

        {callOptionsOpen ? (
          <CallOptionsPanel
            call={call}
            commands={commands}
            canModerate={session.canModerate}
            onClose={() => {
              setCallOptionsOpen(false);
            }}
          />
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
        {session.canStartRecording ? (
          <CallControl
            label={
              !session.recordingAvailable
                ? "Recording unavailable"
                : call.recordingActive
                  ? "Stop recording"
                  : "Start recording"
            }
            danger={call.recordingActive}
            disabled={
              !call.isJoined || !session.recordingAvailable || recordingAuthorization.isPending
            }
            onClick={() => {
              if (call.recordingActive) commands.stopRecording();
              else recordingAuthorization.mutate();
            }}
          >
            <RecordIcon />
          </CallControl>
        ) : null}
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
          onClick={() => {
            commands.hangup();
            leave();
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
            cursor: "pointer",
          }}
        >
          <Icons.Phone /> Leave
        </button>

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
            aria-label={participantsOpen ? "Hide participants" : "Show participants"}
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
          {Object.values(call.capabilities).some(Boolean) ? (
            <button
              className="btn sm"
              type="button"
              aria-label={callOptionsOpen ? "Hide call options" : "Show call options"}
              disabled={!call.isJoined}
              onClick={() => {
                setCallOptionsOpen((value) => !value);
              }}
              style={{
                background: callOptionsOpen ? "var(--accent)" : "transparent",
                borderColor: DARK_BORDER,
                color: "#ededee",
              }}
            >
              <Icons.Settings />
            </button>
          ) : null}
        </div>
      </div>
      {recordingAuthorization.isError ? (
        <div role="alert" style={{ padding: "8px 16px", color: "#fecaca" }}>
          {recordingAuthorization.error instanceof Error
            ? recordingAuthorization.error.message
            : "Recording could not be authorized."}
        </div>
      ) : null}
      {hostControl.isError ? (
        <div role="alert" style={{ padding: "8px 16px", color: "#fecaca" }}>
          {hostControl.error instanceof Error
            ? hostControl.error.message
            : "Host control was rejected."}
        </div>
      ) : null}
    </div>
  );
}

function CallOptionsPanel({
  call,
  commands,
  canModerate,
  onClose,
}: {
  readonly call: JitsiCallState;
  readonly commands: JitsiCallCommands;
  readonly canModerate: boolean;
  readonly onClose: () => void;
}) {
  const breakoutRooms = call.breakoutRooms.filter((room) => !room.isMainRoom);
  return (
    <SidePanel title="Call options" icon={<Icons.Settings />} onClose={onClose}>
      <div style={{ padding: 12, display: "grid", gap: 8 }}>
        {call.capabilities.tileView ? (
          <PolicyButton
            label={call.tileView === true ? "Use speaker layout" : "Use tile layout"}
            onClick={commands.toggleTileView}
          />
        ) : null}
        {call.capabilities.noiseSuppression ? (
          <PolicyButton
            label={
              call.noiseSuppressionEnabled === true
                ? "Disable noise suppression"
                : "Enable noise suppression"
            }
            onClick={() => {
              commands.setNoiseSuppression(call.noiseSuppressionEnabled !== true);
            }}
          />
        ) : null}
        {call.capabilities.backgroundBlur ? (
          <PolicyButton
            label={call.backgroundBlurred === true ? "Remove background blur" : "Blur background"}
            onClick={() => {
              commands.setBackgroundBlur(call.backgroundBlurred !== true);
            }}
          />
        ) : null}
        {call.capabilities.breakoutRooms && canModerate ? (
          <section aria-label="Breakout rooms" style={{ display: "grid", gap: 8, marginTop: 8 }}>
            <strong style={{ fontSize: "var(--text-body-sm)" }}>Breakout rooms</strong>
            <PolicyButton label="Add breakout room" onClick={commands.addBreakoutRoom} />
            <PolicyButton
              label="Auto-assign participants"
              onClick={commands.autoAssignBreakoutRooms}
            />
            {breakoutRooms.length > 0 ? (
              <PolicyButton
                label="Return to main room"
                onClick={() => {
                  commands.joinBreakoutRoom();
                }}
              />
            ) : null}
            {breakoutRooms.map((room) => (
              <div
                key={room.id}
                style={{ display: "grid", gap: 6, padding: 8, border: `1px solid ${DARK_BORDER}` }}
              >
                <span style={{ fontSize: "var(--text-meta)" }}>
                  {room.name} ({String(room.participantCount)})
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <MiniAction
                    label={`Join ${room.name}`}
                    onClick={() => {
                      commands.joinBreakoutRoom(room.id);
                    }}
                  />
                  <MiniAction
                    label={`Close ${room.name}`}
                    onClick={() => {
                      commands.closeBreakoutRoom(room.id);
                    }}
                  />
                </div>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </SidePanel>
  );
}

export function RecordingNotice({ active }: { readonly active: boolean }) {
  if (!active) return null;
  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        padding: "10px 16px",
        background: "#991b1b",
        color: "white",
        fontWeight: 700,
        textAlign: "center",
      }}
    >
      Recording in progress — audio, video, and shared content are being captured.
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

function ParticipantRow({
  name,
  badge,
  children,
}: {
  readonly name: string;
  readonly badge?: string | null;
  readonly children?: React.ReactNode;
}) {
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
      {children}
    </li>
  );
}

function MiniAction({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <button type="button" className="btn sm" onClick={onClick} aria-label={label}>
      {label}
    </button>
  );
}

function PolicyButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" className="btn" onClick={onClick}>
      {label}
    </button>
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
