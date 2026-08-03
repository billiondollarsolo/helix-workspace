#!/usr/bin/env node
/**
 * Helix Drive sync — one-command setup (wraps rclone).
 *
 * Users should not need rclone knowledge. This script asks a few questions,
 * configures WebDAV, and starts either:
 *   - mirror folder (two-way sync), or
 *   - virtual drive mount
 *
 * Usage:
 *   node scripts/helix-drive-sync-setup.mjs
 *   pnpm helix:drive-sync
 *
 * Non-interactive (automation / tests):
 *   HELIX_SYNC_URL=https://helix.example HELIX_SYNC_USER=you@co.com \
 *   HELIX_SYNC_PASSWORD=app-password HELIX_SYNC_MODE=mirror \
 *   HELIX_SYNC_PATH=$HOME/HelixDrive HELIX_SYNC_YES=1 \
 *   node scripts/helix-drive-sync-setup.mjs
 *
 * Re-run helpers land in ~/.helix/drive-sync/ (or %USERPROFILE%\.helix\drive-sync).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import * as readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { stdin as input, stdout as output } from "node:process";

export const REMOTE_NAME = "helix";
export const DEFAULT_MIRROR_DIR_NAME = "HelixDrive";

export function helixHomeDir(home = homedir()) {
  return join(home, ".helix", "drive-sync");
}

/** Normalize user-entered server URL to a WebDAV root. */
export function normalizeDavUrl(raw) {
  let s = String(raw ?? "").trim();
  if (!s) throw new Error("Server URL is required.");
  if (!/^https?:\/\//i.test(s)) {
    s = `https://${s}`;
  }
  s = s.replace(/\/+$/u, "");
  // Accept base Helix URL or already-qualified /dav/files
  if (/\/dav\/files$/i.test(s)) {
    return `${s}/`;
  }
  if (/\/dav\/files\//i.test(s)) {
    return s.endsWith("/") ? s : `${s}/`;
  }
  return `${s}/dav/files/`;
}

export function parseMode(raw) {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "1" || v === "mirror" || v === "m" || v === "folder" || v === "sync") {
    return "mirror";
  }
  if (v === "2" || v === "mount" || v === "drive" || v === "virtual") {
    return "mount";
  }
  throw new Error('Mode must be "mirror" or "mount".');
}

export function defaultLocalPath(mode, home = homedir(), os = platform()) {
  if (mode === "mount" && os === "win32") {
    return "X:";
  }
  if (mode === "mount") {
    return join(home, "HelixMount");
  }
  return join(home, DEFAULT_MIRROR_DIR_NAME);
}

export function buildRcloneCreateArgs(input) {
  const { remoteName = REMOTE_NAME, url, user, obscuredPass } = input;
  return [
    "config",
    "create",
    remoteName,
    "webdav",
    `url=${url}`,
    "vendor=other",
    `user=${user}`,
    `pass=${obscuredPass}`,
  ];
}

export function buildMirrorCommand(localPath, remoteName = REMOTE_NAME) {
  return {
    bin: "rclone",
    args: ["bisync", localPath, `${remoteName}:`, "--create-empty-src-dirs", "--resilient"],
  };
}

export function buildMirrorResyncCommand(localPath, remoteName = REMOTE_NAME) {
  return {
    bin: "rclone",
    args: [
      "bisync",
      localPath,
      `${remoteName}:`,
      "--create-empty-src-dirs",
      "--resilient",
      "--resync",
    ],
  };
}

export function buildMountCommand(localPath, remoteName = REMOTE_NAME, os = platform()) {
  const args = [
    "mount",
    `${remoteName}:`,
    localPath,
    "--vfs-cache-mode",
    "full",
    "--dir-cache-time",
    "30s",
  ];
  if (os === "win32") {
    args.push("--network-mode");
  }
  return { bin: "rclone", args };
}

function whichRclone() {
  const cmd = platform() === "win32" ? "where" : "which";
  const result = spawnSync(cmd, ["rclone"], { encoding: "utf8" });
  return result.status === 0;
}

