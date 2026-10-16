import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { watchLiveEvents, type LiveEventPage } from "@helix/sdk/live";
import { parseEventsWatch, runEventsWatch } from "./events.js";
import { createHttpClient } from "./http.js";
vi.mock("@helix/sdk/live", () => ({ watchLiveEvents: vi.fn() }));
const page: LiveEventPage = {
  events: [
    {
      id: "event:1",
      cursor: 1,
      type: "chat.direct",
      resourceId: "00000000-0000-4000-8000-000000000001",
      parentId: null,
      createdAt: "2026-10-15T00:00:00Z",
    },
  ],
  cursor: 1,
  latestCursor: 1,
  hasMore: false,
  resetRequired: false,
};
const context = () => ({
  env: { HELIX_BASE_URL: "https://helix.test", HELIX_API_KEY: "private-test-key" },
  io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
  http: createHttpClient(fetch, { timeoutMs: 1000, sleep: async () => {} }),
  options: { output: "json" as const, timeoutMs: 1000 },
  idempotencyKey: "test",
  newIdempotencyKey: () => "test",
});
describe("Event runner checkpoints", () => {
  it("requires a checkpoint and rejects unknown switches", () => {
    expect(() => parseEventsWatch([])).toThrow("cursor-file");
    expect(() => parseEventsWatch(["--unknown", "x"])).toThrow("Usage");
  });
  it("preserves an explicit resynchronization baseline and rejects invalid cursors", () => {
    expect(parseEventsWatch(["--cursor-file", "fresh.json", "--after", "42"]).after).toBe(42);
    expect(() => parseEventsWatch(["--cursor-file", "fresh.json", "--after", "-1"])).toThrow(
      "nonnegative",
    );
  });
  it("persists only completed pages and prevents concurrent ownership", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helix-events-"));
    const cursorFile = join(dir, "cursor.json");
    vi.mocked(watchLiveEvents).mockImplementation(async function* () {
      yield page;
    });
    try {
      expect(
        await runEventsWatch({ kind: "events-watch", cursorFile, all: false }, context()),
      ).toBe(0);
      const output = await readFile(cursorFile, "utf8");
      expect(JSON.parse(output)).toMatchObject({ cursor: 1 });
      expect(output).not.toContain("private-test-key");
      expect((await stat(cursorFile)).mode & 0o777).toBe(0o600);
      await writeFile(cursorFile + ".lock", "another-process");
      await expect(
        runEventsWatch({ kind: "events-watch", cursorFile, all: false }, context()),
      ).rejects.toThrow("locked");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("leaves the cursor unchanged when the configured executable fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helix-events-"));
    const cursorFile = join(dir, "cursor.json"),
      handler = join(dir, "fail");
    vi.mocked(watchLiveEvents).mockImplementation(async function* () {
      yield page;
    });
    try {
      await writeFile(handler, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      await expect(
        runEventsWatch({ kind: "events-watch", cursorFile, handler, all: false }, context()),
      ).rejects.toThrow("checkpoint was not advanced");
      await expect(stat(cursorFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(cursorFile + ".lock")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
