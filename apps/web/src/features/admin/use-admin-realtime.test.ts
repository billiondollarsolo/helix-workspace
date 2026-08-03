// @vitest-environment jsdom

/* The admin console's realtime hub.
 *
 * The hook itself no-ops under `MODE === "test"` so jsdom's WebSocket never
 * dials a server that is not there. `MODE` is stubbed to a non-test value
 * *before* the module is imported, because `REALTIME_ENABLED` is read once at
 * module scope, and the sockets are supplied through
 * `setAdminRealtimeSocketFactory` — the seam that exists for exactly this.
 *
 * Each test below pins a property that is expensive to get wrong in
 * production: one socket per subject (the `helix_websocket_connections_active`
 * gauge is only meaningful if a tab is not opening ten), targeted
 * invalidation (a tree-wide one would refetch ~20 admin queries per event
 * against a 5 rps ceiling), and a 1008 that stops for good (retrying an auth
 * rejection is a login loop). */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("MODE", "development");

const {
  ADMIN_REALTIME_SECTION_SUBJECTS,
  ADMIN_REALTIME_SUBJECT_ROUTES,
  resetAdminRealtime,
  setAdminRealtimeSocketFactory,
  useAdminRealtime,
} = await import("./use-admin-realtime");

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Records what the hub does to a socket and lets a test play the server. */
class FakeSocket {
  closed = false;
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  get subject(): string {
    return new URL(this.url).searchParams.get("subject") ?? "";
  }
}

describe("admin realtime hub", () => {
  let sockets: FakeSocket[];
  let queryClient: QueryClient;
  /** Every key the hub asked the cache to invalidate, in order. */
  let invalidated: unknown[];
  let roots: { root: Root; container: HTMLDivElement }[];

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    roots = [];
    setAdminRealtimeSocketFactory((url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    invalidated = [];
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation((filters) => {
      invalidated.push(filters?.queryKey);
      return Promise.resolve();
    });
  });

  afterEach(() => {
    for (const { root, container } of [...roots].reverse()) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    resetAdminRealtime();
    setAdminRealtimeSocketFactory(null);
    queryClient.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Mounts one subscriber for `section` and returns its unmount. */
  function mount(section: Parameters<typeof useAdminRealtime>[0]): () => void {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const entry = { root, container };
    roots.push(entry);

    function Probe() {
      useAdminRealtime(section);
      return null;
    }

    act(() => {
      root.render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)),
      );
    });

    let unmounted = false;
    return () => {
      if (unmounted) {
        return;
      }
      unmounted = true;
      roots = roots.filter((candidate) => candidate !== entry);
      act(() => {
        root.unmount();
      });
      container.remove();
    };
  }

  function socketFor(subject: string): FakeSocket {
    const match = sockets.find((socket) => socket.subject === subject && !socket.closed);
    if (match === undefined) {
      throw new Error(`No open socket for ${subject}`);
    }
    return match;
  }

  function routesFor(subject: string): readonly unknown[] {
    const routes = ADMIN_REALTIME_SUBJECT_ROUTES[subject];
    if (routes === undefined) {
      throw new Error(`No routes mapped for ${subject}`);
    }
    return [...routes];
  }

  function deliver(socket: FakeSocket, subject: string): void {
    act(() => {
      socket.emit("message", { data: JSON.stringify({ subject }) });
    });
  }

  it("opens one socket per distinct subject, however many sections want it", () => {
    /* Overview wants config + flags; tier readiness wants config again. Three
       acquisitions, two sockets — anything else multiplies
       `helix_websocket_connections_active` per operator tab. */
    expect(ADMIN_REALTIME_SECTION_SUBJECTS.overview).toContain("helix.config.changed");
    expect(ADMIN_REALTIME_SECTION_SUBJECTS["tier-readiness"]).toContain("helix.config.changed");

    mount("overview");
    mount("tier-readiness");

    expect(sockets).toHaveLength(2);
    expect(sockets.map((socket) => socket.subject).sort()).toEqual([
      "flags.changed.*",
      "helix.config.changed",
    ]);
  });

  it("subscribes to nothing for a section with no emitter behind it", () => {
    /* Thirteen sections have no publisher; a socket there could never fire. */
    expect(ADMIN_REALTIME_SECTION_SUBJECTS.users).toBeUndefined();

    mount("users");

    expect(sockets).toHaveLength(0);
  });

  it("invalidates the mapped query keys and only those", () => {
    mount("overview");

    deliver(socketFor("helix.config.changed"), "helix.config.changed");

    expect(invalidated).toEqual(routesFor("helix.config.changed"));
    /* Never a tree root: `["admin"]` here would refetch every admin query the
       cache holds on every config event. */
    expect(invalidated).not.toContainEqual(["admin"]);
  });

  it("routes each subject to its own keys, not to the other subject's", () => {
    mount("overview");

    deliver(socketFor("flags.changed.*"), "flags.changed.*");

    expect(invalidated).toEqual(routesFor("flags.changed.*"));
    /* The shell keeps its own copy of the app list under a different root; a
       flags change has to move both or the launcher lies until reload. */
    expect(invalidated).toContainEqual(["core-apps", "shell"]);
  });

  it("stops retrying for good after 1008", () => {
    mount("tier-readiness");
    const socket = socketFor("helix.config.changed");

    act(() => {
      socket.emit("close", { code: 1008 });
    });
    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    /* Auth rejection, or a subject the server refuses. Asking again is a login
       loop, not a recovery. */
    expect(sockets).toHaveLength(1);
  });

  it("reconnects after a normal close, with a backoff that grows", () => {
    mount("tier-readiness");

    act(() => {
      socketFor("helix.config.changed").emit("close", { code: 1006 });
    });
    act(() => {
      /* The attempt count is advanced before the delay is read, so the first
         rung is 1000 × 2¹ = 2000 ms ±20% — never later than 2400. */
      vi.advanceTimersByTime(2_500);
    });
    expect(sockets).toHaveLength(2);

    act(() => {
      socketFor("helix.config.changed").emit("close", { code: 1006 });
    });
    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    /* Second rung is 4000 ms ±20%, so 2500 ms cannot reach it. A flat ladder
       would already have reconnected here and hammered a server that is down. */
    expect(sockets).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(sockets).toHaveLength(3);
  });

  it("closes the shared socket only when the last listener releases it", () => {
    const releaseOverview = mount("overview");
    const releaseReadiness = mount("tier-readiness");
    const shared = socketFor("helix.config.changed");
    const flags = socketFor("flags.changed.*");

    releaseOverview();
    /* Still one section holding it — tearing it down here is what made moving
       between two sections that share a subject reopen the socket every time. */
    expect(shared.closed).toBe(false);
    /* The subject only overview wanted goes immediately. */
    expect(flags.closed).toBe(true);

    releaseReadiness();
    expect(shared.closed).toBe(true);
  });

  it("reopens the subject after the last listener left", () => {
    mount("tier-readiness")();
    expect(sockets).toHaveLength(1);

    mount("tier-readiness");

    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.closed).toBe(true);
    expect(sockets[1]?.closed).toBe(false);
  });
});
