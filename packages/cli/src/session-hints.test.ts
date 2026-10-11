import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
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

/** The server's answer when a delegated token calls a signed-in-session tool. */
function sessionOnly(toolId: string): FetchLike {
  return async () =>
    Response.json(
      {
        error: {
          code: "forbidden",
          message: `Tool ${toolId} requires a signed-in session; delegated OAuth, API-key, and agent credentials cannot use it.`,
        },
      },
      { status: 403 },
    );
}

async function run(args: readonly string[], fetchImpl: FetchLike) {
  const stderr = new CaptureStream();
  const code = await runCli(
    args,
    { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
    { stdin: Readable.from([]), stdout: new CaptureStream(), stderr },
    fetchImpl,
  );
  return { code, stderr: stderr.output };
}

describe("tools that need a signed-in web session", () => {
  it("tells the person where to create an app password instead of a bare 403", async () => {
    const { code, stderr } = await run(
      ["admin", "app-passwords", "create", "--label", "Thunderbird"],
      sessionOnly("app.passwords.create"),
    );
    expect(code).toBe(3);
    expect(stderr).toContain("Helix API request failed (403).");
    expect(stderr).toContain("open Settings → App passwords");
    expect(stderr).toContain("helix account app-passwords");
  });

  it("adds the hint to --output json errors", async () => {
    const { stderr } = await run(
      ["tool", "call", "drive.s3-keys.create", "--json", '{"label":"nas"}', "--output", "json"],
      sessionOnly("drive.s3-keys.create"),
    );
    const parsed = JSON.parse(stderr) as { error: { status: number; hint: string } };
    expect(parsed.error.status).toBe(403);
    expect(parsed.error.hint).toContain("open Settings → S3 access keys");
  });

  it("leaves other permission failures unchanged", async () => {
    const { stderr } = await run(["account", "preferences"], async () =>
      Response.json(
        {
          error: {
            code: "forbidden",
            message: "Actor cannot invoke tool: account.preferences.get",
          },
        },
        { status: 403 },
      ),
    );
    expect(stderr).toBe(
      'Helix API request failed (403). {"error":{"code":"forbidden","message":"Actor cannot invoke tool: account.preferences.get"}}\n',
    );
  });
});
