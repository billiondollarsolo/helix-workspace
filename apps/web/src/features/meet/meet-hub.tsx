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

import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Dialog } from "@/components/ui/helix-dialog";
import {
  createMeetRoom,
  joinMeetByCode,
  MEET_RECORDING_NOTICE_VERSION,
  mintMeetToken,
  type MeetMeetingRecord,
  type MeetRecordingConsent,
} from "./api";
import { meetMeetingsQueryOptions, meetQueryKeys } from "./queries";
import type { MeetCallSession } from "./meet-shell";
import {
  meetingToRecent,
  meetingToScheduled,
  type RecentMeeting,
  type ScheduledMeeting,
} from "./meet-seed";
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
    <div style={{ flex: 1, overflowY: "auto", background: "var(--bg)" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "32px 32px 48px" }}>
        {/* Hero / quick start */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.4fr 1fr",
            gap: 20,
            marginBottom: 24,
          }}
        >
          <div className="panel" style={{ padding: 24, position: "relative", overflow: "hidden" }}>
            <div style={eyebrowStyle}>Start a call</div>
            <h2
              style={{
                fontSize: "var(--text-h1)",
                fontWeight: 600,
                margin: "0 0 16px",
                letterSpacing: "-0.01em",
              }}
            >
              Premium video meetings, free for everyone at Helix.
            </h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className="btn primary lg"
                type="button"
                disabled={heroBusy}
                onClick={() => {
                  setActionError(null);
                  setPendingJoin({ kind: "start", subject: "Instant meeting" });
                }}
              >
                <Icons.Video /> {startMutation.isPending ? "Starting…" : "Start instant meeting"}
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
                <Icons.Plus /> Schedule for later
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
                <Icons.Link /> {linkMutation.isPending ? "Creating…" : "Get meeting link"}
              </button>
            </div>
            {actionError !== null ? (
              <div role="alert" style={errorTextStyle}>
                {actionError}
              </div>
            ) : null}
            {linkRoom !== null ? (
              <div style={linkBannerStyle}>
                <span style={{ fontSize: "var(--text-meta)", color: "var(--text-2)" }}>
                  Meeting link ready
                </span>
                <code className="mono" style={{ fontSize: "var(--text-meta)" }}>
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

          <div className="panel" style={{ padding: 24 }}>
            <div style={eyebrowStyle}>Join with code</div>
            <h3 style={{ fontSize: "var(--text-h3)", fontWeight: 600, margin: "0 0 12px" }}>
              Got a meeting code?
            </h3>
            <form style={{ display: "flex", gap: 6 }} onSubmit={handleJoinByCode}>
              <input
                className="input mono"
                aria-label="Meeting code"
                placeholder="abc-defg-hij"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                }}
                style={{ flex: 1 }}
              />
              <button className="btn primary" type="submit" disabled={joinMutation.isPending}>
                {joinMutation.isPending ? "Joining…" : "Join"}
              </button>
            </form>
            <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginTop: 8 }}>
              Or paste a meeting link
            </div>
          </div>
        </div>

        {/* Today's meetings */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ fontSize: "var(--text-body)", fontWeight: 600, margin: 0 }}>Today</h3>
            <span style={{ marginLeft: 8, fontSize: "var(--text-meta)", color: "var(--text-3)" }}>
              {meetingsQuery.isLoading
                ? "Loading…"
                : `${String(filteredScheduled.length)} meetings`}
            </span>
            {meetingsQuery.isError ? (
              <span style={offlineChipStyle}>Meetings unavailable</span>
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
                  style={{
                    display: "grid",
                    gridTemplateColumns: "70px 1fr 130px 140px",
                    gap: 16,
                    padding: "12px 16px",
                    borderTop: index ? "1px solid var(--border)" : "none",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: "var(--text-body)",
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {meeting.time}
                    </div>
                    <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
                      {meeting.duration}
                    </div>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 4,
                      }}
                    >
                      <span style={{ fontSize: "var(--text-body-sm)", fontWeight: 500 }}>
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
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: "var(--text-caption)",
                        color: "var(--text-3)",
                      }}
                    >
                      <Avatar name={meeting.host} size={16} />
                      <span>{meeting.host}</span>
                      <span>·</span>
                      <span>{meeting.attendees} attendees</span>
                    </div>
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}
                  >
                    {meeting.code || "—"}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
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
          <h3 style={{ fontSize: "var(--text-body)", fontWeight: 600, margin: "0 0 12px" }}>
            Recent
          </h3>
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
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 170px 120px 80px 130px",
                    gap: 16,
                    padding: "12px 16px",
                    borderTop: index ? "1px solid var(--border)" : "none",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "var(--text-body-sm)", fontWeight: 500 }}>
                      {meeting.title}
                    </div>
                  </div>
                  <span style={{ fontSize: "var(--text-meta)", color: "var(--text-2)" }}>
                    {meeting.date}
                  </span>
                  <span style={{ fontSize: "var(--text-meta)", color: "var(--text-2)" }}>
                    {meeting.duration}
                  </span>
                  <span style={{ fontSize: "var(--text-meta)", color: "var(--text-2)" }}>
                    {meeting.attendees} people
                  </span>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
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
                        <Icons.Video /> Recording
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
    <div
      style={{
        padding: "28px 16px",
        textAlign: "center",
        fontSize: "var(--text-meta)",
        color: "var(--text-3)",
      }}
    >
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
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
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
      <form
        id="meet-schedule-form"
        onSubmit={submit}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <label style={fieldLabelStyle}>
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
        <label style={fieldLabelStyle}>
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
        <label style={fieldLabelStyle}>
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
          <div role="alert" style={errorTextStyle}>
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
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
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

const eyebrowStyle = {
  fontSize: "var(--text-caption)",
  fontWeight: 600,
  color: "var(--text-3)",
  textTransform: "uppercase",
  letterSpacing: ".06em",
  marginBottom: 6,
} as const;

const errorTextStyle = {
  marginTop: 12,
  fontSize: "var(--text-meta)",
  color: "var(--danger, #dc2626)",
} as const;

const offlineChipStyle = {
  marginLeft: 8,
  fontSize: "var(--text-chip)",
  fontWeight: 600,
  color: "var(--text-3)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "1px 6px",
  textTransform: "uppercase",
  letterSpacing: ".04em",
} as const;

const linkBannerStyle = {
  marginTop: 14,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-2, var(--bg))",
} as const;

const fieldLabelStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: "var(--text-meta)",
  fontWeight: 500,
  color: "var(--text-2)",
} as const;
