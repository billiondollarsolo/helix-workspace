import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { type CliDependencies, runCli, type FetchLike } from "./runner.js";

const env = { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" };

class CaptureStream extends Writable {
  output = "";

  override _write(chunk: unknown, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.output += String(chunk);
    done();
  }
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function run(
  args: readonly string[],
  respond: (call: Call, index: number) => Response | Promise<Response>,
  options: {
    readonly stdin?: NodeJS.ReadableStream;
    readonly env?: Record<string, string>;
    readonly dependencies?: CliDependencies;
  } = {},
) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return await respond({ url, init }, calls.length - 1);
  };
  const code = await runCli(
    args,
    options.env ?? env,
    { stdin: options.stdin ?? Readable.from([]), stdout, stderr },
    fetchImpl,
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...options.dependencies,
    },
  );
  return { code, calls, sleeps, stdout: stdout.output, stderr: stderr.output };
}

function body(call: Call | undefined): unknown {
  return JSON.parse(typeof call?.init.body === "string" ? call.init.body : "null");
}

function header(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init.headers).get(name);
}

describe("mail wrappers target real tools (CA1, CA2)", () => {
  it("lists threads through mail.threads.list with folder and offset paging", async () => {
    const result = await run(
      ["mail", "list", "--folder", "sent", "--label", "work", "--limit", "20", "--offset", "40"],
      () => json({ threads: [], total: 0, limit: 20, offset: 40 }),
    );

    expect(result.code).toBe(0);
    expect(result.calls[0]?.url).toBe("https://helix.example/v1/api/tools/mail.threads.list");
    expect(body(result.calls[0])).toEqual({ folder: "sent", label: "work", limit: 20, offset: 40 });
  });

  it("sends mail.search labels and rejects flags the schema would strip", async () => {
    const result = await run(["mail", "search", "--query", "q", "--label", "a,b"], () =>
      json({ hits: [] }),
    );
    expect(body(result.calls[0])).toEqual({ query: "q", labels: ["a", "b"] });

    for (const flag of ["--cursor", "--mailbox"]) {
      const rejected = await run(["mail", "search", flag, "x"], () => json({}));
      expect(rejected.code).toBe(2);
      expect(rejected.calls).toHaveLength(0);
    }
  });
});

describe("pending confirmation (CA6)", () => {
  const pending = { status: "pending_confirmation", pending: { id: "act-123" } };

  it("exits 6 and explains how to approve", async () => {
    const result = await run(["mail", "send", "--to", "a@example.com"], () => json(pending, 202));

    expect(result.code).toBe(6);
    expect(JSON.parse(result.stdout)).toEqual(pending);
    expect(result.stderr).toContain("act-123");
    expect(result.stderr).toContain("helix action approve act-123");
  });

  it("reports the pending action as JSON with --output json", async () => {
    const result = await run(["mail", "send", "--output", "json"], () => json(pending, 202));

    expect(result.code).toBe(6);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: "pending_confirmation",
        actionId: "act-123",
        approveCommand: "helix action approve act-123",
      },
    });
  });
});

describe("timeouts and retries (CA8)", () => {
  const hang = ({ init }: Call) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason as Error);
      });
    });

  it("applies --timeout per request and exits 7 when it elapses", async () => {
    const result = await run(["action", "status", "act-1", "--timeout", "0.05"], hang);

    expect(result.code).toBe(7);
    expect(result.stderr).toContain("timed out after 0.05s");
    // GET is idempotent, so the timeout is retried before giving up.
    expect(result.calls).toHaveLength(4);
  });

  it("reads HELIX_TIMEOUT and rejects invalid values as usage errors", async () => {
    const timedOut = await run(["action", "approve", "act-1"], hang, {
      env: { ...env, HELIX_TIMEOUT: "0.02" },
    });
    expect(timedOut.code).toBe(7);
    // Approving is not idempotent: no retry after a network failure.
    expect(timedOut.calls).toHaveLength(1);

    const invalid = await run(["action", "status", "act-1", "--timeout", "soon"], () => json({}));
    expect(invalid.code).toBe(2);
    expect(invalid.calls).toHaveLength(0);
  });

  it("retries 429 honouring Retry-After, then exits 5 after three retries", async () => {
    const recovered = await run(["mail", "send"], (_call, index) =>
      index < 2 ? json({ error: { code: "rate_limited" } }, 429, { "retry-after": "3" }) : json({}),
    );
    expect(recovered.code).toBe(0);
    expect(recovered.sleeps).toEqual([3000, 3000]);

    const limited = await run(["mail", "send"], () =>
      json({ error: { code: "rate_limited" } }, 429, { "retry-after": "1" }),
    );
    expect(limited.code).toBe(5);
    expect(limited.calls).toHaveLength(4);
  });

  it("retries 503 and network errors with the same Idempotency-Key (CA9)", async () => {
    const result = await run(["mail", "send", "--to", "a@example.com"], (_call, index) => {
      if (index === 0) throw new TypeError("fetch failed");
      return index === 1 ? json({}, 503) : json({ sent: true });
    });

    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(3);
    const keys = result.calls.map((call) => header(call, "idempotency-key"));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(new Set(keys).size).toBe(1);
    expect(result.sleeps).toHaveLength(2);
  });
});

