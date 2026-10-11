/* Meet hub view models: the "Today" rows (calendar events with video
   conferencing, plus rooms already running) and the "Recent" rows. */

import type { CalendarApiEvent } from "@/features/calendar/api";
import { conferenceFromMetadata } from "@/features/calendar/conference";
import type { MeetMeetingRecord } from "./api";

/** A meeting on the hub's "Today" list. */
export interface TodayMeeting {
  readonly id: string;
  readonly title: string;
  /** Start time, e.g. "9:30 AM". */
  readonly time: string;
  /** Length, or "In progress". */
  readonly duration: string;
  /** Join code; Join opens the pre-join screen for it. */
  readonly code: string;
  readonly inProgress: boolean;
  /** Starts within the hour. */
  readonly soon: boolean;
  readonly startMs: number;
}

/** A past meeting on the hub's "Recent" list. */
export interface RecentMeeting {
  readonly id: string;
  readonly title: string;
  readonly date: string;
  readonly duration: string;
  readonly attendees: number;
  /** A recording is available. */
  readonly recorded: boolean;
  readonly roomId: string;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Today's meetings: calendar events with video conferencing in the day, plus
 * running rooms the calendar does not already list, ordered by start time.
 */
export function todayMeetings(
  events: readonly CalendarApiEvent[],
  meetings: readonly MeetMeetingRecord[],
  nowMs: number = Date.now(),
): readonly TodayMeeting[] {
  const rows: TodayMeeting[] = [];
  const listedRooms = new Set<string>();
  for (const event of events) {
    const conference = conferenceFromMetadata(event.metadata);
    if (conference === null || event.status === "cancelled" || event.deletedAt) continue;
    const startMs = parseMs(event.startsAt) ?? nowMs;
    const endMs = parseMs(event.endsAt) ?? startMs;
    const running = meetings.some(
      (meeting) => meeting.id === conference.roomId && meeting.status === "active",
    );
    listedRooms.add(conference.roomId);
    rows.push({
      id: event.id,
      title: event.title || "Untitled meeting",
      time: event.allDay ? "All day" : formatClock(event.startsAt),
      duration: running ? "In progress" : formatSpan(startMs, endMs),
      code: conference.joinCode,
      inProgress: running,
      soon: !running && Math.abs(startMs - nowMs) <= HOUR_MS,
      startMs,
    });
  }
  for (const meeting of meetings) {
    if (meeting.status !== "active" || listedRooms.has(meeting.id)) continue;
    rows.push({
      id: meeting.id,
      title: meeting.title || meeting.subject,
      time: formatClock(meeting.startedAt),
      duration: "In progress",
      code: meeting.code,
      inProgress: true,
      soon: false,
      startMs: parseMs(meeting.startedAt) ?? nowMs,
    });
  }
  return rows.sort((left, right) => left.startMs - right.startMs);
}

/** Map an ended meeting into a "Recent" row. */
export function meetingToRecent(meeting: MeetMeetingRecord): RecentMeeting {
  return {
    id: meeting.id,
    roomId: meeting.id,
    title: meeting.title || meeting.subject,
    date: formatDate(meeting.endedAt ?? meeting.updatedAt),
    duration:
      meeting.durationSeconds !== null ? formatSecondsDuration(meeting.durationSeconds) : "—",
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

function formatSpan(startMs: number, endMs: number): string {
  return endMs > startMs ? formatSecondsDuration(Math.round((endMs - startMs) / 1000)) : "—";
}

function formatSecondsDuration(totalSeconds: number): string {
  const minutes = Math.max(0, Math.round(totalSeconds / 60));
  if (minutes < 60) {
    return `${String(minutes)}m`;
  }
  const rest = minutes % 60;
  return rest === 0
    ? `${String(Math.floor(minutes / 60))}h`
    : `${String(Math.floor(minutes / 60))}h ${String(rest)}m`;
}
