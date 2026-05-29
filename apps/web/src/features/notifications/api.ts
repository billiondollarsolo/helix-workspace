/* Notifications client — wraps notifications.* helix tools. The bell badge
   reads unread-count; the panel reads list. Both surfaces invalidate on
   mark-read so the badge clears immediately. */

import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { callTool } from "@/lib/tool-call";

export interface NotificationItem {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly verb: string;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly summary: string;
  readonly body: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly unread: boolean;
}

interface ListNotificationsResponse {
  readonly items: readonly NotificationItem[];
}

interface UnreadCountResponse {
  readonly count: number;
}

export const notificationsQueryKey = ["notifications"] as const;
export const unreadCountQueryKey = [...notificationsQueryKey, "unread-count"] as const;

export function notificationsListQueryOptions(unreadOnly = false) {
  return queryOptions({
    queryKey: [...notificationsQueryKey, "list", { unreadOnly }],
    queryFn: () =>
      callTool<ListNotificationsResponse>("notifications.list", {
        unreadOnly,
        limit: 50,
      }),
    staleTime: 30_000,
  });
}

export function unreadCountQueryOptions() {
  return queryOptions({
    queryKey: unreadCountQueryKey,
    queryFn: () => callTool<UnreadCountResponse>("notifications.unread-count", {}),
    // Poll every 30s; cheap query, keeps the bell badge close to real-time
    // without a websocket. Replace with SSE / push later.
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: readonly string[]) =>
      callTool<{ updated: number }>("notifications.mark-read", { ids }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: notificationsQueryKey });
    },
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callTool<{ updated: number }>("notifications.mark-all-read", {}),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: notificationsQueryKey });
    },
  });
}
