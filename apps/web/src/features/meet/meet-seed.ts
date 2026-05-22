/* Meet seed data — typed port of the design handoff Meet prototype data
   (app-sheets-meet-chat.jsx → SCHEDULED_MEETINGS, RECENT_MEETINGS,
   PARTICIPANTS). Used ONLY as an offline fallback for the Meet hub and in-call
   view when the `meet.meetings.list` tool is unreachable. */

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

export const SCHEDULED_MEETINGS: readonly ScheduledMeeting[] = [
  {
    id: "m1",
    title: "Q3 Roadmap working session",
    time: "10:00 AM",
    duration: "1h 30m",
    host: "Mira Okafor",
    attendees: 5,
    code: "qfk-uvtn-pxs",
    inProgress: true,
  },
  {
    id: "m2",
    title: "1:1 with Jonas",
    time: "11:00 AM",
    duration: "30m",
    host: "Jonas Reichert",
    attendees: 2,
    code: "rmd-azxc-vbn",
    soon: true,
  },
  {
    id: "m3",
    title: "Caroline Reyes / Atlas",
    time: "2:00 PM",
    duration: "30m",
    host: "Rumi Tanaka",
    attendees: 2,
    code: "tyu-iopl-kjh",
  },
  {
    id: "m4",
    title: "Postmortem — auth 05/15",
    time: "3:30 PM",
    duration: "1h 30m",
    host: "Daniel Cho",
    attendees: 6,
    code: "wsx-edcr-fvg",
  },
];

export const RECENT_MEETINGS: readonly RecentMeeting[] = [
  {
    id: "r1",
    title: "Eng standup",
    date: "Today, 9:00 AM",
    duration: "27m",
    attendees: 8,
    recorded: true,
  },
  {
    id: "r2",
    title: "Design review — onboarding",
    date: "Yesterday, 2:00 PM",
    duration: "1h 12m",
    attendees: 5,
    recorded: true,
  },
  {
    id: "r3",
    title: "Atlas renewal call",
    date: "Monday, 11:00 AM",
    duration: "42m",
    attendees: 4,
    recorded: false,
  },
];

export const CALL_PARTICIPANTS: readonly MeetCallParticipant[] = [
  { id: "p1", name: "Alex Park", you: true, muted: false, video: true, speaking: false },
  { id: "p2", name: "Mira Okafor", muted: false, video: true, speaking: true },
  { id: "p3", name: "Jonas Reichert", muted: true, video: true, speaking: false },
  { id: "p4", name: "Priya Anand", muted: false, video: false, speaking: false },
  { id: "p5", name: "Daniel Cho", muted: true, video: true, speaking: false },
  { id: "p6", name: "Sasha Levin", muted: false, video: false, speaking: false, hand: true },
];

export const CALL_MESSAGES: readonly MeetCallMessage[] = [
  {
    id: "c1",
    name: "Mira Okafor",
    time: "32:01",
    text: "Quick note — I'll cover Atlas first, then we'll discuss hiring.",
  },
  { id: "c2", name: "Jonas Reichert", time: "32:08", text: "Sharing my screen in 2 min" },
  {
    id: "c3",
    name: "Priya Anand",
    time: "32:12",
    text: "+1 to starting with Atlas. I have a hard stop at 12.",
  },
];

/** The default meeting the in-call view represents (offline fallback). */
export const ACTIVE_CALL = {
  title: "Q3 Roadmap working session",
  code: "qfk-uvtn-pxs",
} as const;

/* ------------------------------------------------------------------ */
/* Backend → UI mappers. The hub renders these projections of the real
   `meet.meetings.list` tool output; seed constants above are the
   offline fallback only.                                             */
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
