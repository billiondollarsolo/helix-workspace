/* Live updates for the admin console.
 *
 * Before this file, `features/admin` contained zero `EventSource`, zero
 * `WebSocket` and zero `refetchInterval`: every one of the 22 sections was a
 * 30-second snapshot that moved only when the operator themselves mutated
 * something. A service could go down and Admin › Services kept showing green
 * until you navigated away and back.
 *
 * What this can honestly fix is bounded by what the backend actually publishes.
 * Five subject families are admin-relevant (`SUBJECT_ROUTES` below); thirteen
 * sections have no subject at all, and for those the honest answer is an
 * explicit `refetchInterval` in their own `queryOptions` with a comment naming
 * the missing emitter — not a "live" indicator over a frozen page.
 *
 * Transport constraints, all from `apps/helix/src/platform/events/routes.ts`:
 *   - one subject per socket (an array query param is collapsed to the first)
 *   - NATS-style `*` / `>` wildcards, but a *bare* `*` or `>` is rejected 1008,
 *     as is any `chat.` root — those must use the room-authorized chat socket
 *   - cookie auth on the upgrade; per `features/chat/api.ts`, reusable access
 *     tokens must never be copied into `Sec-WebSocket-Protocol`
 *   - close 1013 means the server has no bus at all
 *
 * Hence the ref-counted hub: one socket per *distinct subject* per tab, shared
 * by every section that wants it. Ten sections each opening their own socket
 * would multiply `helix_websocket_connections_active{route="/events/ws"}`
 * (apps/helix/src/platform/websocket-metrics.ts) by ten per operator tab and
 * make the gauge useless for capacity planning. */

import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { Debouncer } from "@tanstack/pacer/debouncer";
import type { AdminSectionId } from "@/features/admin/admin-console-data";

/* ------------------------------------------------------------------ */
/* Subject routing                                                     */
/* ------------------------------------------------------------------ */

/** Subscription filter -> the query keys an arriving frame invalidates.
 *
 *  Targeted keys, never a tree root. `use-mail-realtime.ts` invalidates the
 *  whole `["mail"]` tree on any frame; the same pattern here would refetch
 *  roughly twenty admin queries on every quota event — turning a liveness
 *  feature into a request-budget problem against a 5 rps ceiling.
 *
 *  `flags.changed.*` rather than `flags.changed.<orgId>`: the org id is not
 *  something the console has to hand, and the server already scopes delivery to
 *  the caller's tenant. A bare `*` would be rejected; a leading concrete token
 *  is required. */
const SUBJECT_ROUTES: Readonly<Record<string, readonly QueryKey[]>> = {
  "helix.config.changed": [
    ["admin", "platform-config"],
    ["admin", "plugins", "catalog"],
  ],
  "flags.changed.*": [
    ["admin", "tenant-config"],
    ["admin", "core-apps"],
    /* The shell's own copy lives under a different root (`core-apps-api.ts`),
       and it is what the app launcher and rail render — enabling an app in
       Workspace apps has to move both or the launcher lies until reload. */
    ["core-apps", "shell"],
  ],
  "platform.ai_cost.warning": [["admin", "ai-cost-limits"]],
  "quota.storage.exceeded": [["admin", "drive"]],
  "platform.pending_action.created": [["admin", "agent-controls"]],
};

/** Which subjects a section actually cares about.
 *
 *  Sections absent from this map subscribe to nothing — deliberately. They are
 *  the thirteen with no emitter behind them (services, users, groups, domains,
 *  identity, policies, oauth-apps, app-passwords, agent-credentials, webhooks,
 *  audit, chat retention, mail config). Adding them here would connect a socket
 *  that can never fire. */
const SECTION_SUBJECTS: Partial<Record<AdminSectionId, readonly string[]>> = {
  overview: ["helix.config.changed", "flags.changed.*"],
  "tier-readiness": ["helix.config.changed"],
  "ai-providers": ["helix.config.changed"],
  "workspace-settings": ["flags.changed.*"],
  "workspace-apps": ["flags.changed.*"],
  "ai-costs": ["platform.ai_cost.warning"],
  "ai-observability": ["platform.ai_cost.warning"],
  drive: ["quota.storage.exceeded"],
  "agent-controls": ["platform.pending_action.created"],
};

