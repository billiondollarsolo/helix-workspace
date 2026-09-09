import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type FetchLike } from "./runner.js";

const bytes = "hello!";
const sha256 = createHash("sha256").update(bytes).digest("hex");
const prepared = {
  objectId: "11111111-1111-4111-8111-111111111111",
  byteSize: 6,
  sha256,
  uploadUrl: "https://storage.example/upload?signature=private",
  uploadHeaders: { "x-amz-meta-source": "helix" },
};
const env = { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "agent-key" };
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
function capture() {
  let output = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, done) {
        output += String(chunk);
        done();
      },
    }),
    text: () => output,
  };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "helix-cli-upload-"));
  directories.push(directory);
  const path = join(directory, "hello.txt");
  await writeFile(path, bytes);
  const stdout = capture();
  const stderr = capture();
  return {
    path,
    directory,
    stdout,
    stderr,
    io: { stdin: Readable.from([]), stdout: stdout.stream, stderr: stderr.stream },
  };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe("CLI local file upload", () => {
  it("hashes, transfers bytes without API credentials, and finalizes the reserved object", async () => {
    const f = await fixture();
    const calls: string[] = [];
    const fetcher: FetchLike = async (url, init) => {
      calls.push(url);
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (url.includes("storage.example")) {
        const headers = new Headers(init.headers);
        expect(headers.has("authorization")).toBe(false);
        expect(headers.get("x-amz-meta-source")).toBe("helix");
        expect(await (init.body as Blob).text()).toBe(bytes);
        return new Response(null, { status: 200 });
      }
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer agent-key");
      const body = JSON.parse(typeof init.body === "string" ? init.body : "");
      expect(body).toMatchObject({ byteSize: 6, sha256 });
      expect(JSON.stringify(body)).not.toContain(f.path);
      if (url.endsWith("drive.upload")) return json(prepared);
      expect(body).toMatchObject({
        objectId: prepared.objectId,
        idempotencyKey: `upload:${prepared.objectId}`,
      });
      return json({ status: "active", objectId: prepared.objectId });
    };
    expect(await runCli(["drive", "upload", f.path], env, f.io, fetcher)).toBe(0);
    expect(calls).toHaveLength(3);
    expect(f.stderr.text()).toBe("");
    expect(JSON.parse(f.stdout.text())).toMatchObject({ status: "active" });
  });
  it("uploads bounded multipart slices and submits the returned ETags", async () => {
    const f = await fixture();
    const chunks: string[] = [];
    const fetcher: FetchLike = async (url, init) => {
      if (url.endsWith("drive.upload"))
        return json({
          ...prepared,
          multipart: {
            uploadId: "multipart-1",
            partSize: 3,
            partCount: 2,
            partUrls: ["https://storage.example/1", "https://storage.example/2"],
          },
        });
      if (url.includes("storage.example")) {
        chunks.push(await (init.body as Blob).text());
        expect(new Headers(init.headers).has("authorization")).toBe(false);
        return new Response(null, { headers: { etag: `etag-${String(chunks.length)}` } });
      }
      expect(url).toContain("drive.upload.complete");
      expect(JSON.parse(typeof init.body === "string" ? init.body : "")).toMatchObject({
        parts: [
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 2, etag: "etag-2" },
        ],
        sha256,
        byteSize: 6,
      });
      return json({ status: "active" });
    };
    expect(await runCli(["drive", "upload", f.path], env, f.io, fetcher)).toBe(0);
    expect(chunks).toEqual(["hel", "lo!"]);
  });
  it("preserves the reservation on failure and resumes without creating another object", async () => {
    const f = await fixture();
    expect(
      await runCli(["drive", "upload", f.path], env, f.io, async (url) =>
        url.endsWith("drive.upload") ? json(prepared) : new Response(null, { status: 503 }),
      ),
    ).toBe(1);
    const resumeFile = join(f.directory, "prepared.json");
    await writeFile(resumeFile, f.stdout.text());
    const stdout = capture();
    const stderr = capture();
    const calls: string[] = [];
    expect(
      await runCli(
        ["drive", "upload", f.path, "--prepared", resumeFile],
        env,
        { ...f.io, stdout: stdout.stream, stderr: stderr.stream },
        async (url) => {
          calls.push(url);
          return url.includes("storage.example") ? new Response(null) : json({ status: "active" });
        },
      ),
    ).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls.some((url) => url.endsWith("drive.upload"))).toBe(false);
  });
  it("stops for approval before transferring any bytes", async () => {
    const f = await fixture();
    let calls = 0;
    expect(
      await runCli(["drive", "upload", f.path], env, f.io, async () => {
        calls += 1;
        return json({ status: "pending_confirmation", pending: { id: "approval-1" } });
      }),
    ).toBe(2);
    expect(calls).toBe(1);
    expect(f.stderr.text()).toContain("awaits approval");
  });
  it.each([
    { sha256: "a".repeat(64) },
    { uploadUrl: "http://storage.example/plaintext" },
    { uploadHeaders: { authorization: "secret" } },
    { multipart: { uploadId: "bad", partSize: 3, partCount: 3, partUrls: [] } },
  ])("rejects a mismatched or unsafe upload plan %j", async (patch) => {
    const f = await fixture();
    let calls = 0;
    expect(
      await runCli(["drive", "upload", f.path], env, f.io, async () => {
        calls += 1;
        return json({ ...prepared, ...patch });
      }),
    ).toBe(1);
    expect(calls).toBe(1);
  });
});
