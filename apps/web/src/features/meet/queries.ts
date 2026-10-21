import { calendarEventsQueryOptions } from "@/features/calendar/queries";
import { queryOptions } from "@tanstack/react-query";
import { fetchMeetStatus, listMeetLobby, listMeetMeetings, type MeetRoomStatus } from "./api";

type MeetRoomsStatusFilter = MeetRoomStatus;

export interface MeetRoomsQueryInput {
  readonly status?: MeetRoomsStatusFilter;
  readonly limit?: number;
}

const defaultMeetRoomsInput = {
  limit: 50,
} as const satisfies MeetRoomsQueryInput;

export const meetQueryKeys = {
  /** Root key for every Meet query — used to invalidate after mutations. */
  all: ["meet"] as const,
  rooms: (input: MeetRoomsQueryInput = defaultMeetRoomsInput) =>
    ["meet", "rooms", input.status ?? "all", input.limit ?? 50] as const,
  meetings: (input: MeetRoomsQueryInput = defaultMeetRoomsInput) =>
    ["meet", "meetings", input.status ?? "all", input.limit ?? 50] as const,
  status: ["meet", "status"] as const,
  lobby: (roomId: string) => ["meet", "lobby", roomId] as const,
};

/** `meet.status`: whether a meeting server is configured. Changes only on a server restart. */
export function meetStatusQueryOptions() {
  return queryOptions({
    queryKey: meetQueryKeys.status,
    queryFn: () => fetchMeetStatus(),
    staleTime: 5 * 60_000,
    throwOnError: false,
  });
}

/**
 * Hub meetings — the `meet.meetings.list` tool, projected for the hub's
 * Today (scheduled + active) and Recent (ended) panels.
 */
export function meetMeetingsQueryOptions(input: MeetRoomsQueryInput = defaultMeetRoomsInput) {
  return queryOptions({
    queryKey: meetQueryKeys.meetings(input),
    queryFn: () => listMeetMeetings(input),
    refetchInterval: 15_000,
    throwOnError: false,
  });
}

/** Guests waiting in a meeting's lobby (hosts and co-hosts only); a 10 s
 *  fallback poll behind the server's `helix.lobby` nudge. */
export function meetLobbyQueryOptions(roomId: string, enabled: boolean) {
  return queryOptions({
    queryKey: meetQueryKeys.lobby(roomId),
    queryFn: () => listMeetLobby(roomId),
    enabled,
    refetchInterval: enabled ? 10_000 : false,
    throwOnError: false,
  });
}

/** Today's calendar events (local day), for the hub's "Today" list. */
export function meetTodayEventsQueryOptions() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return calendarEventsQueryOptions({
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    limit: 100,
  });
}

/** Drives the in-call elapsed timer: a 1s-refetch query that recomputes
 *  whole seconds since `startedAtMs`, avoiding native browser timer APIs. */
export function meetCallElapsedQueryOptions(startedAtMs: number) {
  return queryOptions({
    queryKey: ["meet", "call-elapsed", startedAtMs] as const,
    queryFn: () => Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
    refetchInterval: 1000,
    gcTime: 0,
    throwOnError: false,
  });
}