/* ------------------------------------------------------------------ */
/* Connection state                                                    */
/* ------------------------------------------------------------------ */

/** `live` — at least one socket open. `connecting` — trying, none open yet.
 *  `offline` — the server refused permanently (auth) or has no bus, so the
 *  sections' own polling is all there is. Rendered by the console so a dead
 *  socket can never read as a quiet system. */
export type AdminRealtimeState = "live" | "connecting" | "offline";

let connectionState: AdminRealtimeState = "connecting";
const stateListeners = new Set<() => void>();

function setConnectionState(next: AdminRealtimeState): void {
  if (connectionState === next) {
    return;
  }
  connectionState = next;
  for (const listener of stateListeners) {
    listener();
  }
}

function recomputeConnectionState(): void {
  const entries = [...hub.values()];
  if (entries.length === 0) {
    setConnectionState("connecting");
    return;
  }
  if (entries.some((entry) => entry.open)) {
    setConnectionState("live");
    return;
  }
  setConnectionState(entries.every((entry) => entry.givenUp) ? "offline" : "connecting");
}

/** Subscribe a component to the console's realtime status. */
export function useAdminRealtimeState(): AdminRealtimeState {
  return useSyncExternalStore(
    (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    () => connectionState,
    () => "connecting" as const,
  );
}

/* ------------------------------------------------------------------ */
/* Socket hub                                                          */
/* ------------------------------------------------------------------ */

interface AdminEventFrame {
  readonly subject?: string;
}

interface HubEntry {
  socket: WebSocket | null;
  refCount: number;
  open: boolean;
  /** Stopped for good — 1008 (auth / rejected subject) or 1013 (no bus).
   *  Retrying an auth rejection is a login loop, not a recovery. */
  givenUp: boolean;
  attempt: number;
  readonly listeners: Set<(frame: AdminEventFrame) => void>;
  readonly reconnect: Debouncer<() => void>;
}

const hub = new Map<string, HubEntry>();

/** Injectable for tests; jsdom's own WebSocket would otherwise dial a server
 *  that is not there, once per test file, and sit in a reconnect ladder. */
export type SocketFactory = (url: string) => WebSocket;

let socketFactory: SocketFactory | null = null;

/** Test seam. Passing `null` restores the browser default. */
export function setAdminRealtimeSocketFactory(factory: SocketFactory | null): void {
  socketFactory = factory;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER = 0.2;

function reconnectDelay(attempt: number): number {
  const exponential = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  /* ±20%. Every admin tab in the fleet is disconnected by the same deploy, so
     an unjittered ladder reconnects them all in the same millisecond. */
  return exponential * (1 + (Math.random() * 2 - 1) * RECONNECT_JITTER);
}

/** `/events/ws?subject=…` as an absolute ws(s) URL. No token in the query
 *  string — the same-origin session cookie rides the upgrade. */
function eventsUrl(subject: string): string {
  const url = new URL("/events/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("subject", subject);
  return url.toString();
}

function openSocket(subject: string, entry: HubEntry): void {
  if (entry.givenUp || entry.refCount === 0) {
    return;
  }

  let socket: WebSocket;
  try {
    socket =
      socketFactory === null
        ? new WebSocket(eventsUrl(subject))
        : socketFactory(eventsUrl(subject));
  } catch {
    /* A malformed URL or a blocked upgrade is not recoverable by retrying
       immediately; fall into the same ladder as a close. */
    entry.attempt += 1;
    entry.reconnect.maybeExecute();
    recomputeConnectionState();
    return;
  }
  entry.socket = socket;

  socket.addEventListener("open", () => {
    entry.open = true;
    recomputeConnectionState();
  });

  socket.addEventListener("message", (event: MessageEvent<string>) => {
    /* Reset the ladder on a *received frame*, not on `open`: a proxy that
       accepts the upgrade and drops it a second later would otherwise reset the
       backoff forever and hammer the server. */
    entry.attempt = 0;
    let frame: AdminEventFrame;
    try {
      frame = JSON.parse(event.data) as AdminEventFrame;
    } catch {
      /* A malformed frame is not a reason to drop a healthy connection. */
      return;
    }
    for (const listener of entry.listeners) {
      listener(frame);
    }
  });

  socket.addEventListener("close", (event: CloseEvent) => {
    entry.open = false;
    entry.socket = null;
    /* 1008: authentication required, or a subject the server refuses (bare
       wildcard / chat root). 1013: the deployment has no event bus. Neither is
       fixed by asking again. */
    if (event.code === 1008 || event.code === 1013) {
      entry.givenUp = true;
      recomputeConnectionState();
      return;
    }
    if (entry.refCount > 0) {
      entry.attempt += 1;
      entry.reconnect.maybeExecute();
    }
    recomputeConnectionState();
  });

  socket.addEventListener("error", () => {
    /* `close` always follows; the ladder is advanced there so a socket that
       errors and closes does not double-increment the attempt count. */
  });
}

/** Open (or join) the socket for one subject. Returns a release function. */
function acquire(subject: string, listener: (frame: AdminEventFrame) => void): () => void {
  let entry = hub.get(subject);
  if (entry === undefined) {
    const created: HubEntry = {
      socket: null,
      refCount: 0,
      open: false,
      givenUp: false,
      attempt: 0,
      listeners: new Set(),
      /* House rule `helix/pacer-discipline`: scheduled work goes through
         Pacer, never a bare setTimeout. A debouncer with a dynamic `wait` is
         the shape that fits a growing backoff — each `maybeExecute` re-reads
         the delay from the current attempt count. */
      reconnect: new Debouncer(
        () => {
          openSocket(subject, hub.get(subject) ?? created);
        },
        { wait: () => reconnectDelay(created.attempt) },
      ),
    };
    entry = created;
    hub.set(subject, created);
  }

  entry.listeners.add(listener);
  entry.refCount += 1;
  if (entry.socket === null && !entry.givenUp) {
    openSocket(subject, entry);
  }
  recomputeConnectionState();

  let released = false;
  return () => {
    /* Idempotent: React's StrictMode double-invokes effect cleanups in
       development, and a second decrement would close a socket the remounted
       effect is still using. */
    if (released) {
      return;
    }
    released = true;
    const current = hub.get(subject);
    if (current === undefined) {
      return;
    }
    current.listeners.delete(listener);
    current.refCount -= 1;
    if (current.refCount <= 0) {
      current.reconnect.cancel();
      current.socket?.close();
      hub.delete(subject);
    }
    recomputeConnectionState();
  };
}

/** Close every socket and forget all state. Tests only. */
export function resetAdminRealtime(): void {
  for (const entry of hub.values()) {
    entry.reconnect.cancel();
    entry.socket?.close();
  }
  hub.clear();
  /* Through the setter, not a bare assignment: anything subscribed via
     `useAdminRealtimeState` has to be told, or a reset leaves a stale "live"
     indicator on screen with no socket behind it. */
  setConnectionState("connecting");
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

/* jsdom ships a WebSocket that would dial a server which is not there, once per
   test file, and then sit in the reconnect ladder. The hub itself is unit
   tested through `setAdminRealtimeSocketFactory`. */
const REALTIME_ENABLED = import.meta.env.MODE !== "test";

/** Subscribe the console to the subjects the current section cares about.
 *
 *  Mounted once in `AdminConsole` rather than per section, so moving between
 *  two sections that share a subject does not tear the socket down and open it
 *  again. */
export function useAdminRealtime(section: AdminSectionId): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!REALTIME_ENABLED || typeof WebSocket === "undefined") {
      return;
    }
    const subjects = SECTION_SUBJECTS[section];
    if (subjects === undefined) {
      return;
    }

    const releases = subjects.map((subject) =>
      acquire(subject, () => {
        invalidateForSubject(queryClient, subject);
      }),
    );
    return () => {
      for (const release of releases) {
        release();
      }
    };
  }, [queryClient, section]);
}

function invalidateForSubject(queryClient: QueryClient, subject: string): void {
  for (const queryKey of SUBJECT_ROUTES[subject] ?? []) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/** Exported for the console's own tests and for documentation of the mapping. */
export const ADMIN_REALTIME_SUBJECT_ROUTES = SUBJECT_ROUTES;
export const ADMIN_REALTIME_SECTION_SUBJECTS = SECTION_SUBJECTS;
