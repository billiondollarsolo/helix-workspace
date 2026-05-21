import { createFileRoute } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  meetRoomsQueryOptions,
  type MeetRoomsQueryInput,
  type MeetRoomsStatusFilter,
} from "@/features/meet/queries";

export interface MeetRouteSearch {
  readonly room?: string;
  readonly status?: MeetRoomsStatusFilter;
}

const meetRouteSearchSchema = z
  .object({
    room: z.string().trim().min(1).optional().catch(undefined),
    status: z
      .union([z.literal("active"), z.literal("live"), z.literal("ended")])
      .optional()
      .catch(undefined),
  })
  .catch({});

export const Route = createFileRoute("/_shell/meet/")({
  validateSearch: validateMeetRouteSearch,
  loaderDeps: ({ search }) => ({
    room: search.room,
    status: search.status,
  }),
  loader: async ({ context, deps }) => {
    await preloadMeetRouteData(context.queryClient, deps);
  },
});

export function validateMeetRouteSearch(search: Record<string, unknown>): MeetRouteSearch {
  const parsed = meetRouteSearchSchema.parse(search);
  return {
    room: parsed.room,
    status: parseMeetRouteStatus(parsed.status),
  };
}

export async function preloadMeetRouteData(
  queryClient: QueryClient,
  deps: MeetRouteSearch,
): Promise<void> {
  await queryClient
    .ensureQueryData(meetRoomsQueryOptions(meetRoomsQueryInputFromRouteSearch(deps)))
    .catch(() => undefined);
}

export function meetRoomsQueryInputFromRouteSearch(search: MeetRouteSearch): MeetRoomsQueryInput {
  return search.status === undefined ? { limit: 50 } : { status: search.status, limit: 50 };
}

function parseMeetRouteStatus(value: unknown): MeetRoomsStatusFilter | undefined {
  if (value === "active" || value === "live") {
    return "active";
  }

  if (value === "ended") {
    return "ended";
  }

  return undefined;
}
