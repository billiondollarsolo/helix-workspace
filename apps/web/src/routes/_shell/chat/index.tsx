import { createFileRoute } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  chatMessageListQueryOptions,
  chatRoomListQueryOptions,
  chatSearchQueryOptions,
  isBackendChatRoomId,
} from "@/features/chat/queries";

interface ChatRouteLoaderDeps {
  readonly message?: string;
  readonly room?: string;
}

const chatRouteSearchSchema = z
  .object({
    message: z.string().trim().min(1).optional().catch(undefined),
    room: z.string().trim().min(1).optional().catch(undefined),
  })
  .catch({});

export const Route = createFileRoute("/_shell/chat/")({
  validateSearch: validateChatRouteSearch,
  loaderDeps: ({ search }) => ({
    message: search.message,
    room: search.room,
  }),
  loader: async ({ context, deps }) => {
    await preloadChatRouteData(context.queryClient, deps);
  },
});

export function validateChatRouteSearch(search: Record<string, unknown>): ChatRouteLoaderDeps {
  return chatRouteSearchSchema.parse(search);
}

export async function preloadChatRouteData(
  queryClient: QueryClient,
  deps: ChatRouteLoaderDeps,
): Promise<void> {
  await Promise.all([
    queryClient.ensureQueryData(chatSearchQueryOptions()),
    queryClient.ensureQueryData(chatRoomListQueryOptions()),
    isBackendChatRoomId(deps.room)
      ? queryClient.ensureQueryData(chatMessageListQueryOptions(deps.room))
      : Promise.resolve(undefined),
  ]).catch(() => undefined);
}
