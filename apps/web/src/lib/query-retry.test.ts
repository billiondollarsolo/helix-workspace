import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUERY_RETRY_DEFAULTS } from "./query-retry";
import { callTool } from "./tool-call";

const failureBody = { error: { code: "RATE_LIMITED", message: "Too many requests." } };
let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  client = new QueryClient({
    defaultOptions: {
      queries: QUERY_RETRY_DEFAULTS,
      mutations: { retry: false },
    },
  });
});

afterEach(() => {
  client.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("shared read-query rate limit recovery", () => {
  it("recovers from a 429 envelope after Retry-After", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(failureBody, {
          status: 429,
          headers: { "Retry-After": "2" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ messages: [{ id: "message-1" }] }));

    const result = client.fetchQuery({
      queryKey: ["history"],
      queryFn: () => callTool("chat.history", {}, { fetchImpl }),
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ messages: [{ id: "message-1" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops after three retries when the rate limit never clears", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json(failureBody, { status: 429 })));
    const result = expect(
      client.fetchQuery({
        queryKey: ["history"],
        queryFn: () => callTool("chat.history", {}, { fetchImpl }),
      }),
    ).rejects.toMatchObject({ status: 429, message: "Too many requests." });

    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([403, 500])("reports HTTP %s without retrying", async (status) => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json(
          {
            error: { message: "Cannot read resource 429" },
          },
          { status },
        ),
      ),
    );

    await expect(
      client.fetchQuery({
        queryKey: ["history"],
        queryFn: () => callTool("chat.history", {}, { fetchImpl }),
      }),
    ).rejects.toMatchObject({ status, message: "Cannot read resource 429" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a rate-limited mutation", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json(failureBody, { status: 429 })));
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => callTool("chat.send", { body: "Hello" }, { fetchImpl }),
    });

    await expect(mutation.execute(undefined)).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("tool error retry metadata", () => {
  it.each([
    { header: "2", expected: 2_000 },
    { header: "Thu, 10 Sep 2026 12:00:03 GMT", expected: 3_000 },
    { header: "invalid", expected: undefined },
  ])(
    "preserves status and Retry-After $header without changing the server message",
    async ({ header, expected }) => {
      vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
      const fetchImpl = vi.fn(() =>
        Promise.resolve(
          Response.json(failureBody, {
            status: 429,
            headers: { "Retry-After": header },
          }),
        ),
      );

      await expect(callTool("chat.history", {}, { fetchImpl })).rejects.toMatchObject({
        message: "Too many requests.",
        status: 429,
        retryAfterMs: expected,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves a pending approval failure without replaying either request", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ status: "pending_confirmation", pending: { id: "pending-1" } }),
      )
      .mockResolvedValueOnce(Response.json(failureBody, { status: 429 }));

    await expect(callTool("drive.delete", { id: "file-1" }, { fetchImpl })).rejects.toMatchObject({
      message: "Too many requests.",
      status: 429,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
