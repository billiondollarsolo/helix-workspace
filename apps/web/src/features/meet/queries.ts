import { queryOptions } from "@tanstack/react-query";
import { listMeetRooms, type MeetRoomRecord } from "./api";

export type MeetRoomsStatusFilter = MeetRoomRecord["status"];

export interface MeetRoomsQueryInput {
  readonly status?: MeetRoomsStatusFilter;
  readonly limit?: number;
}

export const defaultMeetRoomsInput = {
  limit: 50,
} as const satisfies MeetRoomsQueryInput;

export const meetQueryKeys = {
  rooms: (input: MeetRoomsQueryInput = defaultMeetRoomsInput) =>
    ["meet", "rooms", input.status ?? "all", input.limit ?? 50] as const,
};

export function meetRoomsQueryOptions(input: MeetRoomsQueryInput = defaultMeetRoomsInput) {
  return queryOptions({
    queryKey: meetQueryKeys.rooms(input),
    queryFn: () => listMeetRooms(input),
    throwOnError: false,
  });
}
