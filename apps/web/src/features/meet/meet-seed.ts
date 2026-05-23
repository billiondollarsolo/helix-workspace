/* Meet — view-model types and backend → UI mappers.
 *
 * The seed `SCHEDULED_MEETINGS / RECENT_MEETINGS / CALL_PARTICIPANTS /
 * CALL_MESSAGES / ACTIVE_CALL` arrays that lived here have been removed.
 * The Hub and in-call views now render only live data from `meet.meetings.list`
 * / `meet.mint-token`; on error they surface a "Meetings unavailable" state
 * rather than fabricated rows. What remains are the view-model row types and
 * the mappers from the real `MeetMeetingRecord` shape onto those types. */

import type { MeetMeetingRecord } from "./api";

/** A meeting on the Hub's "Today" panel. */
export interface ScheduledMeeting {
  readonly id: string;
  readonly title: string;
  readonly time: string;
  readonly duration: string;
  readonly host: string;
  readonly attendees: number;
  /** Meeting code (mono) — `helix.meet/<code>`. */
  readonly code: string;
  /** Backend room id, when this row maps to a live room. */
  readonly roomId?: string;
  /** Currently running — renders an "In progress" chip + primary Join. */
  readonly inProgress?: boolean;
  /** Starting within the hour — renders a "Starting soon" chip. */
  readonly soon?: boolean;
}

/** A past meeting on the Hub's "Recent" panel. */
export interface RecentMeeting {
  readonly id: string;
  readonly title: string;
  readonly date: string;
  readonly duration: string;
  readonly attendees: number;
  /** A recording is available. */
  readonly recorded: boolean;
  /** Backend room id, when this row maps to a live room. */
  readonly roomId?: string;
}

/** A participant tile in the in-call view. */
export interface MeetCallParticipant {
  readonly id: string;
  readonly name: string;
  /** This is the local user — tile name pill shows "(you)". */
  readonly you?: boolean;
  readonly muted: boolean;
  /** Camera on — renders the gradient silhouette; off renders a solid avatar. */
  readonly video: boolean;
  /** Active speaker — accent border + glow. */
  readonly speaking: boolean;
  /** Hand raised — amber badge top-right. */
  readonly hand?: boolean;
}

/** A message in the in-call chat panel. */
export interface MeetCallMessage {
  readonly id: string;
  readonly name: string;
  readonly time: string;
  readonly text: string;
}

/* ------------------------------------------------------------------ */
/* Backend → UI mappers. The hub renders these projections of the real
   `meet.meetings.list` tool output.                                  */
/* ------------------------------------------------------------------ */

const HOUR_MS = 60 * 60 * 1000;

/** Map a real `scheduled`/`active` meeting into a "Today" panel row. */
export function meetingToScheduled(meeting: MeetMeetingRecord): ScheduledMeeting {
  const inProgress = meeting.status === "active";
  const startMs = parseMs(meeting.startedAt ?? meeting.scheduledStartAt);
  const soon =
    !inProgress &&
    startMs !== null &&
    startMs - Date.now() <= HOUR_MS &&
    startMs - Date.now() >= -HOUR_MS;
  return {
    id: meeting.id,
    roomId: meeting.id,
    title: meeting.title || meeting.subject,
    time: formatClock(meeting.startedAt ?? meeting.scheduledStartAt),
    duration: formatDuration(meeting),
    host: meeting.host?.displayName ?? meeting.host?.email ?? "Helix Meet",
    attendees: meeting.attendeeCount,
    code: meeting.code,
    inProgress,
    soon,
  };
}

/** Map a real `ended` meeting into a "Recent" panel row. */
export function meetingToRecent(meeting: MeetMeetingRecord): RecentMeeting {
  return {
    id: meeting.id,
    roomId: meeting.id,
    title: meeting.title || meeting.subject,
    date: formatDate(meeting.endedAt ?? meeting.updatedAt),
    duration:
      meeting.durationSeconds !== null
        ? formatSecondsDuration(meeting.durationSeconds)
        : "—",
    attendees: meeting.attendeeCount,
    recorded: meeting.recorded,
  };
}

function parseMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function formatClock(value: string | null | undefined): string {
  const ms = parseMs(value);
  return ms === null
    ? "—"
    : new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDate(value: string | null | undefined): string {
  const ms = parseMs(value);
  return ms === null
    ? "—"
    : new Date(ms).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function formatDuration(meeting: MeetMeetingRecord): string {
  if (meeting.status === "active") {
    return "In progress";
  }
  const start = parseMs(meeting.scheduledStartAt ?? meeting.startedAt);
  const end = parseMs(meeting.scheduledEndAt ?? meeting.endedAt);
  if (start !== null && end !== null && end > start) {
    return formatSecondsDuration(Math.round((end - start) / 1000));
  }
  if (meeting.durationSeconds !== null) {
    return formatSecondsDuration(meeting.durationSeconds);
  }
  return "—";
}

function formatSecondsDuration(totalSeconds: number): string {
  const minutes = Math.max(0, Math.round(totalSeconds / 60));
  if (minutes < 60) {
    return `${String(minutes)}m`;
  }
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}