describe("idempotency keys (CA9)", () => {
  it("generates a fresh key per invocation and honours --idempotency-key", async () => {
    let next = 0;
    const dependencies = { randomUUID: () => `generated-key-${String((next += 1))}` };
    const first = await run(["mail", "send"], () => json({}), { dependencies });
    const second = await run(["mail", "send"], () => json({}), { dependencies });
    const override = await run(["mail", "send", "--idempotency-key", "retry-key-1"], () =>
      json({}),
    );

    expect(header(first.calls[0], "idempotency-key")).toBe("generated-key-1");
    expect(header(second.calls[0], "idempotency-key")).toBe("generated-key-2");
    expect(header(override.calls[0], "idempotency-key")).toBe("retry-key-1");

    const invalid = await run(["mail", "send", "--idempotency-key", "short"], () => json({}));
    expect(invalid.code).toBe(2);
  });

  it("keeps restore's own --idempotency-key flag in the request body", async () => {
    const result = await run(
      [
        "restore",
        ...["--from", "backup-1", "--target-db", "db", "--target-bucket", "bucket"],
        ...["--idempotency-key", "restore-key-1"],
      ],
      () => json({ ok: true }),
    );

    expect(result.code).toBe(0);
    expect(body(result.calls[0])).toMatchObject({ idempotencyKey: "restore-key-1" });
  });
});

describe("exit codes and error output (CA14)", () => {
  it.each([
    [401, 3],
    [403, 3],
    [404, 4],
    [400, 1],
    [500, 1],
  ])("maps HTTP %i to exit code %i", async (status, exitCode) => {
    const result = await run(["action", "approve", "act-1"], () =>
      json({ error: { code: "x", message: "nope" } }, status),
    );
    expect(result.code).toBe(exitCode);
  });

  it("fails fast instead of reading JSON from an interactive terminal", async () => {
    const tty = Object.assign(new Readable({ read() {} }), { isTTY: true });
    const result = await run(["tool", "call", "mail.send", "--json"], () => json({}), {
      stdin: tty,
    });

    expect(result.code).toBe(2);
    expect(result.calls).toHaveLength(0);
    expect(result.stderr).toContain("stdin is a terminal");
  });

  it("names the problem with invalid stdin JSON as a usage error", async () => {
    const result = await run(["tool", "call", "mail.send", "--json"], () => json({}), {
      stdin: Readable.from(['{"to": ']),
    });

    expect(result.code).toBe(2);
    expect(result.calls).toHaveLength(0);
    expect(result.stderr).toMatch(/^Invalid JSON in stdin: /u);
  });

  it("writes errors to stderr as JSON with --output json", async () => {
    const http = await run(["action", "status", "act-1", "--output", "json"], () =>
      json({ error: { code: "not_found", message: "Unknown action", traceId: "t-1" } }, 404),
    );
    expect(http.code).toBe(4);
    expect(http.stdout).toBe("");
    expect(JSON.parse(http.stderr)).toEqual({
      error: { status: 404, code: "not_found", message: "Unknown action", traceId: "t-1" },
    });

    const usage = await run(["--output", "json", "mail", "nonsense"], () => json({}));
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.stderr)).toMatchObject({ error: { code: "usage_error" } });
  });

  it("documents exit codes in --help", async () => {
    const result = await run(["--help"], () => json({}));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Exit codes:");
    expect(result.stdout).toContain("6  Pending confirmation");
  });
});

describe("subcommand help (CA15)", () => {
  it("prints scoped help to stdout and exits 0", async () => {
    const scope = await run(["mail", "--help"], () => json({}));
    expect(scope.code).toBe(0);
    expect(scope.stdout).toContain("helix mail send");
    expect(scope.stdout).toContain("helix mail list [--folder");
    expect(scope.stdout).not.toContain("helix chat send");
    expect(scope.stderr).toBe("");

    const action = await run(["mail", "send", "-h"], () => json({}));
    expect(action.code).toBe(0);
    expect(action.stdout).toContain("helix mail send [--to <email>]");
    expect(action.stdout).not.toContain("helix mail reply");
    expect(action.stdout).toContain("Exit codes:");
  });
});

describe("helix mail forward", () => {
  it("calls mail.forward with the schema's field names", async () => {
    const { parseCliArgs } = await import("./parser.js");
    expect(
      parseCliArgs([
        "mail",
        "forward",
        "--thread-id",
        "thread-1",
        "--message-id",
        "message-1",
        "--to",
        "ada@example.com",
        "--body",
        "FYI",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "mail.forward",
      json: {
        source: "inline",
        value:
          '{"threadId":"thread-1","messageId":"message-1","to":["ada@example.com"],"bodyText":"FYI"}',
      },
    });
  });
});
