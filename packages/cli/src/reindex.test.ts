import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { CliUsageError } from "./cli-error.js";
import { parseCliArgs } from "./parser.js";
import { runCli, type FetchLike } from "./runner.js";

class CaptureStream extends Writable {
  output = "";

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.output += String(chunk);
    callback();
  }
}

const env = { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" };

function job(status: string, totalDocuments: number, extra: Record<string, unknown> = {}) {
  return { id: "job-1", status, totalDocuments: String(totalDocuments), ...extra };
}

/** Answers the POST with `queued`, then each status poll with the next state. */
function server(states: readonly Record<string, unknown>[]) {
  const requests: { method: string; url: string }[] = [];
  let poll = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ method: String(init.method), url });
    if (init.method === "POST") return Response.json(job("queued", 0), { status: 202 });
    const state = states[Math.min(poll, states.length - 1)] ?? {};
    poll += 1;
    return Response.json(state);
  };
  return { requests, fetchImpl };
}

async function run(args: readonly string[], fetchImpl: FetchLike) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const sleeps: number[] = [];
  const code = await runCli(args, env, { stdin: Readable.from([]), stdout, stderr }, fetchImpl, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { code, stdout: stdout.output, stderr: stderr.output, sleeps };
}

describe("helix reindex arguments", () => {
  it("takes --max-wait with --all, or --status with a job id", () => {
    expect(parseCliArgs(["reindex", "--max-wait", "600", "--all"])).toEqual({
      kind: "reindex-all",
      maxWaitSeconds: 600,
    });
    expect(parseCliArgs(["reindex", "--status", "job-1"])).toEqual({
      kind: "reindex-status",
      jobId: "job-1",
    });
    expect(() => parseCliArgs(["reindex", "--all", "--max-wait", "0"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["reindex", "--status"])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["reindex", "--all", "--status", "job-1"])).toThrow(CliUsageError);
  });
});

describe("helix reindex --all", () => {
  it("queues the job and follows it to completion with progress", async () => {
    const { requests, fetchImpl } = server([
      job("processing", 1200, { counts: { mail: 1200 } }),
      job("processing", 1200, { counts: { mail: 1200 } }),
      job("processing", 3400, { counts: { mail: 3000, chat: 400 } }),
      job("completed", 3500, { counts: { mail: 3000, chat: 400, drive: 100 } }),
    ]);

    const result = await run(["reindex", "--all"], fetchImpl);

    expect(result.code).toBe(0);
    expect(requests[0]).toEqual({
      method: "POST",
      url: "https://helix.example/v1/api/admin/search/reindex",
    });
    expect(requests.slice(1).map((request) => request.url)).toEqual(
      Array(4).fill("https://helix.example/v1/api/admin/search/reindex/jobs/job-1"),
    );
    expect(result.stderr.split("\n").filter(Boolean)).toEqual([
      "Search reindex job-1: queued, 0 documents indexed. Following it; Ctrl-C stops watching, not the job.",
      "Search reindex job-1: processing, 1,200 documents indexed (mail 1,200)",
      "Search reindex job-1: processing, 3,400 documents indexed (mail 3,000, chat 400)",
      "Search reindex job-1: completed, 3,500 documents indexed (mail 3,000, chat 400, drive 100)",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: "job-1", status: "completed" });
    expect(result.sleeps).toEqual([2000, 2000, 2000, 2000]);
  });

  it("stops following after --max-wait and says how to check the job later", async () => {
    const { fetchImpl } = server([job("processing", 10)]);

    const result = await run(["reindex", "--all", "--max-wait", "5"], fetchImpl);

    expect(result.code).toBe(7);
    expect(result.sleeps).toHaveLength(3);
    expect(result.stderr).toContain(
      "Search reindex job-1 is still processing after 5s. It keeps running; check it with: helix reindex --status job-1",
    );
  });

  it("reports a failed job with its error", async () => {
    const { fetchImpl } = server([job("dead_lettered", 0, { lastError: "Meilisearch is down." })]);

    const result = await run(["reindex", "--all"], fetchImpl);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Search reindex job-1 failed: Meilisearch is down.");
  });

  it("prints only the final job with --output json", async () => {
    const { fetchImpl } = server([job("completed", 3)]);

    const result = await run(["reindex", "--all", "--output", "json"], fetchImpl);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed", totalDocuments: "3" });
  });

  it("checks a job with --status", async () => {
    const { requests, fetchImpl } = server([job("processing", 42)]);

    const result = await run(["reindex", "--status", "job-1"], fetchImpl);

    expect(result.code).toBe(0);
    expect(requests).toEqual([
      { method: "GET", url: "https://helix.example/v1/api/admin/search/reindex/jobs/job-1" },
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "processing", totalDocuments: "42" });
  });
});
