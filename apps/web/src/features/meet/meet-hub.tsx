/* MeetHub — the Meet landing surface. A hero row (Start a call / Join with
   code), a "Today" panel of scheduled + active meetings, and a "Recent" panel
   of past meetings.

   Today and Recent are wired to the `meet.meetings.list` tool. The hero
   actions are wired to live tools: "Start instant meeting" → `meet.create-room`
   + `meet.mint-token`; "Schedule for later" → `meet.create-room` with a
   schedule window; "Get meeting link" → `meet.create-room` then a copyable
   join code. Joining a meeting mints a token via `meet.mint-token`.

   Seed data (SCHEDULED_MEETINGS / RECENT_MEETINGS) is used ONLY as an offline
   fallback when the tool call fails. */

import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Dialog } from "@/components/ui/helix-dialog";
import { createMeetRoom, mintMeetToken, type MeetMeetingRecord } from "./api";
import { meetMeetingsQueryOptions, meetQueryKeys } from "./queries";
import type { MeetCallSession } from "./meet-shell";
import {
  RECENT_MEETINGS,
  SCHEDULED_MEETINGS,
  meetingToRecent,
  meetingToScheduled,
  type RecentMeeting,
  type ScheduledMeeting,
} from "./meet-seed";

export interface MeetHubProps {
  /** Current search query from the surface frame; filters both panels. */
  readonly search?: string;
  /** Enter the in-call view with a live (or offline-fallback) call session. */
  readonly onEnterCall: (session: MeetCallSession) => void;
}

const DEFAULT_JITSI_DOMAIN = "meet.localhost";

