#!/usr/bin/env node
/**
 * Helix Drive sync — one-command setup (wraps rclone 1.66+).
 *
 * Users should not need rclone knowledge. This script asks a few questions,
 * writes a dedicated rclone config (~/.helix/drive-sync/rclone.conf, mode 0600),
 * checks read/write/delete access, and starts either:
 *   - mirror folder (two-way sync, rclone bisync), or
 *   - virtual drive mount
 *
 * Usage:
 *   node scripts/helix-drive-sync-setup.mjs [--insecure] [--resync] [--help]
 *   pnpm helix:drive-sync
 *
 * Non-interactive (automation / tests):
 *   HELIX_SYNC_URL=https://helix.example HELIX_SYNC_USER=you@co.com \
 *   HELIX_SYNC_PASSWORD=app-password HELIX_SYNC_MODE=mirror \
 *   HELIX_SYNC_PATH=$HOME/HelixDrive HELIX_SYNC_YES=1 \
 *   node scripts/helix-drive-sync-setup.mjs
 *
 * Re-runs never resync automatically; see --help.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildMirrorCommand,
  buildMirrorResyncCommand,
  buildMountCommand,
  buildRcloneConfig,
  canaryName,
  checkRcloneVersion,
  CONFIG_VERSION,
  decideMirrorRun,
  defaultLocalPath,
  helixHomeDir,
  HELP_TEXT,
  httpStatusFromRcloneOutput,
  normalizeDavUrl,
  parseArgs,
  parseMode,
  probeFailureMessage,
  rcloneInstallHint,
  REMOTE_NAME,
  resolveLocalPath,
  resolveMaxSize,
} from "./helix-drive-sync-lib.mjs";

export * from "./helix-drive-sync-lib.mjs";

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function defaultWhich() {
  const cmd = platform() === "win32" ? "where" : "which";
  return spawnSync(cmd, ["rclone"], { encoding: "utf8" }).status === 0;
}

/** Runs rclone without a shell. `stdinText` feeds secrets so they never reach argv. */
function defaultRunRclone(args, options = {}) {
  const result = spawnSync("rclone", args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    ...(options.stdinText === undefined ? {} : { input: options.stdinText }),
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/** Readline prompter whose output can be muted so typed secrets are not echoed. */
export function createPrompter({ input: source = input, output: sink = output } = {}) {
  let muted = false;
  const filtered = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) sink.write(chunk, encoding);
      callback();
    },
  });
  const rl = readline.createInterface({
    input: source,
    output: filtered,
    terminal: Boolean(source.isTTY),
  });
  return {
    question: (label) => rl.question(label),
    async secret(label) {
      sink.write(label);
      muted = true;
      try {
        return await rl.question("");
      } finally {
        muted = false;
        sink.write("\n");
      }
    },
    close: () => rl.close(),
  };
}

const silentPrompter = { question: async () => "", secret: async () => "", close: () => {} };

