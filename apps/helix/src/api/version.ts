import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";

/**
 * Canonical API/server version. Sourced from the app `package.json` so the
 * version reported by the server, OpenAPI document, MCP `serverInfo`, and the
 * `api-version` response header all agree and never drift back to `0.0.0`.
 */
function resolvePackageVersion(): string {
  try {
    const packageJsonUrl = new URL("../../package.json", import.meta.url);
    const raw = readFileSync(fileURLToPath(packageJsonUrl), "utf8");
    const parsed = JSON.parse(raw) as { readonly version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // Fall through to the env/default below.
  }
  const envVersion = env().HELIX_APP_VERSION;
  return envVersion !== undefined && envVersion.trim().length > 0
    ? envVersion.trim()
    : "0.0.0-dev";
}

/** Full semver-ish version string, e.g. `1.4.0` or `0.0.0-dev`. */
export const HELIX_SERVER_VERSION = resolvePackageVersion();

/**
 * Major API version surfaced as the `/v1` route prefix and the `api-version`
 * header value. Derived from the package version's major component; defaults
 * to `1` for pre-1.0 builds since the HTTP surface is already v1-shaped.
 */
export const HELIX_API_MAJOR_VERSION = (() => {
  const major = Number.parseInt(HELIX_SERVER_VERSION.split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major > 0 ? major : 1;
})();

/** Route prefix for the versioned API surface, e.g. `/v1`. */
export const HELIX_API_VERSION_PREFIX = `/v${String(HELIX_API_MAJOR_VERSION)}`;

/** Value emitted in the `api-version` response header. */
export const HELIX_API_VERSION_HEADER_VALUE = `v${String(HELIX_API_MAJOR_VERSION)}`;

/**
 * MCP protocol revision Helix pins. Bumped from the legacy `2024-11-05` draft
 * to the current spec revision (PRD §9.5).
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
