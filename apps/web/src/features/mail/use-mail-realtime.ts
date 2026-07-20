import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Subscribe to `GET /sse/mail` and invalidate mail list/folder queries on
 * activity.mail.* events. Drop polling refetchInterval once this is mounted
 * in MailShell.
 */
export function useMailRealtime(enabled = true): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") {
      return;
    }

    const source = new EventSource("/sse/mail", { withCredentials: true });

    const onMessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string };
        if (payload.type === "mail.received" || payload.type === "mail.sent") {
          void queryClient.invalidateQueries({ queryKey: ["mail"] });
        }
      } catch {
        // ignore malformed frames
      }
    };

    source.addEventListener("message", onMessage);
    return () => {
      source.removeEventListener("message", onMessage);
      source.close();
    };
  }, [enabled, queryClient]);
}
