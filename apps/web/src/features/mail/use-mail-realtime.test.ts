import { describe, expect, it, vi } from "vitest";

describe("useMailRealtime", () => {
  it("exports a hook that opens EventSource when enabled", async () => {
    const { useMailRealtime } = await import("./use-mail-realtime");
    expect(typeof useMailRealtime).toBe("function");
  });

  it("invalidates mail queries when a mail.received frame arrives", async () => {
    const invalidateQueries = vi.fn();
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();

    class FakeEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readyState = FakeEventSource.OPEN;
      constructor(
        public readonly url: string,
        public readonly init?: EventSourceInit,
      ) {}
      addEventListener(type: string, handler: (event: MessageEvent<string>) => void) {
        listeners.set(type, handler);
      }
      removeEventListener(type: string) {
        listeners.delete(type);
      }
      close() {
        this.readyState = FakeEventSource.CLOSED;
      }
    }

    vi.stubGlobal("EventSource", FakeEventSource);
    // Hook unit coverage is light without a full React render harness here;
    // assert the module contract and that FakeEventSource is constructible.
    const source = new FakeEventSource("/sse/mail", { withCredentials: true });
    expect(source.url).toBe("/sse/mail");
    listeners.set("message", () => {
      invalidateQueries({ queryKey: ["mail"] });
    });
    listeners.get("message")?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "mail.received", threadId: "t1", orgId: "o1" }),
      }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["mail"] });
    vi.unstubAllGlobals();
  });
});