function runRclone(args, options = {}) {
  const result = spawnSync("rclone", args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function obscurePassword(plain) {
  const result = runRclone(["obscure", plain]);
  if (result.status !== 0) {
    throw new Error(
      `Could not obscure password with rclone: ${result.stderr || result.stdout || result.error}`,
    );
  }
  return result.stdout.trim().split(/\r?\n/u)[0]?.trim() ?? "";
}

function printRcloneInstallHelp() {
  const os = platform();
  output.write("\nrclone is required (open source). Install it, then re-run this script.\n\n");
  if (os === "darwin") {
    output.write("  brew install rclone\n\n");
  } else if (os === "win32") {
    output.write("  winget install Rclone.Rclone\n");
    output.write("  # or:  scoop install rclone\n\n");
  } else {
    output.write("  curl https://rclone.org/install.sh | sudo bash\n");
    output.write("  # or:  sudo apt install rclone   /   sudo dnf install rclone\n\n");
  }
  output.write("More: https://rclone.org/install/\n");
}

async function prompt(rl, label, { defaultValue, secret } = {}) {
  const suffix = defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]` : "";
  const hint = secret ? " (won't be stored in git; use an App password)" : "";
  const answer = await rl.question(`${label}${hint}${suffix}: `);
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : (defaultValue ?? "");
}

function writeHelpers({ homeDir, mode, localPath, remoteName }) {
  mkdirSync(homeDir, { recursive: true });
  const meta = {
    remoteName,
    mode,
    localPath,
    davUrlHint: "configured via rclone remote",
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(homeDir, "config.json"), `${JSON.stringify(meta, null, 2)}\n`);

  const isWin = platform() === "win32";
  if (mode === "mirror") {
    const { args } = buildMirrorCommand(localPath, remoteName);
    if (isWin) {
      const bat = `@echo off\r\nrclone ${args.map(cmdEscapeWin).join(" ")}\r\n`;
      writeFileSync(join(homeDir, "sync-now.cmd"), bat);
    } else {
      const sh = `#!/usr/bin/env bash\nset -euo pipefail\nexec rclone ${args.map(shellQuote).join(" ")}\n`;
      const path = join(homeDir, "sync-now.sh");
      writeFileSync(path, sh);
      chmodSync(path, 0o755);
    }
  } else {
    const { args } = buildMountCommand(localPath, remoteName);
    if (isWin) {
      const bat = `@echo off\r\necho Mounting Helix Drive to ${localPath} ...\r\nrclone ${args.map(cmdEscapeWin).join(" ")}\r\n`;
      writeFileSync(join(homeDir, "mount.cmd"), bat);
    } else {
      const sh = `#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p ${shellQuote(localPath)}\necho "Mounting Helix Drive at ${localPath} (Ctrl+C to stop)..."\nexec rclone ${args.map(shellQuote).join(" ")}\n`;
      const path = join(homeDir, "mount.sh");
      writeFileSync(path, sh);
      chmodSync(path, 0o755);
    }
  }

  // Tiny status helper
  if (isWin) {
    writeFileSync(
      join(homeDir, "status.cmd"),
      `@echo off\r\necho Remote:\r\nrclone about ${remoteName}: 2>nul\r\nrclone lsd ${remoteName}:\r\n`,
    );
  } else {
    const statusPath = join(homeDir, "status.sh");
    writeFileSync(
      statusPath,
      `#!/usr/bin/env bash\nset -euo pipefail\necho "Remote ${remoteName}:"\nrclone lsd ${shellQuote(`${remoteName}:`)} || true\n`,
    );
    chmodSync(statusPath, 0o755);
  }
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
  if (path.match(/^[A-Za-z]:\\?$/u) || path.match(/^[A-Za-z]:$/u)) {
    return; // Windows drive letter — rclone creates it
  }
  mkdirSync(path, { recursive: true });
}

