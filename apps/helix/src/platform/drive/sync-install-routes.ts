import type { FastifyInstance, FastifyRequest } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAMES = ["install.sh", "install.ps1", "helix-sync.sh", "helix-sync.ps1"] as const;

export function helixSyncScriptDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, "scripts/helix-sync");
    if (existsSync(join(candidate, "install.sh"))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  const fromCwd = join(process.cwd(), "scripts/helix-sync");
  if (existsSync(join(fromCwd, "install.sh"))) {
    return fromCwd;
  }
  throw new Error("Helix Sync install scripts are not packaged on this server.");
}

export function requestOrigin(request: FastifyRequest): string {
  const forwardedHost = headerValue(request.headers["x-forwarded-host"]);
  const host = forwardedHost ?? headerValue(request.headers.host) ?? "localhost";
  const forwardedProto = headerValue(request.headers["x-forwarded-proto"]);
  const proto = forwardedProto ?? request.protocol;
  return sanitizeOrigin(`${proto}://${host}`);
}

export function withHelixOrigin(
  source: string,
  origin: string,
  kind: "shell" | "powershell",
): string {
  const safe = sanitizeOrigin(origin);
  const preamble =
    kind === "powershell"
      ? `if (-not $env:HELIX_SYNC_ORIGIN) { $env:HELIX_SYNC_ORIGIN = "${safe}" }\n` +
        `if (-not $env:HELIX_SYNC_DEFAULT_URL) { $env:HELIX_SYNC_DEFAULT_URL = "${safe}" }\n`
      : `HELIX_SYNC_ORIGIN="\${HELIX_SYNC_ORIGIN:-${safe}}"\n` +
        `HELIX_SYNC_DEFAULT_URL="\${HELIX_SYNC_DEFAULT_URL:-${safe}}"\n`;
  if (source.startsWith("#!")) {
    const nl = source.indexOf("\n");
    if (nl === -1) {
      return `${source}\n${preamble}`;
    }
    return `${source.slice(0, nl + 1)}${preamble}${source.slice(nl + 1)}`;
  }
  return `${preamble}${source}`;
}

export async function registerDriveSyncInstallRoutes(app: FastifyInstance): Promise<void> {
  const dir = helixSyncScriptDir();
  for (const name of SCRIPT_NAMES) {
    app.get(`/drive/sync/${name}`, async (request, reply) => {
      const powershell = name.endsWith(".ps1");
      const downloadName = name.startsWith("install")
        ? `install-helix-sync${name.slice(name.lastIndexOf("."))}`
        : name;
      const body = withHelixOrigin(
        readFileSync(join(dir, name), "utf8"),
        requestOrigin(request),
        powershell ? "powershell" : "shell",
      );
      return reply
        .header("cache-control", "public, max-age=300")
        .header("x-content-type-options", "nosniff")
        .header("content-disposition", `attachment; filename="${downloadName}"`)
        .type(powershell ? "text/plain; charset=utf-8" : "text/x-shellscript; charset=utf-8")
        .send(body);
    });
  }
}

export function sanitizeOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "http://localhost";
    }
    return url.origin;
  } catch {
    return "http://localhost";
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().split(",")[0]?.trim();
  }
  return undefined;
}
