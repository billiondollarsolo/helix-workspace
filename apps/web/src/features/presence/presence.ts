/* eslint-disable helix/pacer-discipline -- Connection lease heartbeats are transport lifecycle timers, not UI debouncing. */
import { presenceRecordSchema, type PresenceRecord } from "@helix/contracts";
import { queryOptions } from "@tanstack/react-query";
import { useEffect } from "react";
import { z } from "zod";
import { authenticatedFetch } from "@/lib/auth";
import { responseError } from "@/lib/tool-call";
import { randomId } from "@/lib/random-id";

export async function presenceRequest(path: string, method = "GET", body?: unknown) {
  const response = await authenticatedFetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const output: unknown = await response.json();
  if (!response.ok) throw responseError(response, output, "Presence request");
  return output;
}
export function presenceQueryOptions(ids?: readonly string[]) {
  const actors = ids === undefined ? undefined : [...new Set(ids)].sort().slice(0, 100);
  return queryOptions({
    queryKey: ["presence", actors ?? "self"],
    queryFn: async () =>
      z
        .object({ items: z.array(presenceRecordSchema) })
        .parse(await presenceRequest(`/api/presence${actors ? `?actors=${actors.join(",")}` : ""}`))
        .items,
    throwOnError: false,
    refetchInterval: 15000,
    staleTime: 10000,
    enabled: actors === undefined || actors.length > 0,
  });
}
export function presenceLabel(value: PresenceRecord): string {
  const availability = {
    available: "Available",
    away: "Away",
    dnd: "Do not disturb",
    invisible: "Invisible",
  }[value.availability];
  const state = !value.connected
    ? "Offline"
    : value.state === "working"
      ? "Working"
      : value.state === "waiting_approval"
        ? "Waiting for approval"
        : value.state === "idle"
          ? "Idle"
          : availability;
  return [value.availability === "available" ? state : availability, value.emoji, value.text]
    .filter(Boolean)
    .join(" · ");
}
export function useWorkspacePresence(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const connectionId = randomId();
    let lastActivity = Date.now(),
      pending = false,
      closed = false;
    const active = () => {
      lastActivity = Date.now();
    };
    const send = async (disconnect = false) => {
      if (pending && !disconnect) return;
      pending = true;
      try {
        await presenceRequest("/api/presence/heartbeat", "POST", {
          connectionId,
          state:
            document.visibilityState === "visible" && Date.now() - lastActivity < 300000
              ? "active"
              : "idle",
          disconnect,
        });
      } catch {
        /* The lease expires if offline; retry on the next heartbeat. */
      } finally {
        pending = false;
      }
    };
    const heartbeat = () => {
      if (!closed) void send();
    };
    window.addEventListener("pointerdown", active);
    window.addEventListener("keydown", active);
    document.addEventListener("visibilitychange", heartbeat);
    const timer = setInterval(heartbeat, 25000);
    heartbeat();
    return () => {
      closed = true;
      clearInterval(timer);
      window.removeEventListener("pointerdown", active);
      window.removeEventListener("keydown", active);
      document.removeEventListener("visibilitychange", heartbeat);
      void send(true);
    };
  }, [enabled]);
}
