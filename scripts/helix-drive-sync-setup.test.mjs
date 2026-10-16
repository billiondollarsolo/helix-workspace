import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMirrorCommand,
  buildMirrorResyncCommand,
  buildMountCommand,
  buildRcloneConfig,
  checkRcloneVersion,
  createPrompter,
  decideMirrorRun,
  defaultLocalPath,
  helixHomeDir,
  HELP_TEXT,
  httpStatusFromRcloneOutput,
  normalizeDavUrl,
  parseArgs,
  parseMode,
  parseRcloneVersion,
  probeFailureMessage,
  REMOTE_NAME,
  resolveLocalPath,
  resolveMaxSize,
  runSetup,
} from "./helix-drive-sync-setup.mjs";

describe("helix-drive-sync-setup helpers", () => {
  it("normalizes Helix URLs to the versioned WebDAV files root", () => {
    const root = "https://helix.example.com/v1/dav/files/";
    expect(normalizeDavUrl("https://helix.example.com")).toBe(root);
    expect(normalizeDavUrl("https://helix.example.com/")).toBe(root);
    expect(normalizeDavUrl("helix.example.com")).toBe(root);
    expect(normalizeDavUrl("https://helix.example.com/v1")).toBe(root);
    expect(normalizeDavUrl("https://helix.example.com/v1/dav/files")).toBe(root);
    expect(normalizeDavUrl("https://helix.example.com/v1/dav/files/")).toBe(root);
    // Legacy unversioned input is upgraded to /v1.
    expect(normalizeDavUrl("https://helix.example.com/dav/files")).toBe(root);
    expect(normalizeDavUrl("https://helix.example.com/dav/files/")).toBe(root);
    expect(normalizeDavUrl("https://helix.example.com/dav/files/Projects/")).toBe(
      "https://helix.example.com/v1/dav/files/Projects/",
    );
    expect(normalizeDavUrl("https://example.com/helix")).toBe(
      "https://example.com/helix/v1/dav/files/",
    );
    expect(() => normalizeDavUrl("")).toThrow(/required/i);
  });

  it("refuses plain http:// unless insecure mode is requested", () => {
    expect(() => normalizeDavUrl("http://helix.local")).toThrow(/--insecure/);
    expect(normalizeDavUrl("http://helix.local:8080", { allowInsecure: true })).toBe(
      "http://helix.local:8080/v1/dav/files/",
    );
  });

  it("parses mirror vs mount modes from short answers", () => {
    expect(parseMode("1")).toBe("mirror");
    expect(parseMode("mirror")).toBe("mirror");
    expect(parseMode("2")).toBe("mount");
    expect(parseMode("mount")).toBe("mount");
    expect(() => parseMode("nope")).toThrow(/mode/i);
  });

  it("defaults local paths by mode and OS", () => {
    expect(defaultLocalPath("mirror", "/home/u", "linux")).toBe("/home/u/HelixDrive");
    expect(defaultLocalPath("mount", "/home/u", "linux")).toBe("/home/u/HelixMount");
    expect(defaultLocalPath("mount", "C:\\Users\\u", "win32")).toBe("X:");
  });

  it("expands ~, resolves relative paths, and refuses dangerous targets", () => {
    const opts = { home: "/home/u", cwd: "/work", os: "linux", repoDir: "/src/helix" };
    expect(resolveLocalPath("~/HelixDrive", opts)).toBe("/home/u/HelixDrive");
    expect(resolveLocalPath("Drive", opts)).toBe("/work/Drive");
    expect(resolveLocalPath("/data/Helix/", opts)).toBe("/data/Helix");
    expect(() => resolveLocalPath("/", opts)).toThrow(/filesystem root/);
    expect(() => resolveLocalPath("~", opts)).toThrow(/home folder/);
    expect(() => resolveLocalPath("/home/u/", opts)).toThrow(/home folder/);
    expect(() => resolveLocalPath("/src/helix", opts)).toThrow(/repository/);
    expect(() => resolveLocalPath("/src/helix/sync", opts)).toThrow(/repository/);
    expect(resolveLocalPath("/src/helix-sync", opts)).toBe("/src/helix-sync");
    expect(() => resolveLocalPath("C:\\", { ...opts, os: "win32", home: "C:\\Users\\u" })).toThrow(
      /root/,
    );
    expect(resolveLocalPath("x:", { ...opts, os: "win32", mode: "mount" })).toBe("X:");
  });

  it("requires rclone 1.66 or newer", () => {
    expect(parseRcloneVersion("rclone v1.66.0\n- os/version: x")).toEqual({
      major: 1,
      minor: 66,
      patch: 0,
    });
    expect(parseRcloneVersion("rclone v1.68.2-DEV")).toMatchObject({ minor: 68, patch: 2 });
    expect(parseRcloneVersion("not rclone")).toBeNull();
    expect(checkRcloneVersion("rclone v1.66.0").ok).toBe(true);
    expect(checkRcloneVersion("rclone v2.0.0").ok).toBe(true);
    const old = checkRcloneVersion("rclone v1.60.1", "linux");
    expect(old.ok).toBe(false);
    expect(old.message).toMatch(/1\.60\.1 is too old.*1\.66/su);
    expect(old.message).toContain("https://rclone.org/install.sh");
    expect(old.message).not.toContain("apt install");
    expect(checkRcloneVersion("").ok).toBe(false);
  });

  it("validates the max file size override", () => {
    expect(resolveMaxSize(undefined)).toBe("128M");
    expect(resolveMaxSize("1G")).toBe("1G");
    expect(resolveMaxSize("off")).toBe("off");
    expect(() => resolveMaxSize("lots")).toThrow(/HELIX_SYNC_MAX_SIZE/);
  });

  it("writes a dedicated rclone config with the obscured password only", () => {
    const config = buildRcloneConfig({
      url: "https://h.example/v1/dav/files/",
      user: "a@b.com",
      obscuredPass: "obscured",
    });
    expect(config).toContain(`[${REMOTE_NAME}]`);
    expect(config).toContain("type = webdav");
    expect(config).toContain("url = https://h.example/v1/dav/files/");
    expect(config).toContain("user = a@b.com");
    expect(config).toContain("pass = obscured");
    expect(() => buildRcloneConfig({ url: "x", user: "a\nb", obscuredPass: "o" })).toThrow();
  });

  it("builds mirror and mount command shapes with the size cap", () => {
    const opts = { configPath: "/c/rclone.conf", workdir: "/c/bisync", maxSize: "128M" };
    const mirror = buildMirrorCommand("/data/HelixDrive", opts);
    for (const flag of [
      "--checksum",
      "--download-hash",
      "--recover",
      "--max-lock",
      "size,checksum",
      "Move,Copy,DirMove",
    ]) {
      expect(mirror.args).toContain(flag);
    }
    expect(mirror.args.slice(0, 3)).toEqual(["bisync", "/data/HelixDrive", "helix:"]);
    expect(mirror.args).not.toContain("--resync");
    expect(mirror.args.join(" ")).toContain("--max-size 128M");
    expect(mirror.args.join(" ")).toContain("--workdir /c/bisync");
    expect(mirror.args.join(" ")).toContain("--config /c/rclone.conf");
    expect(buildMirrorResyncCommand("/data/HelixDrive", opts).args).toContain("--resync");

    const mount = buildMountCommand("/mnt/helix", { ...opts, os: "linux" });
    expect(mount.args[0]).toBe("mount");
    expect(mount.args.join(" ")).toContain("--vfs-cache-mode full");
    expect(mount.args.join(" ")).toContain("--max-size 128M");
    expect(buildMountCommand("X:", { os: "win32" }).args).toContain("--network-mode");
    expect(buildMirrorCommand("/d", { maxSize: "off" }).args).not.toContain("--max-size");
  });

  it("never resyncs a re-run automatically", () => {
    const current = { mode: "mirror", url: "u", user: "a", localPath: "/d" };
    const base = { current, hasBaseline: true, localNonEmpty: true, forceResync: false };
    expect(decideMirrorRun({ ...base, previous: { ...current, version: 2 } })).toMatchObject({
      action: "resync",
      reason: "comparison_upgrade",
      confirm: "explicit",
    });
    expect(decideMirrorRun({ ...base, previous: { ...current, version: 3 } })).toMatchObject({
      action: "bisync",
    });
    expect(decideMirrorRun({ ...base, previous: null, localNonEmpty: false })).toMatchObject({
      action: "resync",
      reason: "first_setup",
      confirm: "none",
    });
    expect(decideMirrorRun({ ...base, previous: null })).toMatchObject({
      action: "resync",
      confirm: "warn",
      warnNonEmpty: true,
    });
    expect(
      decideMirrorRun({ ...base, previous: { ...current, localPath: "/other" } }),
    ).toMatchObject({ action: "resync", reason: "target_changed", confirm: "explicit" });
    expect(
      decideMirrorRun({ ...base, previous: { ...current, version: 3 }, hasBaseline: false }),
    ).toMatchObject({ action: "resync", reason: "baseline_missing", confirm: "explicit" });
    expect(
      decideMirrorRun({ ...base, previous: { ...current, version: 3 }, forceResync: true }),
    ).toMatchObject({ action: "resync", reason: "forced", confirm: "none" });
  });

  it("maps HTTP failures to actionable messages", () => {
    expect(httpStatusFromRcloneOutput("couldn't list files: 403 Forbidden")).toBe(403);
    expect(httpStatusFromRcloneOutput("Unauthorized: 401")).toBe(401);
    expect(httpStatusFromRcloneOutput("dial tcp: timeout")).toBeNull();
    expect(probeFailureMessage(401)).toMatch(/email or app password/);
    expect(probeFailureMessage(403, "delete")).toMatch(/"drive\.delete" scope.*Desktop sync/su);
    expect(probeFailureMessage(403, "write")).toContain('"drive.write"');
    expect(probeFailureMessage(404)).toContain("/v1/dav/files/");
    expect(probeFailureMessage(426)).toMatch(/HTTPS/);
    expect(probeFailureMessage(429)).toMatch(/HELIX_TRUSTED_PROXIES/);
  });

  it("parses flags and documents them in --help", () => {
    expect(parseArgs([])).toEqual({ help: false, insecure: false, resync: false });
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--insecure", "--resync"])).toMatchObject({ insecure: true, resync: true });
    expect(() => parseArgs(["--nope"])).toThrow(/--help/);
    expect(HELP_TEXT).toContain("HELIX_SYNC_RESYNC");
    expect(HELP_TEXT).toContain("HELIX_SYNC_MAX_SIZE");
  });

  it("does not echo the app password typed at the prompt", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (chunk) => (shown += chunk.toString()));
    const prompter = createPrompter({ input, output });
    const answer = prompter.secret("App password: ");
    input.write("helix_ap_typed\n");
    expect(await answer).toBe("helix_ap_typed");
    prompter.close();
    expect(shown).toContain("App password: ");
    expect(shown).not.toContain("helix_ap_typed");
  });

  it("places helpers under ~/.helix/drive-sync", () => {
    expect(helixHomeDir("/home/sam", "linux")).toBe("/home/sam/.helix/drive-sync");
  });
});

