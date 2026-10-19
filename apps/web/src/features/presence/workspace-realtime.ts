import { liveEventPageSchema } from "@helix/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export function useWorkspaceRealtime(enabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    let source: EventSource;
    let stopped = false;
    let cursor: number | undefined;
    const refresh = (
      keys = [
        "mail",
        "chat",
        "notifications",
        "pending-actions",
        "pending-action-review",
        "core-apps",
        "assistant",
      ],
    ) => {
      for (const key of keys) void client.invalidateQueries({ queryKey: [key] });
    };
    const connect = () => {
      if (stopped) return;
      source = new EventSource(
        `/v1/api/events/stream?${cursor === undefined ? "tail=1" : `after=${cursor}`}`,
        { withCredentials: true },
      );
      source.addEventListener("open", () => refresh());
      source.addEventListener("refresh", () => refresh(["core-apps", "assistant"]));
      const receive = (event: MessageEvent<string>, reset: boolean) => {
        try {
          const result = liveEventPageSchema.safeParse(JSON.parse(event.data));
          if (!result.success) return;
          const page = result.data;
          if (reset || page.resetRequired) {
            refresh();
            cursor = page.latestCursor;
            source.close();
            connect();
            return;
          }
          const keys = new Set<string>();
          for (const item of page.events) {
            if (item.cursor <= (cursor ?? 0)) continue;
            if (item.type.startsWith("mail.")) keys.add("mail");
            else if (item.type.startsWith("chat.")) keys.add("chat");
            else if (item.type.startsWith("approval.")) {
              keys.add("pending-actions");
              keys.add("pending-action-review");
              keys.add("notifications");
            } else keys.add("notifications");
          }
          cursor = Math.max(cursor ?? 0, page.cursor);
          refresh([...keys]);
        } catch {
          /* Malformed transport frames never become application data. */
        }
      };
      source.addEventListener("events", (event) => receive(event as MessageEvent<string>, false));
      source.addEventListener("reset", (event) => receive(event as MessageEvent<string>, true));
    };
    connect();
    return () => {
      stopped = true;
      source.close();
    };
  }, [client, enabled]);
}
