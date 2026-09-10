import { cn } from "@/lib/utils";
import { Link as LinkIcon, Plus as PlusIcon, Video as VideoIcon } from "lucide-react";
/* MeetHub — the Meet landing surface. A hero row (Start a call / Join with
   code), a "Today" panel of scheduled + active meetings, and a "Recent" panel
   of past meetings.

   Today and Recent are wired to the `meet.meetings.list` tool. The hero
   actions are wired to live tools: "Start instant meeting" → `meet.create-room`
   + `meet.mint-token`; "Schedule for later" → `meet.create-room` with a
   schedule window; "Get meeting link" → `meet.create-room` then a copyable
   join code. Joining a meeting mints a token via `meet.mint-token`.

   On query error we surface a "Meetings unavailable" indicator — never
   fabricated meeting rows. */

import { Avatar } from "@/components/ui/avatar";
import { Dialog } from "@/components/ui/helix-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import {
  createMeetRoom,
  joinMeetByCode,
  MEET_RECORDING_NOTICE_VERSION,
  mintMeetToken,
  type MeetMeetingRecord,
  type MeetRecordingConsent,
} from "./api";
import type { MeetCallSession } from "./meet-shell";
import {
  meetingToRecent,
  meetingToScheduled,
  type RecentMeeting,
  type ScheduledMeeting,
} from "./meet-taxonomy";
import { meetMeetingsQueryOptions, meetQueryKeys } from "./queries";
import { RecordingDrawer } from "./recording-drawer";

export interface MeetHubProps {
  /** Current search query from the surface frame; filters both panels. */
  readonly search?: string;
  /** Enter the in-call view with a live (or offline-fallback) call session. */
  readonly onEnterCall: (session: MeetCallSession) => void;
}

type PendingJoin =
  | { readonly kind: "start"; readonly subject: string }
  | { readonly kind: "meeting"; readonly meeting: MeetMeetingRecord }
  | { readonly kind: "code"; readonly code: string };

