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

/** Runs the CLI and returns the JSON body of the one tool call it made. */
async function toolCallBody(
  args: readonly string[],
  stdinText = "",
): Promise<{ readonly url: string; readonly body: unknown; readonly code: number }> {
  const requests: { url: string; body: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, body: init.body as string });
    return Response.json({ ok: true });
  };
  const stdin = Object.assign(Readable.from(stdinText === "" ? [] : [stdinText]), {
    isTTY: false,
  });
  const stderr = new CaptureStream();
  const code = await runCli(
    args,
    { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
    { stdin, stdout: new CaptureStream(), stderr },
    fetchImpl,
  );
  const request = requests[0];
  if (request === undefined) throw new Error(`no request; stderr: ${stderr.output}`);
  return { url: request.url, body: JSON.parse(request.body) as unknown, code };
}

describe("--json combined with flags", () => {
  it("merges flags over inline JSON for mail send, flags winning", async () => {
    const { url, body, code } = await toolCallBody([
      "mail",
      "send",
      "--json",
      '{"to":["old@example.com"],"subject":"Draft","bodyText":"Body from JSON","bodyHtml":"<p>Hi</p>"}',
      "--to",
      "ada@example.com",
      "--subject",
      "Final",
    ]);
    expect(code).toBe(0);
    expect(url).toBe("https://helix.example/v1/api/tools/mail.send");
    expect(body).toEqual({
      to: ["ada@example.com"],
      subject: "Final",
      bodyText: "Body from JSON",
      bodyHtml: "<p>Hi</p>",
    });
  });

  it("accepts flags before --json and JSON from stdin", async () => {
    const { body } = await toolCallBody(
      ["mail", "list", "--limit", "5", "--json"],
      '{"folder":"sent","limit":50}',
    );
    expect(body).toEqual({ folder: "sent", limit: 5 });
  });

  it("merges for other mail wrappers too: reply, label, star and vacation", () => {
    expect(
      parseCliArgs([
        "mail",
        "reply",
        "--thread-id",
        "thread-1",
        "--json",
        '{"to":["ada@example.com"],"bodyText":"Thanks"}',
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "mail.reply",
      json: {
        source: "inline",
        value: '{"to":["ada@example.com"],"bodyText":"Thanks"}',
        overrides: { threadId: "thread-1" },
      },
    });
    expect(
      parseCliArgs(["mail", "star", "--json", '{"threadId":"t1"}', "--unstarred"]),
    ).toMatchObject({ json: { overrides: { starred: false } } });
    expect(
      parseCliArgs(["mail", "vacation-set", "--enabled", "--json", '{"subject":"Away"}']),
    ).toMatchObject({ json: { value: '{"subject":"Away"}', overrides: { enabled: true } } });
    expect(
      parseCliArgs(["mail", "labels", "--json", "{}", "--mailbox-actor-id", "m1"]),
    ).toMatchObject({ toolId: "mail.labels.list", json: { overrides: { mailboxActorId: "m1" } } });
  });

  it("keeps --json alone and flags alone as before", () => {
    expect(parseCliArgs(["mail", "send", "--json", '{"to":["ada@example.com"]}'])).toEqual({
      kind: "tool-call",
      toolId: "mail.send",
      json: { source: "inline", value: '{"to":["ada@example.com"]}' },
    });
    expect(parseCliArgs(["mail", "archive", "--thread-id", "t1"])).toEqual({
      kind: "tool-call",
      toolId: "mail.archive",
      json: { source: "inline", value: '{"threadId":"t1"}' },
    });
  });

  it("lets --json supply fields a command otherwise requires as flags", () => {
    expect(
      parseCliArgs(["mail", "label-create", "--json", '{"name":"Reports"}', "--color", "blue"]),
    ).toMatchObject({
      toolId: "mail.label.create",
      json: { value: '{"name":"Reports"}', overrides: { color: "blue" } },
    });
    expect(() => parseCliArgs(["mail", "label-create", "--color", "blue"])).toThrow(CliUsageError);
  });

  it("rejects a repeated --json and non-object JSON combined with flags", async () => {
    expect(() =>
      parseCliArgs(["mail", "send", "--json", "{}", "--subject", "x", "--json", "{}"]),
    ).toThrow("Pass --json at most once.");
    const stderr = new CaptureStream();
    const code = await runCli(
      ["mail", "send", "--json", '["not","an","object"]', "--subject", "x"],
      { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
      { stdin: Readable.from([]), stdout: new CaptureStream(), stderr },
      async () => {
        throw new Error("must not send");
      },
    );
    expect(code).toBe(2);
    expect(stderr.output).toContain("--json must be a JSON object when combined with flags");
  });
});
