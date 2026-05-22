import { queryOptions } from "@tanstack/react-query";
import { listMeetMeetings, listMeetRooms, type MeetRoomStatus } from "./api";

export type MeetRoomsStatusFilter = MeetRoomStatus;

export interface MeetRoomsQueryInput {
  readonly status?: MeetRoomsStatusFilter;
  readonly limit?: number;
}

export const defaultMeetRoomsInput = {
  limit: 50,
} as const satisfies MeetRoomsQueryInput;

export const meetQueryKeys = {
  /** Root key for every Meet query — used to invalidate after mutations. */
  all: ["meet"] as const,
  rooms: (input: MeetRoomsQueryInput = defaultMeetRoomsInput) =>
    ["meet", "rooms", input.status ?? "all", input.limit ?? 50] as const,
  meetings: (input: MeetRoomsQueryInput = defaultMeetRoomsInput) =>
    ["meet", "meetings", input.status ?? "all", input.limit ?? 50] as const,
};

/** Raw room list — supporting data via the `meet.room.list` tool. */
export function meetRoomsQueryOptions(input: MeetRoomsQueryInput = defaultMeetRoomsInput) {
  return queryOptions({
    queryKey: meetQueryKeys.rooms(input),
    queryFn: () => listMeetRooms(input),
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
    throwOnError: false,
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