async function ask(prompter, label, { defaultValue, secret } = {}) {
  const suffix = defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]` : "";
  const text = `${label}${suffix}: `;
  const answer = secret ? await prompter.secret(text) : await prompter.question(text);
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : (defaultValue ?? "");
}

function obscurePassword(runRclone, plain) {
  // `rclone obscure -` reads the first stdin line, keeping the password out of argv / ps.
  const result = runRclone(["obscure", "-"], { stdinText: `${plain}\n` });
  const obscured = result.stdout.trim().split(/\r?\n/u)[0]?.trim() ?? "";
  if (result.status !== 0 || obscured === "") {
    throw new Error(`Could not obscure the password with rclone: ${result.stderr || result.error}`);
  }
  return obscured;
}

function probeError(result, operation) {
  const status = httpStatusFromRcloneOutput(`${result.stderr}\n${result.stdout}`);
  const detail = (result.stderr || result.stdout).trim();
  return new Error(`${probeFailureMessage(status, operation)}${detail ? `\n\n${detail}` : ""}`);
}

/** Verify list, create, and delete with a throwaway config before it replaces the working one. */
function probeConnection(runRclone, configPath, log) {
  const remote = (suffix = "") => `${REMOTE_NAME}:${suffix}`;
  log("Testing connection…");
  const list = runRclone(["lsd", remote(), "--config", configPath]);
  if (list.status !== 0) throw probeError(list, "list");
  log("Checking upload and delete permissions…");
  // MKCOL + DELETE exercise drive.write and drive.delete without an upload
  // that would sit in the malware-scan queue.
  const canary = remote(canaryName());
  const created = runRclone(["mkdir", canary, "--config", configPath]);
  if (created.status !== 0) throw probeError(created, "write");
  const removed = runRclone(["rmdir", canary, "--config", configPath]);
  if (removed.status !== 0) {
    const error = probeError(removed, "delete");
    error.message += `\n\nRemove the test folder "${canary.slice(REMOTE_NAME.length + 1)}" from Helix Drive.`;
    throw error;
  }
}

function readPreviousConfig(homeDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function hasBisyncBaseline(workdir) {
  try {
    return readdirSync(workdir).some((name) => name.endsWith(".lst"));
  } catch {
    return false;
  }
}

function isNonEmptyDir(dir) {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function writeHelpers({ homeDir, mode, localPath, commandOptions, os }) {
  const isWin = os === "win32";
  const { configPath } = commandOptions;
  if (mode === "mirror") {
    const { args } = buildMirrorCommand(localPath, commandOptions);
    if (isWin) {
      writeFileSync(
        join(homeDir, "sync-now.cmd"),
        `@echo off\r\nrclone ${args.map(cmdEscapeWin).join(" ")}\r\n`,
      );
    } else {
      writeShellHelper(
        join(homeDir, "sync-now.sh"),
        `#!/usr/bin/env bash\nset -euo pipefail\nexec rclone ${args.map(shellQuote).join(" ")}\n`,
      );
    }
  } else {
    const { args } = buildMountCommand(localPath, { ...commandOptions, os });
    if (isWin) {
      writeFileSync(
        join(homeDir, "mount.cmd"),
        `@echo off\r\necho Mounting Helix Drive to ${localPath} ...\r\nrclone ${args.map(cmdEscapeWin).join(" ")}\r\n`,
      );
    } else {
      writeShellHelper(
        join(homeDir, "mount.sh"),
        `#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p ${shellQuote(localPath)}\necho "Mounting Helix Drive at ${localPath} (Ctrl+C to stop)..."\nexec rclone ${args.map(shellQuote).join(" ")}\n`,
      );
    }
  }
  if (isWin) {
    writeFileSync(
      join(homeDir, "status.cmd"),
      `@echo off\r\necho Remote:\r\nrclone lsd ${REMOTE_NAME}: --config ${cmdEscapeWin(configPath)}\r\n`,
    );
  } else {
    writeShellHelper(
      join(homeDir, "status.sh"),
      `#!/usr/bin/env bash\nset -euo pipefail\necho "Remote ${REMOTE_NAME}:"\nrclone lsd ${shellQuote(`${REMOTE_NAME}:`)} --config ${shellQuote(configPath)} || true\n`,
    );
  }
}

function writeShellHelper(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function shellQuote(s) {
  return `'${String(s).replace(/'/gu, `'\\''`)}'`;
}

function cmdEscapeWin(s) {
  if (/[\s"]/u.test(s)) {
    return `"${String(s).replace(/"/gu, '""')}"`;
  }
  return String(s);
}

function ensureDir(path) {
  if (/^[A-Za-z]:\\?$/u.test(path)) return; // Windows drive letter — rclone creates it
  mkdirSync(path, { recursive: true });
}

async function confirm(prompter, interactive, label) {
  if (!interactive) return false;
  return (await ask(prompter, `${label} (y/N)`, { defaultValue: "n" }))
    .toLowerCase()
    .startsWith("y");
}

