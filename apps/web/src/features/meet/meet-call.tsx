import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  VideoOff as CamOffIcon,
  MessageCircle as ChatIcon,
  Copy as CopyIcon,
  Hand as HandIcon,
  Info as InfoIcon,
  Mic as MicIcon,
  MicOff as MicOffIcon,
  Phone as PhoneIcon,
  Monitor as ScreenIcon,
  Settings as SettingsIcon,
  Users as UsersIcon,
  Video as VideoIcon,
} from "lucide-react";
/* MeetCall — the in-call view, always in the dark theme. Top bar with title,
   live REC pill, meeting details and elapsed timer; the Jitsi External API
   embed (the real room, when a token was minted) or a placeholder; a bottom
   control bar wired through the External API; and optional side panels.

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
import { useJitsiCall, type JitsiCallOptions } from "./jitsi-external-api";
import {
  CallOptionsPanel,
  ChatPanel,
  MiniAction,
  ParticipantRow,
  PolicyButton,
  SidePanel,
  UUID_PATTERN,
} from "./meet-call-panels";
import { copyMeetingLink, meetJoinLink } from "./meet-join";
import type { MeetCallSession } from "./meet-shell";
import { meetCallElapsedQueryOptions } from "./queries";

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
      media: session.media,
    };
  }, [
    hasLiveRoom,
    session.token,
    session.jitsiDomain,
    session.roomName,
    session.recordingActive,
    session.media,
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
    <main
      id="main-content"
      tabIndex={-1}
      aria-label="Active meeting"
      data-theme="dark"
      className="workspace bg-[var(--bg)] text-[var(--text)]"
    >
      {/* Top bar */}
      <div className="h-11 flex items-center [padding:0_16px] gap-3 shrink-0 [border-bottom:1px_solid_var(--border)]">
        <div className="flex items-center gap-2">
          <VideoIcon size={16} />
          <span className="font-semibold">{session.subject}</span>
        </div>
        {call.recordingActive ? (
          <span className="chip danger">
            <span className="chip-dot" />
            REC
          </span>
        ) : null}
        <MeetingDetails subject={session.subject} code={session.code} />
        <div className="ml-auto flex items-center gap-2 [color:var(--text-2)] type-meta">
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
          <div className="flex-1 relative rounded-lg overflow-hidden bg-[var(--surface)] min-h-0">
            <div
              ref={jitsiHostRef}
              className="absolute inset-0"
              aria-label={`Meeting: ${session.subject}`}
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
                <li className="[padding:12px_16px] [color:var(--text-3)] type-meta">
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
              <small className="[color:var(--text-2)]">Policy version {controls.version}</small>
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
      <div className="relative h-19 flex items-center justify-center gap-2 [padding:0_16px] shrink-0 [border-top:1px_solid_var(--border)]">
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

        <div aria-hidden="true" className="[width:1px] h-7 bg-[var(--border)] [margin:0_4px]" />

        <button
          type="button"
          onClick={() => {
            commands.hangup();
            leave();
          }}
          className="btn danger h-11"
        >
          <PhoneIcon size={16} className="rotate-[135deg]" aria-hidden="true" /> Leave
        </button>

        <div className="absolute right-4 flex items-center gap-2">
          <button
            className={cn(
              "btn sm",
              "[border-color:var(--border)] [color:var(--text)]",
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
                "[border-color:var(--border)] [color:var(--text)]",
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
        <div role="alert" className="[padding:8px_16px] [color:var(--danger)]">
          {recordingAuthorization.error instanceof Error
            ? recordingAuthorization.error.message
            : "Recording could not be authorized."}
        </div>
      ) : null}
      {hostControl.isError ? (
        <div role="alert" className="[padding:8px_16px] [color:var(--danger)]">
          {hostControl.error instanceof Error
            ? hostControl.error.message
            : "Host control was rejected."}
        </div>
      ) : null}
    </main>
  );
}

/** Meeting details: the title and the link to share, with Copy. */
function MeetingDetails({ subject, code }: { readonly subject: string; readonly code: string }) {
  const link = meetJoinLink(code);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-[var(--text-2)]"
          aria-label="Meeting details"
        >
          <InfoIcon aria-hidden="true" />
          <span className="mono type-meta">{code}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Meeting details" align="start" className="w-80">
        <p className="m-0 type-body-sm font-semibold">{subject}</p>
        <p className="m-0 mt-1 type-meta text-muted-foreground">Joining info</p>
        <div className="mt-2 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate type-meta">{link}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Copy joining info"
            onClick={() => {
              void copyMeetingLink(link);
            }}
          >
            <CopyIcon size={16} />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function RecordingNotice({ active }: { readonly active: boolean }) {
  if (!active) return null;
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="[padding:10px_16px] bg-[var(--label-red)] text-[var(--label-on)] font-bold text-center"
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
        "absolute inset-0 grid [place-items:center] type-body-sm pointer-events-none",
        tone === "error"
          ? "[background:color-mix(in_srgb,var(--danger)_25%,transparent)] [color:var(--danger)]"
          : "[background:color-mix(in_srgb,var(--bg)_65%,transparent)] [color:var(--text-2)]",
      )}
    >
      {message}
    </div>
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
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        "focus-ring relative w-11 h-11 [border-radius:999px] grid [place-items:center] [border:none]",
        danger
          ? "bg-[var(--label-red)] text-[var(--label-on)]"
          : active
            ? "bg-[var(--accent)] text-[var(--accent-fg)]"
            : "bg-[var(--surface-3)] text-[var(--text)]",
        disabled ? "cursor-not-allowed [opacity:0.5]" : "cursor-pointer",
      )}
    >
      {children}
      {badge !== undefined && badge !== null && badge > 0 ? (
        <span
          aria-hidden="true"
          className="absolute [top:-2px] [right:-2px] min-w-4 h-4 [padding:0_4px] [border-radius:999px] bg-[var(--label-red)] text-[var(--label-on)] type-chip font-semibold grid [place-items:center]"
        >
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
}
