/* eslint-disable helix/pacer-discipline -- Abortable transport backoff must also run outside React. */
import { liveEventPageSchema, type LiveEventPage } from "@helix/contracts";
export type {
  LiveEvent,
  LiveEventPage,
  PresenceRecord,
  PresenceStatusInput,
} from "@helix/contracts";

/** Bounded SSE decoding shared by the event listener and MCP stdio bridge. */
export async function* readServerEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    event = "message",
    data: string[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length + data.reduce((size, line) => size + line.length, 0) > 1024 * 1024)
        throw new Error("Event frame exceeds 1 MiB.");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/u, "");
        buffer = buffer.slice(end + 1);
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = "message";
          data = [];
          continue;
        }
        if (line.startsWith("event:")) event = line.slice(6).replace(/^ /u, "");
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export interface LiveClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}
export class LiveCursorResetError extends Error {
  constructor(readonly cursor: number) {
    super(
      "Event history expired or cursor is invalid. Resynchronize before accepting a new cursor.",
    );
  }
}

/** At-least-once delivery: persist page.cursor only after handling its events. */
export async function* watchLiveEvents(
  options: LiveClientOptions & { readonly after?: number; readonly signal: AbortSignal },
): AsyncGenerator<LiveEventPage> {
  const base = new URL(options.baseUrl);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password)
    throw new Error("An HTTP(S) origin without credentials is required.");
  let cursor = options.after ?? 0,
    attempt = 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid event cursor.");
  while (!options.signal.aborted) {
    try {
      const url = new URL("/v1/api/events/stream", base);
      url.searchParams.set("after", String(cursor));
      const response = await (options.fetch ?? fetch)(url, {
        headers: { authorization: `Bearer ${options.token}`, accept: "text/event-stream" },
        signal: options.signal,
        redirect: "error",
      });
      if ([401, 403].includes(response.status))
        throw new LiveAuthorizationError("Live connection authorization was rejected.");
      if (!response.ok || !response.body)
        throw new Error(`Live connection failed (${String(response.status)}).`);
      if (!response.headers.get("content-type")?.startsWith("text/event-stream"))
        throw new LiveAuthorizationError("Expected an event stream. Check the API URL.");
      for await (const frame of readServerEvents(response.body)) {
        if (frame.event !== "events" && frame.event !== "reset") continue;
        const parsed = liveEventPageSchema.safeParse(JSON.parse(frame.data));
        if (!parsed.success)
          throw new LiveAuthorizationError("The server returned an invalid event page.");
        const page = parsed.data;
        if (page.resetRequired) throw new LiveCursorResetError(page.cursor);
        if (page.cursor < cursor) throw new LiveAuthorizationError("Event cursor moved backwards.");
        yield page;
        cursor = page.cursor;
        attempt = 0;
      }
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AbortSignal can change during awaited network reads.
      if (options.signal.aborted) return;
      if (error instanceof LiveCursorResetError || error instanceof LiveAuthorizationError)
        throw error;
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(
        finish,
        Math.min(30000, 500 * 2 ** Math.min(attempt++, 6)) + Math.random() * 250,
      );
      options.signal.addEventListener("abort", finish, { once: true });
      if (options.signal.aborted) finish();
    });
  }
}
class LiveAuthorizationError extends Error {}
