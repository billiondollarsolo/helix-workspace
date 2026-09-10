import { cn } from "@/lib/utils";
import {
  VideoOff as CamOffIcon,
  MessageCircle as ChatIcon,
  Hand as HandIcon,
  Mic as MicIcon,
  MicOff as MicOffIcon,
  Phone as PhoneIcon,
  Monitor as ScreenIcon,
  Settings as SettingsIcon,
  Users as UsersIcon,
  Video as VideoIcon,
  X as XIcon,
} from "lucide-react";
/* MeetCall — the in-call view. Dark theme regardless of the user's theme
   (`#0a0a0b` background). Top bar with title / live REC pill / meeting code /
   elapsed timer; a Jitsi External API embed (the real room, when a token was
   minted) or a placeholder when offline; a 76px control bar with controls
   wired through the External API; and an optional 320px in-call chat panel.

   The view is wired to a real backend room carried in via `session`: the
   subject/code come from `meet.create-room`/`meet.meetings.list`, the embed
   loads through JitsiMeetExternalAPI from the configured Jitsi domain, and
   Leave disconnects only the local participant. */

import { sessionUserQueryOptions } from "@/lib/auth";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  applyMeetHostControl,
  authorizeMeetRecordingStart,
  recordMeetTelemetry,
  type MeetHostControl,
  type MeetTelemetryEvent,
} from "./api";
import {
  useJitsiCall,
  type JitsiCallCommands,
  type JitsiCallOptions,
  type JitsiCallState,
  type JitsiChatMessage,
} from "./jitsi-external-api";
import type { MeetCallSession } from "./meet-shell";
import { meetCallElapsedQueryOptions } from "./queries";

