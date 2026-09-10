import { queryOptions } from "@tanstack/react-query";
import { listMeetMeetings, type MeetRoomStatus } from "./api";

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
};

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
