/**
 * Pure helpers for scripts/helix-drive-sync-setup.mjs. No I/O here, so every
 * decision the setup makes (URLs, paths, versions, resync, error text) is
 * unit-testable. Dependency-free Node ESM.
 */
import { homedir, platform } from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

export const REMOTE_NAME = "helix";
export const DEFAULT_MIRROR_DIR_NAME = "HelixDrive";
export const MIN_RCLONE_VERSION = Object.freeze({ major: 1, minor: 66 });
/** Matches the server default HELIX_DRIVE_AV_MAX_FILE_BYTES (128 MiB). rclone "M" is MiB. */
export const DEFAULT_MAX_SIZE = "128M";
export const CONFIG_VERSION = 3;

export function helixHomeDir(home = homedir(), os = platform()) {
  return pathFor(os).join(home, ".helix", "drive-sync");
}

function pathFor(os) {
  return os === "win32" ? path.win32 : path.posix;
}

/**
 * Normalize a user-entered server URL to the WebDAV files root
 * `<origin>/v1/dav/files/`. Accepts a bare host, the Helix base URL, or a URL
 * that already ends in `/v1/dav/files` or the legacy `/dav/files`.
 * Plain `http://` is refused unless `allowInsecure` is set.
 */
export function normalizeDavUrl(raw, { allowInsecure = false } = {}) {
  let s = String(raw ?? "").trim();
  if (!s) throw new Error("Server URL is required.");
  if (/[\s\r\n]/u.test(s)) throw new Error("Server URL must not contain spaces or newlines.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(s)) {
    s = `https://${s}`;
  }
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`"${raw}" is not a valid server URL. Example: https://helix.example.com`);
  }
  if (parsed.protocol === "http:" && !allowInsecure) {
    throw new Error(
      "Refusing plain http:// — your app password would cross the network unencrypted.\n" +
        "Use the https:// address of your Helix server. For a local test server only, re-run with\n" +
        "--insecure (or HELIX_SYNC_INSECURE=1).",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Server URL must start with https://");
  }
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  const match = /^(.*?)(?:\/v1)?\/dav\/files(\/.*)?$/iu.exec(pathname);
  let prefix;
  let rest = "/";
  if (match) {
    prefix = match[1];
    rest = match[2] ? `${match[2]}/` : "/";
  } else {
    prefix = pathname.replace(/\/v1$/iu, "");
  }
  return `${parsed.origin}${prefix}/v1/dav/files${rest}`;
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
  return pathFor(os).join(home, mode === "mount" ? "HelixMount" : DEFAULT_MIRROR_DIR_NAME);
}

/**
 * Expand `~`, make the path absolute, and refuse locations a two-way sync
 * must never own: the filesystem root, the home directory itself, and this
 * repository (or anything inside it).
 */
export function resolveLocalPath(raw, options = {}) {
  const os = options.os ?? platform();
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const p = pathFor(os);
  const value = String(raw ?? "").trim();
  if (!value) throw new Error("Local path is required.");
  if (options.mode === "mount" && os === "win32" && /^[A-Za-z]:\\?$/u.test(value)) {
    return value.slice(0, 2).toUpperCase();
  }
  let expanded = value;
  if (value === "~") expanded = home;
  else if (value.startsWith("~/") || (os === "win32" && value.startsWith("~\\"))) {
    expanded = p.join(home, value.slice(2));
  }
  const resolved = p.resolve(cwd, expanded);
  const same = (a, b) =>
    os === "win32" || os === "darwin"
      ? p.resolve(a).toLowerCase() === p.resolve(b).toLowerCase()
      : p.resolve(a) === p.resolve(b);
  if (same(resolved, p.parse(resolved).root)) {
    throw new Error(`Refusing to sync the filesystem root (${resolved}). Pick a dedicated folder.`);
  }
  if (same(resolved, home)) {
    throw new Error(
      `Refusing to sync your whole home folder (${resolved}). Use a subfolder such as ${p.join(home, DEFAULT_MIRROR_DIR_NAME)}.`,
    );
  }
  if (options.repoDir !== undefined) {
    const relative = p.relative(options.repoDir, resolved);
    if (relative === "" || (!relative.startsWith("..") && !p.isAbsolute(relative))) {
      throw new Error(
        `Refusing to sync inside the Helix repository (${options.repoDir}). Pick a folder outside it.`,
      );
    }
  }
  return resolved;
}