const DARK_BORDER = "#27272d";

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
    <div className="flex flex-col [height:100vh] [background:#0a0a0b] [color:#ededee]">
      {/* Top bar */}
      <div className="h-11 flex items-center [padding:0_16px] gap-3 shrink-0 [border-bottom:1px_solid_#27272d]">
        <div className="flex items-center gap-2">
          <VideoIcon size={16} />
          <span className="font-semibold">{session.subject}</span>
        </div>
        {call.recordingActive ? (
          <span className="chip [background:rgba(220,38,38,0.15)] [color:#f87171] [border-color:transparent]">
            <span className="chip-dot" />
            REC
          </span>
        ) : null}
        <span className="[font-size:var(--text-meta)] [color:#a1a1aa]">
          helix.meet/{session.code}
        </span>
        <div className="ml-auto flex items-center gap-2 [color:#a1a1aa] [font-size:var(--text-meta)]">
          <span className="[font-variant-numeric:tabular-nums]" aria-label="Elapsed time">
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
            <SettingsIcon size={16} />
          </button>
        </div>
      </div>

      <RecordingNotice active={call.recordingActive} />

      <div className="flex-1 flex min-h-0">
        {/* Main stage — Jitsi External API mounts its iframe inside the host
            ref. We always render the host so the ref stays attached. */}
        <div className="flex-1 p-4 flex flex-col gap-3 min-w-0">
          <div className="flex-1 relative rounded-lg overflow-hidden [background:#000] min-h-0">
            <div
              ref={jitsiHostRef}
              className="absolute inset-0"
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
            icon={<UsersIcon size={16} />}
          >
            <ul className="m-0 p-0 [list-style:none]">
              {call.isJoined ? (
                <ParticipantRow
                  name={`${sessionQuery.data?.name ?? "You"} (you)`}
                  badge={call.audioMuted ? "muted" : null}
                />
              ) : null}
              {call.participants.map((p) => (
                <ParticipantRow key={p.id} name={p.displayName}>
                  {session.canModerate ? (
                    <span className="flex gap-1">
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
                <li className="[padding:12px_16px] [color:#71717a] [font-size:var(--text-meta)]">
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
            icon={<SettingsIcon size={16} />}
          >
            <div className="p-3 grid gap-2">
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
              <small className="[color:#a1a1aa]">Policy version {controls.version}</small>
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
      <div className="relative h-19 flex items-center justify-center gap-2 [padding:0_16px] shrink-0 [border-top:1px_solid_#27272d]">
        <CallControl
          label={call.audioMuted ? "Unmute microphone" : "Mute microphone"}
          danger={call.audioMuted}
          disabled={!call.isJoined}
          onClick={commands.toggleAudio}
        >
          {call.audioMuted ? <MicOffIcon size={16} /> : <MicIcon size={16} />}
        </CallControl>
        <CallControl
          label={call.videoMuted ? "Turn on camera" : "Turn off camera"}
          danger={call.videoMuted}
          disabled={!call.isJoined}
          onClick={commands.toggleVideo}
        >
          {call.videoMuted ? <CamOffIcon size={16} /> : <VideoIcon size={16} />}
        </CallControl>
        <CallControl
          label={call.screenSharing ? "Stop sharing screen" : "Share screen"}
          active={call.screenSharing}
          disabled={!call.isJoined}
          onClick={commands.toggleShareScreen}
        >
          <ScreenIcon size={16} />
        </CallControl>
        <CallControl
          label={call.handRaised ? "Lower hand" : "Raise hand"}
          active={call.handRaised}
          disabled={!call.isJoined}
          onClick={commands.toggleRaiseHand}
        >
          <HandIcon size={16} />
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
          <ChatIcon size={16} />
        </CallControl>

        <div className="[width:1px] h-7 [background:#27272d] [margin:0_4px]" />

        <button
          type="button"
          onClick={() => {
            commands.hangup();
            leave();
          }}
          className="h-11 [padding:0_18px] [border-radius:999px] [background:#dc2626] [color:white] flex items-center gap-1.5 font-medium [border:none] cursor-pointer"
        >
          <PhoneIcon size={16} /> Leave
        </button>

        <div className="absolute right-4 flex items-center gap-2">
          <button
            className={cn(
              "btn sm",
              "[border-color:#27272d] [color:#ededee]",
              participantsOpen ? "[background:var(--accent)]" : "bg-transparent",
            )}
            type="button"
            aria-label={participantsOpen ? "Hide participants" : "Show participants"}
            onClick={() => {
              setParticipantsOpen((v) => !v);
            }}
          >
            <UsersIcon size={16} />
          </button>
          {Object.values(call.capabilities).some(Boolean) ? (
            <button
              className={cn(
                "btn sm",
                "[border-color:#27272d] [color:#ededee]",
                callOptionsOpen ? "[background:var(--accent)]" : "bg-transparent",
              )}
              type="button"
              aria-label={callOptionsOpen ? "Hide call options" : "Show call options"}
              disabled={!call.isJoined}
              onClick={() => {
                setCallOptionsOpen((value) => !value);
              }}
            >
              <SettingsIcon size={16} />
            </button>
          ) : null}
        </div>
      </div>
      {recordingAuthorization.isError ? (
        <div role="alert" className="[padding:8px_16px] [color:#fecaca]">
          {recordingAuthorization.error instanceof Error
            ? recordingAuthorization.error.message
            : "Recording could not be authorized."}
        </div>
      ) : null}
      {hostControl.isError ? (
        <div role="alert" className="[padding:8px_16px] [color:#fecaca]">
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
    <SidePanel title="Call options" icon={<SettingsIcon size={16} />} onClose={onClose}>
      <div className="p-3 grid gap-2">
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
          <section aria-label="Breakout rooms" className="grid gap-2 mt-2">
            <strong className="[font-size:var(--text-body-sm)]">Breakout rooms</strong>
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
              <div key={room.id} className="grid gap-1.5 p-2 [border:1px_solid_#27272d]">
                <span className="[font-size:var(--text-meta)]">
                  {room.name} ({String(room.participantCount)})
                </span>
                <div className="flex gap-1.5">
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
      className="[padding:10px_16px] [background:#991b1b] [color:white] font-bold text-center"
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
      className={cn(
        "absolute inset-0 grid [place-items:center] [font-size:var(--text-body-sm)] pointer-events-none",
        tone === "error" ? "[background:rgba(127,29,29,0.4)]" : "[background:rgba(0,0,0,0.65)]",
        tone === "error" ? "[color:#fecaca]" : "[color:#a1a1aa]",
      )}
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
      className="w-80 flex flex-col [background:#131316] [border-left:1px_solid_#27272d]"
    >
      <div className="[padding:12px_16px] flex items-center gap-2 [border-bottom:1px_solid_#27272d]">
        {icon}
        <span className="font-semibold [font-size:var(--text-body-sm)]">{title}</span>
        <button
          className="icon-btn ml-auto"

          type="button"
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          <XIcon size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
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
    <li className="[padding:10px_16px] flex items-center gap-2.5 [border-bottom:1px_solid_#27272d]">
      <span
        aria-hidden="true"
        className="w-7 h-7 [border-radius:999px] [background:#3f3f46] grid [place-items:center] [color:#ededee] [font-size:12px]"
      >
        {initials(name)}
      </span>
      <span className="flex-1 [font-size:var(--text-body-sm)]">{name}</span>
      {badge !== undefined && badge !== null ? (
        <span className="[font-size:var(--text-caption)] [color:#f87171]">{badge}</span>
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
    <SidePanel title="In-call messages" icon={<ChatIcon size={16} />} onClose={onClose}>
      <div className="p-3 flex flex-col gap-2">
        {messages.length === 0 ? (
          <p className="m-0 [color:#71717a] [font-size:var(--text-meta)] text-center [padding:24px_0]">
            No messages yet. Say hi.
          </p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={cn(
                "flex flex-col gap-0.5 [max-width:85%]",
                m.isLocal ? "[align-self:flex-end]" : "[align-self:flex-start]",
              )}
            >
              <span
                className={cn(
                  "[font-size:var(--text-caption)] [color:#71717a]",
                  m.isLocal ? "text-right" : "text-left",
                )}
              >
                {m.nick}
              </span>
              <span
                className={cn(
                  "[color:white] [padding:6px_10px] [border-radius:10px] [font-size:var(--text-body-sm)] whitespace-pre-wrap [word-break:break-word]",
                  m.isLocal ? "[background:var(--accent)]" : "[background:#27272d]",
                )}
              >
                {m.message}
              </span>
            </div>
          ))
        )}
      </div>
      <form
        className="p-2.5 flex gap-1.5 [border-top:1px_solid_#27272d]"
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
          className="flex-1 h-7.5 [padding:0_10px] rounded-md [background:#0a0a0b] [color:#ededee] outline-none [font-size:var(--text-meta)] [border:1px_solid_#27272d]"
        />
        <button
          type="submit"
          aria-label="Send message"
          disabled={draft.trim().length === 0}
          className={cn(
            "h-7.5 [padding:0_10px] rounded-md [border:none] [background:var(--accent)] [color:white] cursor-pointer",
            draft.trim().length === 0 ? "[opacity:0.5]" : "[opacity:1]",
          )}
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
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        "relative w-11 h-11 [border-radius:999px] [color:white] grid [place-items:center] [border:none]",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
        disabled ? "[opacity:0.5]" : "[opacity:1]",
      )}
      style={{ background }}
    >
      {children}
      {badge !== undefined && badge !== null && badge > 0 ? (
        <span
          aria-hidden="true"
          className="absolute [top:-2px] [right:-2px] min-w-4 h-4 [padding:0_4px] [border-radius:999px] [background:#dc2626] [color:white] [font-size:10px] font-semibold grid [place-items:center]"
        >
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
}