describe("runSetup", () => {
  let root;
  let calls;
  let failures;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "helix-sync-test-"));
    calls = [];
    failures = {};
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const homeDir = () => join(root, ".helix", "drive-sync");
  const env = (extra = {}) => ({
    HELIX_SYNC_URL: "https://helix.example.com",
    HELIX_SYNC_USER: "ada@example.com",
    HELIX_SYNC_PASSWORD: "helix_ap_secret",
    HELIX_SYNC_MODE: "mirror",
    HELIX_SYNC_PATH: join(root, "HelixDrive"),
    HELIX_SYNC_YES: "1",
    ...extra,
  });
  const runRclone = (args, options = {}) => {
    calls.push({ args, stdinText: options.stdinText });
    const verb = args[0];
    if (failures[verb]) return { status: 1, stdout: "", stderr: failures[verb] };
    if (verb === "version") return { status: 0, stdout: "rclone v1.68.1\n", stderr: "" };
    if (verb === "obscure") return { status: 0, stdout: "OBSCURED\n", stderr: "" };
    if (verb === "bisync" && args.includes("--resync")) {
      const workdir = args[args.indexOf("--workdir") + 1];
      mkdirSync(workdir, { recursive: true });
      writeFileSync(join(workdir, "x.path1.lst"), "");
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const setup = (extraEnv, opts = {}) =>
    runSetup({
      env: env(extraEnv),
      runRclone,
      which: () => true,
      homeDir: homeDir(),
      home: root,
      os: "linux",
      log: () => {},
      ...opts,
    });
  const bisyncCalls = () => calls.filter((call) => call.args[0] === "bisync");

  it("keeps the app password out of argv and stores only the obscured form", async () => {
    const result = await setup();
    expect(result).toMatchObject({ ok: true, action: "resync" });
    for (const call of calls) expect(call.args.join(" ")).not.toContain("helix_ap_secret");
    expect(calls.find((call) => call.args[0] === "obscure")).toEqual({
      args: ["obscure", "-"],
      stdinText: "helix_ap_secret\n",
    });
    const conf = join(homeDir(), "rclone.conf");
    expect(readFileSync(conf, "utf8")).toContain("pass = OBSCURED");
    expect(readFileSync(conf, "utf8")).toContain("url = https://helix.example.com/v1/dav/files/");
    expect(statSync(conf).mode & 0o777).toBe(0o600);
  });

  it("probes list, create, and delete before swapping in the config", async () => {
    await setup();
    const verbs = calls.map((call) => call.args[0]);
    expect(verbs.slice(0, 5)).toEqual(["version", "obscure", "lsd", "mkdir", "rmdir"]);
    const mkdir = calls.find((call) => call.args[0] === "mkdir");
    expect(mkdir.args[1]).toMatch(/^helix:\.helix-sync-check-[0-9a-f]{8}$/u);
    expect(mkdir.args.at(-1)).toBe(join(homeDir(), "rclone.conf.new"));
  });

  it("leaves the working config untouched when the new remote fails a probe", async () => {
    await setup();
    const conf = join(homeDir(), "rclone.conf");
    const before = readFileSync(conf, "utf8");
    failures.rmdir = "DELETE failed: 403 Forbidden";
    await expect(setup({ HELIX_SYNC_USER: "other@example.com" })).rejects.toThrow(
      /"drive\.delete" scope/,
    );
    expect(readFileSync(conf, "utf8")).toBe(before);
    expect(() => statSync(join(homeDir(), "rclone.conf.new"))).toThrow();
  });

  it.each(["cancel", "failed-sync"])(
    "preserves the working connection, helper and baseline after %s",
    async (failure) => {
      await setup();
      const paths = ["rclone.conf", "config.json", "sync-now.sh"];
      const before = paths.map((name) => readFileSync(join(homeDir(), name), "utf8"));
      const oldWorkdir = JSON.parse(before[1]).workdir;
      calls = [];
      if (failure === "failed-sync") failures.bisync = "connection interrupted";
      await expect(
        setup({
          HELIX_SYNC_URL: "https://other.example",
          ...(failure === "failed-sync" ? { HELIX_SYNC_RESYNC: "1" } : {}),
        }),
      ).rejects.toThrow();
      expect(paths.map((name) => readFileSync(join(homeDir(), name), "utf8"))).toEqual(before);
      expect(() => statSync(join(homeDir(), "rclone.conf.new"))).toThrow();
      if (failure === "failed-sync") {
        const command = bisyncCalls()[0].args;
        expect(command[command.indexOf("--workdir") + 1]).not.toBe(oldWorkdir);
      } else expect(bisyncCalls()).toHaveLength(0);
    },
  );

  it("runs plain bisync on an unchanged re-run", async () => {
    await setup();
    calls = [];
    const again = await setup();
    expect(again).toMatchObject({ ok: true, action: "bisync" });
    expect(bisyncCalls()).toHaveLength(1);
    expect(bisyncCalls()[0].args).not.toContain("--resync");
  });

  it("refuses to resync a changed re-run without explicit confirmation", async () => {
    await setup();
    calls = [];
    await expect(setup({ HELIX_SYNC_PATH: join(root, "Elsewhere") })).rejects.toThrow(
      /HELIX_SYNC_RESYNC=1/,
    );
    expect(bisyncCalls()).toHaveLength(0);
    const forced = await setup({
      HELIX_SYNC_PATH: join(root, "Elsewhere"),
      HELIX_SYNC_RESYNC: "1",
    });
    expect(forced.action).toBe("resync");
    expect(bisyncCalls()[0].args).toContain("--resync");
  });

  it("stops with an upgrade message when rclone is too old", async () => {
    const logs = [];
    const result = await runSetup({
      env: env(),
      runRclone: (args) =>
        args[0] === "version"
          ? { status: 0, stdout: "rclone v1.60.0", stderr: "" }
          : runRclone(args),
      which: () => true,
      homeDir: homeDir(),
      log: (line) => logs.push(line),
    });
    expect(result).toEqual({ ok: false, reason: "rclone_too_old" });
    expect(logs.join("\n")).toMatch(/1\.66/);
  });
});
