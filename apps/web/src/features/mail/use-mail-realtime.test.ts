// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMailRealtime } from "./use-mail-realtime";

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
  emit(data: unknown) {
    this.listeners.get("message")?.(
      new MessageEvent("message", { data: typeof data === "string" ? data : JSON.stringify(data) }),
    );
  }
}

function Probe() {
  useMailRealtime(true);
  return null;
}

describe("useMailRealtime", () => {
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

  it("subscribes to the mail stream with credentials and closes on unmount", () => {
    expect(source().url).toBe("/v1/sse/mail");
    expect(source().init).toEqual({ withCredentials: true });
    act(() => root.unmount());
    expect(source().closed).toBe(true);
    root = createRoot(container);
  });

  it("refreshes every mail query when mail arrives", () => {
    source().emit({ type: "mail.received", threadId: "t1", orgId: "o1" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["mail"] });
  });

  it("catches up after reconnection even when no new mail frame arrives", () => {
    const connection = source();
    connection.listeners.get("open")?.(new MessageEvent("open"));
    invalidate.mockClear();
    // Mail can arrive during a connection gap, without reaching this listener.
    connection.listeners.get("open")?.(new MessageEvent("open"));
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["mail"] });
  });

  it("refreshes the changed thread, the lists, folder counts and search on mail.updated", () => {
    source().emit({ type: "mail.updated", threadId: "t-42", orgId: "o1" });
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual([
      ["mail", "thread", "t-42"],
      ["mail", "threads"],
      ["mail", "folders"],
      ["mail", "search"],
    ]);
  });

  it("ignores unknown and malformed frames", () => {
    source().emit({ type: "chat.message", threadId: "t1" });
    source().emit("not json");
    expect(invalidate).not.toHaveBeenCalled();
  });
});