export async function runSetup(options = {}) {
  const env = options.env ?? process.env;
  const flags = options.flags ?? { help: false, insecure: false, resync: false };
  const interactive = options.interactive ?? env.HELIX_SYNC_YES !== "1";
  const log = options.log ?? ((msg) => output.write(`${msg}\n`));
  const runRclone = options.runRclone ?? defaultRunRclone;
  const os = options.os ?? platform();
  const homeDir = options.homeDir ?? helixHomeDir();

  log("");
  log("  Helix Drive Sync setup");
  log("  ──────────────────────");
  log("  Connects this computer to your Helix server (secure WebDAV).");
  log("  You need an app password from your Helix admin (Desktop sync preset), not your login.");
  log("");

  if (!(options.which ?? defaultWhich)()) {
    log("rclone is required (open source). Install it, then re-run this script.\n");
    log(rcloneInstallHint(os));
    return { ok: false, reason: "rclone_missing" };
  }
  const version = checkRcloneVersion(runRclone(["version"]).stdout, os);
  if (!version.ok) {
    log(version.message);
    return { ok: false, reason: "rclone_too_old" };
  }

  const prompter = options.prompter ?? (interactive ? createPrompter() : silentPrompter);
  try {
    const urlRaw =
      env.HELIX_SYNC_URL ??
      (await ask(prompter, "Helix server URL (e.g. https://helix.company.com)"));
    const url = normalizeDavUrl(urlRaw, {
      allowInsecure: flags.insecure || env.HELIX_SYNC_INSECURE === "1",
    });
    if (url.startsWith("http://")) log("  Warning: plain http:// — use only for local testing.");

    const user = (env.HELIX_SYNC_USER ?? (await ask(prompter, "Your Helix email"))).trim();
    if (!user) throw new Error("Email is required.");

    const password =
      env.HELIX_SYNC_PASSWORD ??
      (await ask(prompter, "App password (input hidden)", { secret: true }));
    if (!password) {
      throw new Error("App password is required. Ask your Helix admin to issue one.");
    }

    log("");
    log("  How should files appear on this computer?");
    log("    1) Mirror folder  — a normal folder that stays in sync (recommended)");
    log("    2) Virtual drive  — mount Helix like a network drive");
    log("");
    const mode = parseMode(
      env.HELIX_SYNC_MODE ?? (await ask(prompter, "Choose mode", { defaultValue: "1" })),
    );
    const localRaw =
      env.HELIX_SYNC_PATH ??
      (await ask(prompter, mode === "mirror" ? "Local folder path" : "Mount path / drive letter", {
        defaultValue: defaultLocalPath(mode, options.home, os),
      }));
    const localPath = resolveLocalPath(localRaw, {
      mode,
      os,
      repoDir: options.repoDir ?? REPO_DIR,
      ...(options.home === undefined ? {} : { home: options.home }),
    });
    const maxSize = resolveMaxSize(env.HELIX_SYNC_MAX_SIZE);

    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    const configPath = join(homeDir, "rclone.conf");
    const candidatePath = join(homeDir, "rclone.conf.new");
    const workdir = join(homeDir, "bisync");
    const commandOptions = { configPath, workdir, maxSize };

    log("");
    log("Configuring connection…");
    const obscuredPass = obscurePassword(runRclone, password);
    writeFileSync(candidatePath, buildRcloneConfig({ url, user, obscuredPass }), { mode: 0o600 });
    try {
      probeConnection(runRclone, candidatePath, log);
    } catch (error) {
      rmSync(candidatePath, { force: true });
      throw error;
    }
    // Swap in only after the new remote proved it can list, create, and delete.
    renameSync(candidatePath, configPath);
    chmodSync(configPath, 0o600);

    const previous = readPreviousConfig(homeDir);
    const current = { mode, url, user, localPath };
    const saveConfig = (extra = {}) =>
      writeFileSync(
        join(homeDir, "config.json"),
        `${JSON.stringify({ version: CONFIG_VERSION, remoteName: REMOTE_NAME, ...current, maxSize, configPath, workdir, updatedAt: new Date().toISOString(), ...extra }, null, 2)}\n`,
      );
    writeHelpers({ homeDir, mode, localPath, commandOptions, os });

    if (mode === "mirror") {
      ensureDir(localPath);
      const decision = decideMirrorRun({
        previous,
        current,
        hasBaseline: hasBisyncBaseline(workdir),
        localNonEmpty: isNonEmptyDir(localPath),
        forceResync: flags.resync || env.HELIX_SYNC_RESYNC === "1",
      });
      if (decision.action === "resync") {
        if (decision.warnNonEmpty) {
          log("");
          log(`  Warning: ${localPath} is not empty. A resync merges it with Helix Drive:`);
          log("  local files are uploaded and files missing on either side are copied back.");
        }
        if (decision.confirm === "explicit") {
          log("");
          log(
            decision.reason === "baseline_missing"
              ? "  The previous sync state for this folder is missing."
              : "  This changes the server, account, or folder of an existing sync.",
          );
          log("  A resync can bring back files you deleted on one side since the last sync.");
          if (!(await confirm(prompter, interactive, "Rebuild the sync baseline now?"))) {
            throw new Error(
              "Not resyncing. Re-run with --resync (or HELIX_SYNC_RESYNC=1) to rebuild the baseline.",
            );
          }
        } else if (decision.confirm === "warn" && interactive) {
          if (!(await confirm(prompter, interactive, "Continue?"))) {
            throw new Error("Cancelled. Pick an empty folder or move its files first.");
          }
        }
      }
      log("");
      log(
        decision.action === "resync"
          ? `First sync into ${localPath} (this may take a while)…`
          : `Syncing ${localPath} with Helix Drive…`,
      );
      const command =
        decision.action === "resync"
          ? buildMirrorResyncCommand(localPath, commandOptions)
          : buildMirrorCommand(localPath, commandOptions);
      const run = runRclone(command.args, { inherit: true });
      if (run.status !== 0) {
        throw new Error(
          decision.action === "resync"
            ? "Initial sync failed. Fix the error above and re-run this script."
            : "Sync failed. Fix the error above and re-run. If rclone reports missing prior listings, re-run with --resync.",
        );
      }
      saveConfig({
        baselineAt: decision.action === "resync" ? new Date().toISOString() : previous?.baselineAt,
      });
      log("");
      log("  ✓ Helix Drive is set up.");
      log(`  Folder:  ${localPath}`);
      log(`  Later:   ${join(homeDir, os === "win32" ? "sync-now.cmd" : "sync-now.sh")}`);
      log(`  Files larger than ${maxSize} are skipped (server upload limit).`);
      log("  Tip: schedule that helper to run every few minutes if you want continuous sync.");
      log("");
      return { ok: true, mode, localPath, homeDir, url, action: decision.action };
    }

    if (os !== "win32") ensureDir(localPath);
    saveConfig();
    log("");
    log("  ✓ Helix Drive is configured.");
    log(`  Start mount:  ${join(homeDir, os === "win32" ? "mount.cmd" : "mount.sh")}`);
    log("  Leave that window open while you work; Ctrl+C unmounts.");
    if (os === "darwin") log("  Note: macOS may need macFUSE or FUSE-T installed for mount mode.");
    if (os === "win32") {
      log("  Note: Windows needs WinFsp installed for mount mode (https://winfsp.dev/).");
    }
    const startNow =
      env.HELIX_SYNC_START_MOUNT === "1" ||
      (await confirm(prompter, interactive, "Start mount now?"));
    if (startNow) {
      const mount = runRclone(buildMountCommand(localPath, { ...commandOptions, os }).args, {
        inherit: true,
      });
      if (mount.status !== 0) log("  Mount exited with an error; see the output above.");
    }
    log("");
    return { ok: true, mode, localPath, homeDir, url, action: "mount" };
  } finally {
    prompter.close?.();
  }
}

async function main(argv) {
  try {
    const flags = parseArgs(argv);
    if (flags.help) {
      output.write(HELP_TEXT);
      return;
    }
    const result = await runSetup({ flags });
    if (!result.ok) {
      process.exitCode = result.reason === "rclone_missing" ? 2 : 1;
    }
  } catch (error) {
    output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  await main(process.argv.slice(2));
}