export function MeetHub({ search = "", onEnterCall }: MeetHubProps) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [linkRoom, setLinkRoom] = useState<{
    readonly code: string;
    readonly subject: string;
  } | null>(null);
  const [recordingsFor, setRecordingsFor] = useState<MeetMeetingRecord | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingJoin, setPendingJoin] = useState<PendingJoin | null>(null);

  const meetingsQuery = useQuery(meetMeetingsQueryOptions());

  const invalidate = () => queryClient.invalidateQueries({ queryKey: meetQueryKeys.all });

  const clearActionError = () => {
    setActionError(null);
  };

  /* meet.create-room + meet.mint-token → enter the in-call view. */
  const startMutation = useMutation({
    mutationFn: async (input: {
      readonly subject: string;
      readonly consent: MeetRecordingConsent;
    }) => {
      const room = await createMeetRoom({ subject: input.subject });
      const token = await mintMeetToken({ roomId: room.id, ...input.consent });
      return { room, token };
    },
    onMutate: clearActionError,
    onSuccess: ({ room, token }) => {
      void invalidate();
      onEnterCall({
        roomId: room.id,
        roomName: room.roomName,
        subject: room.subject,
        code: room.joinCode,
        jitsiDomain: token.jitsiDomain,
        token: token.token,
        joinUrl: token.joinUrl,
        recordingAvailable: token.recordingAvailable,
        canStartRecording: token.canStartRecording,
        recordingNoticeVersion: token.recordingNoticeVersion,
        recordingActive: token.recordingActive,
        controls: token.controls,
        canModerate: token.canModerate,
        startedAtMs: Date.parse(room.startedAt) || Date.now(),
      });
    },
    onError: (error: unknown) => {
      setActionError(messageOf(error));
    },
  });

  /* meet.create-room with a schedule window → adds a row to the Today panel. */
  const scheduleMutation = useMutation({
    mutationFn: (input: {
      readonly subject: string;
      readonly scheduledStartAt: string;
      readonly scheduledEndAt: string;
    }) =>
      createMeetRoom({
        subject: input.subject,
        scheduledStartAt: input.scheduledStartAt,
        scheduledEndAt: input.scheduledEndAt,
      }),
    onMutate: clearActionError,
    onSuccess: () => {
      void invalidate();
      setScheduleOpen(false);
    },
    onError: (error: unknown) => {
      setActionError(messageOf(error));
    },
  });

  /* meet.create-room → surface a copyable join code (no in-call entry). */
  const linkMutation = useMutation({
    mutationFn: () =>
      createMeetRoom({
        subject: "Helix meeting",
      }),
    onMutate: clearActionError,
    onSuccess: (room) => {
      void invalidate();
      setLinkRoom({ code: room.joinCode, subject: room.subject });
    },
    onError: (error: unknown) => {
      setActionError(messageOf(error));
    },
  });

  /* meet.mint-token for an existing room → enter the in-call view. */
  const joinMutation = useMutation({
    mutationFn: async (input: {
      readonly meeting: MeetMeetingRecord;
      readonly consent: MeetRecordingConsent;
    }) => {
      const token = await mintMeetToken({ roomId: input.meeting.id, ...input.consent });
      return { meeting: input.meeting, token };
    },
    onMutate: clearActionError,
    onSuccess: ({ meeting, token }) => {
      onEnterCall({
        roomId: meeting.id,
        roomName: meeting.roomName,
        subject: meeting.title || meeting.subject,
        code: meeting.code,
        jitsiDomain: token.jitsiDomain,
        token: token.token,
        joinUrl: token.joinUrl,
        recordingAvailable: token.recordingAvailable,
        canStartRecording: token.canStartRecording,
        recordingNoticeVersion: token.recordingNoticeVersion,
        recordingActive: token.recordingActive,
        controls: token.controls,
        canModerate: token.canModerate,
        startedAtMs: meeting.startedAt ? Date.parse(meeting.startedAt) || Date.now() : Date.now(),
      });
    },
    onError: (error: unknown) => {
      setActionError(messageOf(error));
    },
  });

  const codeJoinMutation = useMutation({
    mutationFn: (input: { readonly code: string; readonly consent: MeetRecordingConsent }) =>
      joinMeetByCode({ code: input.code, ...input.consent }),
    onMutate: clearActionError,
    onSuccess: (token) => {
      onEnterCall({
        roomId: token.roomId,
        roomName: token.roomName,
        subject: token.subject ?? "Helix meeting",
        code: token.code ?? code.trim(),
        jitsiDomain: token.jitsiDomain,
        token: token.token,
        joinUrl: token.joinUrl,
        recordingAvailable: token.recordingAvailable,
        canStartRecording: token.canStartRecording,
        recordingNoticeVersion: token.recordingNoticeVersion,
        recordingActive: token.recordingActive,
        controls: token.controls,
        canModerate: token.canModerate,
        startedAtMs: Date.now(),
      });
    },
    onError: () => {
      setActionError("No active meeting matches that code.");
    },
  });

  /* Today = backend scheduled + active meetings; Recent = backend ended.
     On error we render the error state, never fabricated rows. */
  const data = meetingsQuery.data;

  const scheduled = useMemo<readonly ScheduledMeeting[]>(
    () => (data ? [...data.active, ...data.scheduled].map(meetingToScheduled) : []),
    [data],
  );

  const recent = useMemo<readonly RecentMeeting[]>(
    () => (data ? data.recent.map(meetingToRecent) : []),
    [data],
  );

  /* Map listed rows by id; code joins use the backend's indexed lookup. */
  const meetingByRow = useMemo(() => {
    const map = new Map<string, MeetMeetingRecord>();
    for (const meeting of data?.meetings ?? []) {
      map.set(meeting.id, meeting);
    }
    return map;
  }, [data]);

  const query = search.trim().toLowerCase();
  const filteredScheduled =
    query.length > 0
      ? scheduled.filter(
          (m) =>
            m.title.toLowerCase().includes(query) ||
            m.host.toLowerCase().includes(query) ||
            m.code.toLowerCase().includes(query),
        )
      : scheduled;
  const filteredRecent =
    query.length > 0 ? recent.filter((m) => m.title.toLowerCase().includes(query)) : recent;

  const heroBusy = startMutation.isPending || linkMutation.isPending;

  function handleJoinRow(meeting: ScheduledMeeting) {
    setActionError(null);
    const backend = meeting.roomId ? meetingByRow.get(meeting.roomId) : undefined;
    if (backend && backend.status === "active") {
      setPendingJoin({ kind: "meeting", meeting: backend });
      return;
    }
    if (backend && backend.status === "scheduled") {
      setActionError("This meeting hasn't started yet.");
      return;
    }
    setActionError("This meeting is no longer available.");
  }

  function handleJoinByCode(event: FormEvent) {
    event.preventDefault();
    setActionError(null);
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setActionError("Enter a meeting code to join.");
      return;
    }
    setPendingJoin({ kind: "code", code: trimmed.toLowerCase() });
  }

  return (
    <div className="flex-1 overflow-y-auto bg-background">
      <div className="max-w-240 [margin:0_auto] [padding:32px_32px_48px]">
        {/* Hero / quick start */}
        <div className="grid [grid-template-columns:1.4fr_1fr] gap-5 mb-6">
          <div className="panel p-6 relative overflow-hidden">
            <div className="[font-size:var(--text-caption)] font-semibold text-muted-foreground uppercase [letter-spacing:.06em] mb-1.5">
              Start a call
            </div>
            <h2 className="[font-size:var(--text-h1)] font-semibold [margin:0_0_16px] [letter-spacing:-0.01em]">
              Premium video meetings, free for everyone at Helix.
            </h2>
            <div className="flex gap-2 flex-wrap">
              <button
                className="btn primary lg"
                type="button"
                disabled={heroBusy}
                onClick={() => {
                  setActionError(null);
                  setPendingJoin({ kind: "start", subject: "Instant meeting" });
                }}
              >
                <VideoIcon size={16} />{" "}
                {startMutation.isPending ? "Starting…" : "Start instant meeting"}
              </button>
              <button
                className="btn lg"
                type="button"
                disabled={heroBusy}
                onClick={() => {
                  setActionError(null);
                  setScheduleOpen(true);
                }}
              >
                <PlusIcon size={16} /> Schedule for later
              </button>
              <button
                className="btn lg"
                type="button"
                disabled={heroBusy}
                onClick={() => {
                  setActionError(null);
                  linkMutation.mutate();
                }}
              >
                <LinkIcon size={16} /> {linkMutation.isPending ? "Creating…" : "Get meeting link"}
              </button>
            </div>
            {actionError !== null ? (
              <div
                role="alert"
                className="mt-3 [font-size:var(--text-meta)] [color:var(--danger,_#dc2626)]"
              >
                {actionError}
              </div>
            ) : null}
            {linkRoom !== null ? (
              <div className="mt-3.5 flex items-center gap-2.5 [padding:8px_12px] rounded-md [border:1px_solid_var(--border)] [background:var(--bg-2,_var(--bg))]">
                <span className="[font-size:var(--text-meta)] [color:var(--text-2)]">
                  Meeting link ready
                </span>
                <code className="mono [font-size:var(--text-meta)]">
                  helix.meet/{linkRoom.code}
                </code>
                <button
                  className="btn sm"
                  type="button"
                  onClick={() => {
                    setLinkRoom(null);
                  }}
                >
                  Dismiss
                </button>
              </div>
            ) : null}
          </div>

          <div className="panel p-6">
            <div className="[font-size:var(--text-caption)] font-semibold text-muted-foreground uppercase [letter-spacing:.06em] mb-1.5">
              Join with code
            </div>
            <h3 className="[font-size:var(--text-h3)] font-semibold [margin:0_0_12px]">
              Got a meeting code?
            </h3>
            <form className="flex gap-1.5" onSubmit={handleJoinByCode}>
              <input
                className="input mono flex-1"
                aria-label="Meeting code"
                placeholder="abc-defg-hij"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                }}
              />
              <button className="btn primary" type="submit" disabled={joinMutation.isPending}>
                {joinMutation.isPending ? "Joining…" : "Join"}
              </button>
            </form>
            <div className="[font-size:var(--text-caption)] text-muted-foreground mt-2">
              Or paste a meeting link
            </div>
          </div>
        </div>

        {/* Today's meetings */}
        <div className="mb-6">
          <div className="flex items-center mb-3">
            <h3 className="[font-size:var(--text-body)] font-semibold m-0">Today</h3>
            <span className="ml-2 [font-size:var(--text-meta)] text-muted-foreground">
              {meetingsQuery.isLoading
                ? "Loading…"
                : `${String(filteredScheduled.length)} meetings`}
            </span>
            {meetingsQuery.isError ? (
              <span className="ml-2 [font-size:var(--text-chip)] font-semibold text-muted-foreground [border:1px_solid_var(--border)] rounded [padding:1px_6px] uppercase [letter-spacing:.04em]">
                Meetings unavailable
              </span>
            ) : null}
          </div>
          <div className="panel">
            {meetingsQuery.isLoading ? (
              <PanelMessage>Loading today&rsquo;s meetings…</PanelMessage>
            ) : filteredScheduled.length === 0 ? (
              <PanelMessage>
                {query.length > 0
                  ? "No meetings match your search."
                  : "No meetings scheduled. Start an instant meeting or schedule one."}
              </PanelMessage>
            ) : (
              filteredScheduled.map((meeting, index) => (
                <div
                  key={meeting.id}
                  className={cn(
                    "grid [grid-template-columns:70px_1fr_130px_140px] gap-4 [padding:12px_16px] items-center",
                    index ? "[border-top:1px_solid_var(--border)]" : "[border-top:none]",
                  )}
                >
                  <div>
                    <div className="[font-size:var(--text-body)] font-semibold [font-variant-numeric:tabular-nums]">
                      {meeting.time}
                    </div>
                    <div className="[font-size:var(--text-caption)] text-muted-foreground">
                      {meeting.duration}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="[font-size:var(--text-body-sm)] font-medium">
                        {meeting.title}
                      </span>
                      {meeting.inProgress ? (
                        <span className="chip danger">
                          <span className="chip-dot" />
                          In progress
                        </span>
                      ) : null}
                      {meeting.soon && !meeting.inProgress ? (
                        <span className="chip warning">
                          <span className="chip-dot" />
                          Starting soon
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 [font-size:var(--text-caption)] text-muted-foreground">
                      <Avatar name={meeting.host} size={16} />
                      <span>{meeting.host}</span>
                      <span>·</span>
                      <span>{meeting.attendees} attendees</span>
                    </div>
                  </div>
                  <div className="mono [font-size:var(--text-caption)] text-muted-foreground">
                    {meeting.code || "—"}
                  </div>
                  <div className="flex justify-end gap-1.5">
                    <button
                      className={meeting.inProgress ? "btn sm primary" : "btn sm"}
                      type="button"
                      disabled={joinMutation.isPending}
                      onClick={() => {
                        handleJoinRow(meeting);
                      }}
                    >
                      {meeting.inProgress ? "Join now" : "Join"}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent meetings */}
        <div>
          <h3 className="[font-size:var(--text-body)] font-semibold [margin:0_0_12px]">Recent</h3>
          <div className="panel">
            {meetingsQuery.isLoading ? (
              <PanelMessage>Loading recent meetings…</PanelMessage>
            ) : filteredRecent.length === 0 ? (
              <PanelMessage>
                {query.length > 0
                  ? "No recent meetings match your search."
                  : "No recent meetings yet."}
              </PanelMessage>
            ) : (
              filteredRecent.map((meeting, index) => (
                <div
                  key={meeting.id}
                  className={cn(
                    "grid [grid-template-columns:1fr_170px_120px_80px_130px] gap-4 [padding:12px_16px] items-center",
                    index ? "[border-top:1px_solid_var(--border)]" : "[border-top:none]",
                  )}
                >
                  <div>
                    <div className="[font-size:var(--text-body-sm)] font-medium">
                      {meeting.title}
                    </div>
                  </div>
                  <span className="[font-size:var(--text-meta)] [color:var(--text-2)]">
                    {meeting.date}
                  </span>
                  <span className="[font-size:var(--text-meta)] [color:var(--text-2)]">
                    {meeting.duration}
                  </span>
                  <span className="[font-size:var(--text-meta)] [color:var(--text-2)]">
                    {meeting.attendees} people
                  </span>
                  <div className="flex justify-end gap-1.5">
                    {meeting.recorded ? (
                      <button
                        className="btn sm"
                        type="button"
                        onClick={() => {
                          const backend = meeting.roomId
                            ? meetingByRow.get(meeting.roomId)
                            : undefined;
                          if (backend !== undefined) setRecordingsFor(backend);
                        }}
                      >
                        <VideoIcon size={16} /> Recording
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {scheduleOpen ? (
        <ScheduleDialog
          pending={scheduleMutation.isPending}
          error={scheduleMutation.isError ? messageOf(scheduleMutation.error) : null}
          onClose={() => {
            setScheduleOpen(false);
          }}
          onSubmit={(input) => {
            scheduleMutation.mutate(input);
          }}
        />
      ) : null}

      {pendingJoin !== null ? (
        <RecordingConsentDialog
          onClose={() => {
            setPendingJoin(null);
          }}
          onAccept={() => {
            const consent = createRecordingConsent();
            const pending = pendingJoin;
            setPendingJoin(null);
            if (pending.kind === "start") {
              startMutation.mutate({ subject: pending.subject, consent });
            } else if (pending.kind === "meeting") {
              joinMutation.mutate({ meeting: pending.meeting, consent });
            } else {
              codeJoinMutation.mutate({ code: pending.code, consent });
            }
          }}
        />
      ) : null}

      {recordingsFor !== null ? (
        <RecordingDrawer
          meeting={recordingsFor}
          onClose={() => {
            setRecordingsFor(null);
          }}
        />
      ) : null}
    </div>
  );
}

function PanelMessage({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="[padding:28px_16px] text-center [font-size:var(--text-meta)] text-muted-foreground">
      {children}
    </div>
  );
}

/** Schedule-for-later dialog → `meet.create-room` with a schedule window. */
function ScheduleDialog({
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: {
    readonly subject: string;
    readonly scheduledStartAt: string;
    readonly scheduledEndAt: string;
  }) => void;
}) {
  const [subject, setSubject] = useState("");
  const [start, setStart] = useState(defaultLocalDateTime());
  const [durationMin, setDurationMin] = useState(30);
  const [localError, setLocalError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = subject.trim();
    if (trimmed.length === 0) {
      setLocalError("Give the meeting a title.");
      return;
    }
    const startMs = new Date(start).getTime();
    if (Number.isNaN(startMs)) {
      setLocalError("Pick a valid start time.");
      return;
    }
    setLocalError(null);
    onSubmit({
      subject: trimmed,
      scheduledStartAt: new Date(startMs).toISOString(),
      scheduledEndAt: new Date(startMs + durationMin * 60_000).toISOString(),
    });
  }

  return (
    <Dialog
      title="Schedule a meeting"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="submit"
            form="meet-schedule-form"
            disabled={pending}
          >
            {pending ? "Scheduling…" : "Schedule"}
          </button>
        </div>
      }
    >
      <form id="meet-schedule-form" onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 [font-size:var(--text-meta)] font-medium [color:var(--text-2)]">
          Title
          <input
            className="input"
            aria-label="Meeting title"
            placeholder="Q3 Roadmap working session"
            value={subject}
            onChange={(event) => {
              setSubject(event.target.value);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 [font-size:var(--text-meta)] font-medium [color:var(--text-2)]">
          Start
          <input
            className="input"
            type="datetime-local"
            aria-label="Start time"
            value={start}
            onChange={(event) => {
              setStart(event.target.value);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 [font-size:var(--text-meta)] font-medium [color:var(--text-2)]">
          Duration
          <select
            className="input"
            aria-label="Duration"
            value={durationMin}
            onChange={(event) => {
              setDurationMin(Number(event.target.value));
            }}
          >
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
            <option value={60}>1 hour</option>
            <option value={90}>1 hour 30 minutes</option>
          </select>
        </label>
        {(localError ?? error) !== null ? (
          <div
            role="alert"
            className="mt-3 [font-size:var(--text-meta)] [color:var(--danger,_#dc2626)]"
          >
            {localError ?? error}
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

function defaultLocalDateTime(): string {
  const now = new Date(Date.now() + 60 * 60 * 1000);
  now.setMinutes(0, 0, 0);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function createRecordingConsent(): MeetRecordingConsent {
  return {
    recordingNoticeAccepted: true,
    recordingNoticeVersion: MEET_RECORDING_NOTICE_VERSION,
    deviceId: meetDeviceId(),
    joinGrantId: crypto.randomUUID(),
  };
}

function RecordingConsentDialog({
  onClose,
  onAccept,
}: {
  readonly onClose: () => void;
  readonly onAccept: () => void;
}) {
  return (
    <Dialog
      title="Recording notice"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={onAccept}>
            I consent and join
          </button>
        </div>
      }
    >
      <p>
        This meeting may record audio, video, and shared content. If recording starts, everyone will
        see and hear an alert.
      </p>
      <p>
        By joining, you explicitly consent under Helix&apos;s global all-parties recording policy.
      </p>
    </Dialog>
  );
}

function meetDeviceId(): string {
  const key = "helix-meet-device-id";
  try {
    const existing = localStorage.getItem(key);
    if (existing !== null) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}
