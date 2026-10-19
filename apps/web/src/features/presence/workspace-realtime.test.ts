// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceRealtime } from "./workspace-realtime";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, handler: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, handler);
  }
  removeEventListener(type: string) {
    this.listeners.delete(type);
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown, type = "events") {
    this.listeners.get(type)?.(
      new MessageEvent(type, { data: typeof data === "string" ? data : JSON.stringify(data) }),
    );
  }
}

function Probe() {
  useWorkspaceRealtime(true);
  return null;
}

const page = (types: string[], cursor = types.length) => ({
  events: types.map((type, index) => ({
    id: `event-${index}`,
    cursor: index + 1,
    type,
    resourceId: "00000000-0000-4000-8000-000000000001",
    parentId: null,
    createdAt: new Date().toISOString(),
  })),
  cursor,
  latestCursor: cursor,
  resetRequired: false,
  hasMore: false,
});

describe("useWorkspaceRealtime", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  let invalidate: ReturnType<typeof vi.fn<QueryClient["invalidateQueries"]>>;

  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    queryClient = new QueryClient();
    invalidate = vi.fn<QueryClient["invalidateQueries"]>(() => Promise.resolve());
    queryClient.invalidateQueries = invalidate;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)),
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function source(): FakeEventSource {
    const current = FakeEventSource.last;
    if (current === null) throw new Error("No EventSource opened");
    return current;
  }

  it("subscribes once to the actor stream with credentials and closes on unmount", () => {
    expect(source().url).toBe("/v1/api/events/stream?tail=1");
    expect(source().init).toEqual({ withCredentials: true });
    act(() => root.unmount());
    expect(source().closed).toBe(true);
    root = createRoot(container);
  });

  it("refreshes every mail query when mail arrives", () => {
    source().emit(page(["mail.received", "mail.updated"]));
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ["mail"] });
  });

  it("catches up after reconnection even when no new mail frame arrives", () => {
    const connection = source();
    connection.listeners.get("open")?.(new MessageEvent("open"));
    invalidate.mockClear();
    // Mail can arrive during a connection gap, without reaching this listener.
    connection.listeners.get("open")?.(new MessageEvent("open"));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["mail"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["pending-actions"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["core-apps"] });
  });

  it("refreshes affected apps and approval states without writing or replacing drafts", () => {
    source().emit(page(["chat.direct", "approval.requested", "notification", "approval.updated"]));
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual([
      ["chat"],
      ["pending-actions"],
      ["pending-action-review"],
      ["notifications"],
    ]);
  });

  it("ignores replayed cursors and recovers a retention gap using fresh reads", () => {
    const initial = source();
    initial.emit(page(["chat.message"]));
    invalidate.mockClear();
    initial.emit(page(["chat.message"]));
    expect(invalidate).not.toHaveBeenCalled();
    initial.emit({ ...page([], 500), resetRequired: true }, "reset");
    expect(initial.closed).toBe(true);
    expect(source().url).toBe("/v1/api/events/stream?after=500");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat"] });
  });

  it("refreshes app availability on configuration hints", () => {
    source().emit({}, "refresh");
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["core-apps"],
      ["assistant"],
    ]);
  });

  it("ignores unknown and malformed frames", () => {
    source().emit({ type: "chat.message", threadId: "t1" });
    source().emit("not json");
    source().emit(page(["unknown.permission"]));
    expect(invalidate).not.toHaveBeenCalled();
  });
});