export function MeetHub({ search = "", onEnterCall }: MeetHubProps) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [linkRoom, setLinkRoom] = useState<{ readonly code: string; readonly subject: string } | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const meetingsQuery = useQuery(meetMeetingsQueryOptions());

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: meetQueryKeys.all });

  const clearActionError = () => {
    setActionError(null);
  };

  /* meet.create-room + meet.mint-token → enter the in-call view. */
  const startMutation = useMutation({
    mutationFn: async (subject: string) => {
      const room = await createMeetRoom({ subject, jitsiDomain: DEFAULT_JITSI_DOMAIN });
      const token = await mintMeetToken({ roomId: room.id, moderator: true });
      return { room, token };
    },
    onMutate: clearActionError,
    onSuccess: ({ room, token }) => {
      void invalidate();
      onEnterCall({
        roomId: room.id,
        roomName: room.roomName,
        subject: room.subject,
        code: room.roomName,
        jitsiDomain: token.jitsiDomain,
        token: token.token,
        joinUrl: token.joinUrl,
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
        jitsiDomain: DEFAULT_JITSI_DOMAIN,
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
        jitsiDomain: DEFAULT_JITSI_DOMAIN,
      }),
    onMutate: clearActionError,
    onSuccess: (room) => {
      void invalidate();
      setLinkRoom({ code: room.roomName, subject: room.subject });
    },
    onError: (error: unknown) => {
      setActionError(messageOf(error));
    },
  });

  /* meet.mint-token for an existing room → enter the in-call view. */
  const joinMutation = useMutation({
    mutationFn: async (meeting: MeetMeetingRecord) => {
      const token = await mintMeetToken({ roomId: meeting.id });
      return { meeting, token };
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
        startedAtMs: meeting.startedAt ? Date.parse(meeting.startedAt) || Date.now() : Date.now(),
      });
    },
    onError: (error: unknown) => {
      setActionError(messageOf(error));
    },
  });

  /* Today = backend scheduled + active meetings; Recent = backend ended.
     If the tool call fails entirely, fall back to the typed seed. */
  const usingFallback = meetingsQuery.isError;
  const data = meetingsQuery.data;

  const scheduled = useMemo<readonly ScheduledMeeting[]>(() => {
    if (data) {
      return [...data.active, ...data.scheduled].map(meetingToScheduled);
    }
    return usingFallback ? SCHEDULED_MEETINGS : [];
  }, [data, usingFallback]);

  const recent = useMemo<readonly RecentMeeting[]>(() => {
    if (data) {
      return data.recent.map(meetingToRecent);
    }
    return usingFallback ? RECENT_MEETINGS : [];
  }, [data, usingFallback]);

  /* Map backend meetings by code/id so a Join click can mint a token. */
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
    query.length > 0
      ? recent.filter((m) => m.title.toLowerCase().includes(query))
      : recent;

  const heroBusy = startMutation.isPending || linkMutation.isPending;

  function handleJoinRow(meeting: ScheduledMeeting) {
    setActionError(null);
    const backend = meeting.roomId ? meetingByRow.get(meeting.roomId) : undefined;
    if (backend && backend.status === "active") {
      joinMutation.mutate(backend);
      return;
    }
    if (backend && backend.status === "scheduled") {
      setActionError("This meeting hasn't started yet.");
      return;
    }
    // Offline-fallback seed row — enter the in-call view without a token.
    onEnterCall(offlineSession(meeting.title, meeting.code));
  }

  function handleJoinByCode(event: FormEvent) {
    event.preventDefault();
    setActionError(null);
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setActionError("Enter a meeting code to join.");
      return;
    }
    const backend = [...meetingByRow.values()].find(
      (m) => m.code === trimmed || m.roomName === trimmed,
    );
    if (backend && backend.status === "active") {
      joinMutation.mutate(backend);
      return;
    }
    onEnterCall(offlineSession("Helix meeting", trimmed));
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
                fontSize: 22,
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
                  startMutation.mutate("Instant meeting");
                }}
              >
                <Icons.Video />{" "}
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
                <span style={{ fontSize: 12, color: "var(--text-2)" }}>Meeting link ready</span>
                <code className="mono" style={{ fontSize: 12 }}>
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
            <h3 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 12px" }}>
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
            <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>
              Or paste a meeting link
            </div>
          </div>
        </div>

        {/* Today's meetings */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Today</h3>
            <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-3)" }}>
              {meetingsQuery.isLoading
                ? "Loading…"
                : `${String(filteredScheduled.length)} meetings`}
            </span>
            {usingFallback ? <span style={offlineChipStyle}>Offline data</span> : null}
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
                        fontSize: 14,
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {meeting.time}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-3)" }}>{meeting.duration}</div>
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
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{meeting.title}</span>
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
                        fontSize: 11,
                        color: "var(--text-3)",
                      }}
                    >
                      <Avatar name={meeting.host} size={16} />
                      <span>{meeting.host}</span>
                      <span>·</span>
                      <span>{meeting.attendees} attendees</span>
                    </div>
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
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
                    <button
                      className="icon-btn"
                      type="button"
                      aria-label={`More options for ${meeting.title}`}
                    >
                      <Icons.MoreV />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent meetings */}
        <div>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Recent</h3>
            <button className="btn sm" type="button" style={{ marginLeft: "auto" }}>
              View all
            </button>
          </div>
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
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{meeting.title}</div>
                  </div>
                  <span style={{ fontSize: 12, color: "var(--text-2)" }}>{meeting.date}</span>
                  <span style={{ fontSize: 12, color: "var(--text-2)" }}>{meeting.duration}</span>
                  <span style={{ fontSize: 12, color: "var(--text-2)" }}>
                    {meeting.attendees} people
                  </span>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                    {meeting.recorded ? (
                      <button className="btn sm" type="button">
                        <Icons.Video /> Recording
                      </button>
                    ) : null}
                    <button className="btn sm" type="button">
                      Summary
                    </button>
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
    </div>
  );
}

function PanelMessage({ children }: { readonly children: React.ReactNode }) {
  return (
    <div style={{ padding: "28px 16px", textAlign: "center", fontSize: 12, color: "var(--text-3)" }}>
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
          <button className="btn primary" type="submit" form="meet-schedule-form" disabled={pending}>
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

/** An offline-fallback session — no real room, no minted token. */
function offlineSession(subject: string, code: string): MeetCallSession {
  return {
    roomId: "",
    roomName: code,
    subject,
    code,
    jitsiDomain: DEFAULT_JITSI_DOMAIN,
    token: null,
    joinUrl: null,
    startedAtMs: Date.now(),
  };
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

const eyebrowStyle = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-3)",
  textTransform: "uppercase",
  letterSpacing: ".06em",
  marginBottom: 6,
} as const;

const errorTextStyle = {
  marginTop: 12,
  fontSize: 12,
  color: "var(--danger, #dc2626)",
} as const;

const offlineChipStyle = {
  marginLeft: 8,
  fontSize: 10,
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
  fontSize: 12,
  fontWeight: 500,
  color: "var(--text-2)",
} as const;