/** Parse `rclone version` output, e.g. "rclone v1.66.0" or "rclone v1.68.2-DEV". */
export function parseRcloneVersion(text) {
  const match = /rclone v(\d+)\.(\d+)(?:\.(\d+))?/u.exec(String(text ?? ""));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

export function checkRcloneVersion(text, os = platform()) {
  const version = parseRcloneVersion(text);
  const min = `${MIN_RCLONE_VERSION.major}.${MIN_RCLONE_VERSION.minor}`;
  const upgrade = `Install rclone ${min} or newer:\n${rcloneInstallHint(os)}`;
  if (version === null) {
    return { ok: false, version: null, message: `Could not read the rclone version.\n${upgrade}` };
  }
  const label = `${version.major}.${version.minor}.${version.patch}`;
  const tooOld =
    version.major < MIN_RCLONE_VERSION.major ||
    (version.major === MIN_RCLONE_VERSION.major && version.minor < MIN_RCLONE_VERSION.minor);
  if (tooOld) {
    return {
      ok: false,
      version,
      message: `rclone ${label} is too old: two-way sync needs ${min}+ (bisync --resilient).\n${upgrade}`,
    };
  }
  return { ok: true, version, message: `rclone ${label}` };
}

export function rcloneInstallHint(os = platform()) {
  if (os === "darwin")
    return "  brew install rclone\n  # or: sudo -v ; curl https://rclone.org/install.sh | sudo bash\n";
  if (os === "win32")
    return "  winget install Rclone.Rclone\n  # or download from https://rclone.org/downloads/\n";
  // Distribution packages are often older than 1.66; use the official installer.
  return "  sudo -v ; curl https://rclone.org/install.sh | sudo bash\n  # details: https://rclone.org/install/\n";
}

/** Accepts rclone size suffixes (B, K, M, G, T; binary units) or "off". */
export function resolveMaxSize(raw) {
  const value = String(raw ?? "").trim();
  if (value === "") return DEFAULT_MAX_SIZE;
  if (value.toLowerCase() === "off") return "off";
  if (!/^\d+(?:\.\d+)?(?:[BKMGT]i?B?)?$/iu.test(value)) {
    throw new Error(
      `HELIX_SYNC_MAX_SIZE "${value}" is not a size. Use e.g. 128M or 1G (ask your admin for the server limit).`,
    );
  }
  return value;
}

/** Contents of the dedicated rclone config file the setup manages (0600). */
export function buildRcloneConfig({ remoteName = REMOTE_NAME, url, user, obscuredPass }) {
  for (const [name, value] of Object.entries({ url, user, obscuredPass })) {
    if (typeof value !== "string" || value === "" || /[\r\n]/u.test(value)) {
      throw new Error(`Invalid ${name} for the rclone config.`);
    }
  }
  return [
    `[${remoteName}]`,
    "type = webdav",
    `url = ${url}`,
    "vendor = other",
    `user = ${user}`,
    `pass = ${obscuredPass}`,
    "",
  ].join("\n");
}

function filterArgs(maxSize) {
  return maxSize === "off" ? [] : ["--max-size", maxSize];
}

export function buildMirrorCommand(localPath, options = {}) {
  const { remoteName = REMOTE_NAME, configPath, workdir, maxSize = DEFAULT_MAX_SIZE } = options;
  // Plain WebDAV exposes no usable hash/modtime; compare downloaded hashes to catch same-size edits.
  const args = [
    "bisync",
    localPath,
    `${remoteName}:`,
    "--create-empty-src-dirs",
    "--resilient",
    "--recover",
    "--max-lock",
    "2m",
    "--checksum",
    "--compare",
    "size,checksum",
    "--download-hash",
    "--disable",
    "Move,Copy,DirMove",
  ];
  if (workdir !== undefined) args.push("--workdir", workdir);
  args.push(...filterArgs(maxSize));
  if (configPath !== undefined) args.push("--config", configPath);
  return { bin: "rclone", args };
}

/** Rebuilds the bisync baseline. Only for first setup or an explicit request. */
export function buildMirrorResyncCommand(localPath, options = {}) {
  const mirror = buildMirrorCommand(localPath, options);
  return { bin: mirror.bin, args: [...mirror.args, "--resync"] };
}

export function buildMountCommand(localPath, options = {}) {
  const {
    remoteName = REMOTE_NAME,
    os = platform(),
    configPath,
    maxSize = DEFAULT_MAX_SIZE,
  } = options;
  const args = [
    "mount",
    `${remoteName}:`,
    localPath,
    "--vfs-cache-mode",
    "full",
    "--dir-cache-time",
    "30s",
    "--disable",
    "Move,Copy,DirMove",
    ...filterArgs(maxSize),
  ];
  if (os === "win32") args.push("--network-mode");
  if (configPath !== undefined) args.push("--config", configPath);
  return { bin: "rclone", args };
}

/** True when a saved config targets the same server, account, and folder. */
export function sameSyncTarget(previous, current) {
  return (
    previous !== null &&
    typeof previous === "object" &&
    previous.mode === "mirror" &&
    current.mode === "mirror" &&
    previous.url === current.url &&
    previous.user === current.user &&
    previous.localPath === current.localPath
  );
}

/**
 * Decide how to run the mirror on this setup run.
 * - `bisync`: same target and an existing baseline — never resync.
 * - `resync` with `confirm: "none"`: first setup into an empty folder, or forced.
 * - `resync` with `confirm: "warn"`: first setup into a non-empty folder.
 * - `resync` with `confirm: "explicit"`: re-run whose target changed or whose
 *   baseline is missing. Needs HELIX_SYNC_RESYNC=1 or an interactive yes,
 *   because a resync can bring back files deleted on one side.
 */
export function decideMirrorRun({ previous, current, hasBaseline, localNonEmpty, forceResync }) {
  if (forceResync) {
    return { action: "resync", reason: "forced", confirm: "none", warnNonEmpty: localNonEmpty };
  }
  if (sameSyncTarget(previous, current) && hasBaseline) {
    if (previous.version !== CONFIG_VERSION) {
      return {
        action: "resync",
        reason: "comparison_upgrade",
        confirm: "explicit",
        warnNonEmpty: false,
      };
    }
    return { action: "bisync", reason: "unchanged", confirm: "none", warnNonEmpty: false };
  }
  if (previous === null) {
    return {
      action: "resync",
      reason: "first_setup",
      confirm: localNonEmpty ? "warn" : "none",
      warnNonEmpty: localNonEmpty,
    };
  }
  return {
    action: "resync",
    reason: sameSyncTarget(previous, current) ? "baseline_missing" : "target_changed",
    confirm: "explicit",
    warnNonEmpty: localNonEmpty,
  };
}

/** Pull the first well-known HTTP status out of rclone's error output. */
export function httpStatusFromRcloneOutput(text) {
  const match = /\b(401|403|404|426|429)\b/u.exec(String(text ?? ""));
  return match ? Number(match[1]) : null;
}

/**
 * Actionable text for a failed connection probe.
 * `operation` is "list" (needs drive.read), "write" (drive.write), or "delete" (drive.delete).
 */
export function probeFailureMessage(status, operation = "list") {
  const scope = { list: "drive.read", write: "drive.write", delete: "drive.delete" }[operation];
  switch (status) {
    case 401:
      return "The server rejected the email or app password (401). Check both, and that the app password was not revoked or expired. Use an app password, not your login password.";
    case 403:
      return `The app password works but is missing the "${scope}" scope (403). Ask your Helix admin to issue a new one with the "Desktop sync (WebDAV)" preset (Admin → Apps & integrations → App passwords).`;
    case 404:
      return "The server has no WebDAV endpoint at this URL (404). Use the base address of your Helix server, e.g. https://helix.example.com — setup adds /v1/dav/files/.";
    case 426:
      return "The server requires HTTPS (426). Use the https:// address of your Helix server.";
    case 429:
      return "Too many attempts (429). Wait a minute and run setup again. If many people share one office IP, ask your admin to check HELIX_TRUSTED_PROXIES.";
    default:
      return operation === "list"
        ? "Could not list Helix Drive. Check the URL, email, app password, and network."
        : `Could not ${operation === "write" ? "create" : "delete"} a test folder on Helix Drive. Check the app password scopes (needs "${scope}").`;
  }
}

export function canaryName(random = Math.random) {
  return `.helix-sync-check-${Math.floor(random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0")}`;
}

export const HELP_TEXT = `Helix Drive desktop sync setup (wraps rclone ${MIN_RCLONE_VERSION.major}.${MIN_RCLONE_VERSION.minor}+)

Usage:
  node scripts/helix-drive-sync-setup.mjs [--insecure] [--resync] [--help]
  pnpm helix:drive-sync

Options:
  --help, -h    Show this help and exit.
  --insecure    Allow a plain http:// server URL (local testing only).
  --resync      Rebuild the two-way sync baseline (same as HELIX_SYNC_RESYNC=1).
                Re-runs never resync on their own: a resync can bring back files
                deleted on one side.

Environment (non-interactive runs set HELIX_SYNC_YES=1):
  HELIX_SYNC_URL        Helix server URL, e.g. https://helix.example.com
  HELIX_SYNC_USER       Your Helix email
  HELIX_SYNC_PASSWORD   App password issued by your admin (Desktop sync preset)
  HELIX_SYNC_MODE       mirror | mount
  HELIX_SYNC_PATH       Local folder (mirror) or mount point
  HELIX_SYNC_MAX_SIZE   Largest file to sync (default ${DEFAULT_MAX_SIZE} = server default limit; "off" to disable)
  HELIX_SYNC_RESYNC=1   Explicitly allow a resync
  HELIX_SYNC_INSECURE=1 Same as --insecure
  HELIX_SYNC_START_MOUNT=1  Start the mount immediately (mount mode)

Files land in ~/.helix/drive-sync/ (config.json, rclone.conf, helper scripts).
`;

/** Parse CLI flags. Unknown flags are an error. */
export function parseArgs(argv) {
  const flags = { help: false, insecure: false, resync: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--insecure") flags.insecure = true;
    else if (arg === "--resync") flags.resync = true;
    else throw new Error(`Unknown option "${arg}". Run with --help for usage.`);
  }
  return flags;
}
