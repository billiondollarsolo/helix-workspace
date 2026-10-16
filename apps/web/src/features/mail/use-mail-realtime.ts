import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

/**
 * Subscribe to `GET /sse/mail` and refresh mail queries on activity.mail.*
 * frames (`{ type, threadId, orgId }`):
 *  - `mail.received` / `mail.sent`: everything under `["mail"]`.
 *  - `mail.updated`: a server-side change to one conversation (e.g. the AI
 *    decision model filed it in Spam) — that thread, the lists it may have
 *    moved between, folder counts, and search results.
 */
export function useMailRealtime(enabled = true): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") {
      return;
    }

    const source = new EventSource("/v1/sse/mail", { withCredentials: true });
    // Events missed while disconnected are not replayed by the mail stream.
    const onOpen = () => {
      void queryClient.invalidateQueries({ queryKey: ["mail"] });
    };

    const onMessage = (event: MessageEvent<string>) => {
      try {
        handleMailFrame(queryClient, JSON.parse(event.data) as unknown);
      } catch {
        // ignore malformed frames
      }
    };

    source.addEventListener("message", onMessage);
    source.addEventListener("open", onOpen);
    return () => {
      source.removeEventListener("message", onMessage);
      source.removeEventListener("open", onOpen);
      source.close();
    };
  }, [enabled, queryClient]);
}

function handleMailFrame(queryClient: QueryClient, frame: unknown): void {
  if (typeof frame !== "object" || frame === null || !("type" in frame)) return;
  if (frame.type === "mail.received" || frame.type === "mail.sent") {
    void queryClient.invalidateQueries({ queryKey: ["mail"] });
    return;
  }
  if (frame.type !== "mail.updated") return;
  const threadId =
    "threadId" in frame && typeof frame.threadId === "string" ? frame.threadId : null;
  if (threadId === null) {
    void queryClient.invalidateQueries({ queryKey: ["mail"] });
    return;
  }
  for (const queryKey of [
    ["mail", "thread", threadId],
    ["mail", "threads"],
    ["mail", "folders"],
    ["mail", "search"],
  ]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}