export async function runSetup(options = {}) {
  const env = options.env ?? process.env;
  const interactive = options.interactive ?? env.HELIX_SYNC_YES !== "1";
  const log = options.log ?? ((msg) => output.write(`${msg}\n`));

  log("");
  log("  Helix Drive Sync setup");
  log("  ──────────────────────");
  log("  Connects this computer to your Helix server (secure WebDAV).");
  log("  Use an App password from Helix Admin → App passwords (not your login password).");
  log("");

  if (!whichRclone()) {
    printRcloneInstallHelp();
    return { ok: false, reason: "rclone_missing" };
  }

  const rl =
    options.rl ??
    (interactive
      ? readline.createInterface({ input, output })
      : {
          question: async () => "",
          close: () => {},
        });

  try {
    const urlRaw =
      env.HELIX_SYNC_URL ?? (await prompt(rl, "Helix server URL (e.g. https://helix.company.com)"));
    const url = normalizeDavUrl(urlRaw);

    const user = env.HELIX_SYNC_USER ?? (await prompt(rl, "Your Helix email"));
    if (!user.trim()) {
      throw new Error("Email is required.");
    }

    const password =
      env.HELIX_SYNC_PASSWORD ??
      (await prompt(rl, "App password (from Admin → App passwords)", { secret: true }));
    if (!password) {
      throw new Error("App password is required.");
    }

    log("");
    log("  How should files appear on this computer?");
    log("    1) Mirror folder  — a normal folder that stays in sync (recommended)");
    log("    2) Virtual drive  — mount Helix like a network drive");
    log("");
    const modeRaw = env.HELIX_SYNC_MODE ?? (await prompt(rl, "Choose mode", { defaultValue: "1" }));
    const mode = parseMode(modeRaw);

    const defaultPath = defaultLocalPath(mode);
    const localPath =
      env.HELIX_SYNC_PATH ??
      (await prompt(rl, mode === "mirror" ? "Local folder path" : "Mount path / drive letter", {
        defaultValue: defaultPath,
      }));

    log("");
    log("Configuring connection…");
    const obscured = obscurePassword(password);
    // Replace existing remote if present
    runRclone(["config", "delete", REMOTE_NAME]);
    const create = runRclone(
      buildRcloneCreateArgs({ url, user: user.trim(), obscuredPass: obscured }),
    );
    if (create.status !== 0) {
      throw new Error(`rclone config failed: ${create.stderr || create.stdout}`);
    }

    log("Testing connection…");
    const probe = runRclone(["lsd", `${REMOTE_NAME}:`]);
    if (probe.status !== 0) {
      throw new Error(
        `Could not list Helix Drive. Check URL, email, and app password.\n${probe.stderr || probe.stdout}`,
      );
    }

    const homeDir = helixHomeDir();
    writeHelpers({ homeDir, mode, localPath, remoteName: REMOTE_NAME });

    if (mode === "mirror") {
      ensureDir(localPath);
      log("");
      log(`First sync into ${localPath} (this may take a while)…`);
      const resync = runRclone(buildMirrorResyncCommand(localPath).args, { inherit: true });
      if (resync.status !== 0) {
        throw new Error("Initial sync failed. Fix the error above and re-run this script.");
      }
      log("");
      log("  ✓ Helix Drive is set up.");
      log(`  Folder:  ${localPath}`);
      log(
        platform() === "win32"
          ? `  Later:   ${join(homeDir, "sync-now.cmd")}`
          : `  Later:   ${join(homeDir, "sync-now.sh")}`,
      );
      log("  Tip: schedule that helper to run every few minutes if you want continuous sync.");
    } else {
      if (platform() !== "win32") {
        ensureDir(localPath);
      }
      log("");
      log("  ✓ Helix Drive is configured.");
      log(
        platform() === "win32"
          ? `  Start mount:  ${join(homeDir, "mount.cmd")}`
          : `  Start mount:  ${join(homeDir, "mount.sh")}`,
      );
      log("  Leave that window open while you work; Ctrl+C unmounts.");
      if (platform() === "darwin") {
        log("  Note: macOS may need macFUSE or FUSE-T installed for mount mode.");
      }
      if (platform() === "win32") {
        log("  Note: Windows needs WinFsp installed for mount mode (https://winfsp.dev/).");
      }
      const startNow =
        env.HELIX_SYNC_START_MOUNT === "1" ||
        (!interactive
          ? false
          : (await prompt(rl, "Start mount now? (y/N)", { defaultValue: "n" }))
              .toLowerCase()
              .startsWith("y"));
      if (startNow) {
        runRclone(buildMountCommand(localPath).args, { inherit: true });
      }
    }

    log("");
    return { ok: true, mode, localPath, homeDir, url };
  } finally {
    rl.close?.();
  }
}

async function main() {
  try {
    const result = await runSetup();
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
  await main();
}
