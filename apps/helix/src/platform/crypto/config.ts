/**
 * FIPS / crypto-adapter configuration (PRD §6.3, §14.4 — Tier 4 Sovereign/DoD).
 *
 * Helix routes every crypto primitive it uses (hashing, HMAC, random bytes,
 * key derivation, signing) through a {@link CryptoProvider} so that a Tier-4
 * deployment can be pinned to FIPS-approved algorithms and, where the host
 * provides one, a FIPS-validated OpenSSL module.
 *
 * The provider self-initializes from this configuration at import time, so no
 * change to `server.ts` / `index.ts` is required to enable FIPS mode — the
 * sovereign Helm overlay sets the environment variables and the adapter picks
 * them up.
 */

/**
 * Crypto adapter selection.
 *
 *  - `node` — the default Node `crypto`-backed provider. No algorithm
 *    restrictions; byte-identical to direct `node:crypto` usage.
 *  - `node-openssl-fips` — the FIPS provider. Restricts the algorithm set to
 *    the FIPS-approved list and, when the host Node was built/launched with a
 *    FIPS-validated OpenSSL, can drive `crypto.setFips(true)`.
 */
export type CryptoAdapterId = "node" | "node-openssl-fips";

/**
 * FIPS enforcement mode.
 *
 *  - `off` — FIPS not requested; the default Node provider is used.
 *  - `permissive` — FIPS provider is selected (non-approved algorithms are
 *    rejected) but the process is *not* required to actually run under an
 *    OpenSSL FIPS module. Useful for CI and for hosts whose base image is not
 *    yet a certified FIPS image.
 *  - `required` — FIPS provider is selected AND the process must be able to
 *    enter OpenSSL FIPS mode. If the runtime cannot do so the provider fails
 *    closed (see {@link CryptoInitializationError}).
 */
export type FipsMode = "off" | "permissive" | "required";

export interface CryptoConfig {
  /** Resolved adapter id. */
  readonly adapter: CryptoAdapterId;
  /** Resolved FIPS mode. */
  readonly fipsMode: FipsMode;
  /**
   * When true, the provider attempts `crypto.setFips(true)` during
   * initialization. Independent of `fipsMode` so a host launched with
   * `--enable-fips` (where `setFips` is unavailable / already on) still works.
   */
  readonly enableOpensslFips: boolean;
}

const TRUTHY = new Set(["1", "true", "yes", "on", "required", "enabled"]);

function envFlag(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

/**
 * Resolve the crypto configuration from the environment.
 *
 * Recognised variables (set by `infra/helm/helix/values-sovereign.yaml`):
 *  - `HELIX_FIPS_MODE`        — `off` | `permissive` | `required`
 *  - `HELIX_CRYPTO_ADAPTER`   — `node` | `node-openssl-fips`
 *  - `HELIX_FIPS_OPENSSL`     — `1`/`true` to attempt `crypto.setFips(true)`
 */
export function resolveCryptoConfig(env: NodeJS.ProcessEnv = process.env): CryptoConfig {
  const fipsMode = parseFipsMode(env.HELIX_FIPS_MODE);
  const explicitAdapter = parseAdapter(env.HELIX_CRYPTO_ADAPTER);

  // The adapter follows FIPS mode unless explicitly overridden: any FIPS mode
  // other than `off` implies the FIPS provider.
  const adapter: CryptoAdapterId =
    explicitAdapter ?? (fipsMode === "off" ? "node" : "node-openssl-fips");

  // In `required` mode we always attempt to drive OpenSSL into FIPS mode.
  // In `permissive` mode the operator opts in explicitly via HELIX_FIPS_OPENSSL.
  const enableOpensslFips =
    fipsMode === "required" || (fipsMode === "permissive" && envFlag(env.HELIX_FIPS_OPENSSL));

  return { adapter, fipsMode, enableOpensslFips };
}

function parseFipsMode(value: string | undefined): FipsMode {
  switch (value?.trim().toLowerCase()) {
    case "required":
    case "enforce":
    case "strict":
      return "required";
    case "permissive":
    case "soft":
    case "on":
    case "true":
    case "1":
      return "permissive";
    default:
      return "off";
  }
}

function parseAdapter(value: string | undefined): CryptoAdapterId | undefined {
  switch (value?.trim().toLowerCase()) {
    case "node-openssl-fips":
    case "fips":
      return "node-openssl-fips";
    case "node":
    case "default":
      return "node";
    default:
      return undefined;
  }
}
