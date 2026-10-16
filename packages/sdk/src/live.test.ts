import { describe, expect, it } from "vitest";
import { readServerEvents, watchLiveEvents, LiveCursorResetError } from "./live.js";
const stream = (parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
describe("Live event client", () => {
  it("decodes split SSE frames and ignores comments", async () => {
    const events = [];
    for await (const event of readServerEvents(
      stream([": hi\r\n\neve", 'nt: message\ndata: {"hello":', '"world"}\n\n']),
    ))
      events.push(event);
    expect(events).toEqual([{ event: "message", data: '{"hello":"world"}' }]);
  });
  it("bounds incomplete frames", async () => {
    const reader = readServerEvents(stream(["data: " + "x".repeat(1024 * 1024)]));
    await expect(reader.next()).rejects.toThrow("1 MiB");
  });
  it("refuses silent cursor resets and stops on denied credentials", async () => {
    const controller = new AbortController();
    const page = { events: [], cursor: 9, latestCursor: 9, hasMore: false, resetRequired: true };
    const client = watchLiveEvents({
      baseUrl: "https://helix.test",
      token: "test",
      signal: controller.signal,
      fetch: async () =>
        new Response(stream([`event: reset\ndata: ${JSON.stringify(page)}\n\n`]), {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    await expect(client.next()).rejects.toBeInstanceOf(LiveCursorResetError);
    const denied = watchLiveEvents({
      baseUrl: "https://helix.test",
      token: "test",
      signal: controller.signal,
      fetch: async () => new Response("", { status: 403 }),
    });
    await expect(denied.next()).rejects.toThrow("authorization");
  });
});
