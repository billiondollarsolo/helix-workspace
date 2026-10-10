import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
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
describe("runCli logout", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const noFetch: FetchLike = async () => {
    throw new Error("logout must not perform a network request");
  };

  it("clears a stored credentials file without calling the API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helix-cli-logout-"));
    tempDirs.push(dir);
    const credentialsFile = join(dir, "credentials.json");
    writeFileSync(credentialsFile, '{"access_token":"token-1"}');

    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    await expect(
      runCli(
        ["logout"],
        { HELIX_CREDENTIALS_FILE: credentialsFile },
        { stdin: Readable.from([]), stdout, stderr },
        noFetch,
      ),
    ).resolves.toBe(0);

    expect(existsSync(credentialsFile)).toBe(false);
    expect(stdout.output).toContain("Cleared stored credentials");
    expect(stderr.output).toBe("");
  });

  it("is idempotent when no credentials file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helix-cli-logout-"));
    tempDirs.push(dir);
    const credentialsFile = join(dir, "credentials.json");

    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    await expect(
      runCli(
        ["logout"],
        { HELIX_CREDENTIALS_FILE: credentialsFile },
        { stdin: Readable.from([]), stdout, stderr },
        noFetch,
      ),
    ).resolves.toBe(0);

    expect(stdout.output).toContain("No stored credentials found");
    expect(stderr.output).toBe("");
  });

  it("warns when HELIX_ACCESS_TOKEN is still set in the shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helix-cli-logout-"));
    tempDirs.push(dir);
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    await expect(
      runCli(
        ["logout"],
        {
          HELIX_CREDENTIALS_FILE: join(dir, "credentials.json"),
          HELIX_ACCESS_TOKEN: "token-1",
        },
        { stdin: Readable.from([]), stdout, stderr },
        noFetch,
      ),
    ).resolves.toBe(0);

    expect(stderr.output).toContain("unset HELIX_ACCESS_TOKEN");
  });
});
