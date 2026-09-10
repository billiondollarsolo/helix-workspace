/**
 * Helix crypto adapter layer (PRD §6.3, §14.4 — Tier 4 Sovereign/DoD).
 *
 * This module owns the single, process-wide {@link CryptoProvider}. Every
 * crypto call-site in Helix imports {@link getCryptoProvider} (or one of the
 * convenience helpers) rather than `node:crypto` directly, so a Tier-4
 * deployment can pin the algorithm set to FIPS-approved primitives.
 *
 * ## Opt-in by design
 *
 * FIPS is NEVER the default. The provider self-initializes from the
 * environment at import time:
 *
 *  - No FIPS env set            -> {@link NodeCryptoProvider} (byte-identical
 *                                  to direct `node:crypto`; what every
 *                                  standard deploy gets).
 *  - `HELIX_FIPS_MODE=permissive` -> {@link FipsCryptoProvider}, algorithm
 *                                    allow-list enforced, non-FIPS OpenSSL
 *                                    tolerated.
 *  - `HELIX_FIPS_MODE=required` -> {@link FipsCryptoProvider}, and the process
 *                                  must be able to enter OpenSSL FIPS mode or
 *                                  it fails closed at first crypto use.
 *
 * Because initialization is import-time and env-driven, no edit to
 * `server.ts` / `index.ts` is needed to enable FIPS — the sovereign Helm
 * overlay sets the variables and the STIG image supplies the FIPS OpenSSL.
 */

import { resolveCryptoConfig, type CryptoConfig } from "./config.js";
import { FipsCryptoProvider } from "./fips-provider.js";
import { NodeCryptoProvider } from "./node-provider.js";
import { type BinaryInput, type CryptoProvider } from "./provider.js";

export type { CryptoConfig } from "./config.js";
export type { BinaryInput, CryptoProvider } from "./provider.js";

/**
 * Build a {@link CryptoProvider} for an explicit configuration. Exported for
 * tests and for callers that need a provider isolated from process env.
 *
 * Throws {@link CryptoInitializationError} when a `required` FIPS profile
 * cannot be satisfied — failing closed rather than silently downgrading.
 */
export function createCryptoProvider(config: CryptoConfig): CryptoProvider {
  if (config.adapter === "node") {
    return new NodeCryptoProvider();
  }
  return new FipsCryptoProvider({
    enableOpensslFips: config.enableOpensslFips,
    requireOpensslFips: config.fipsMode === "required",
  });
}

let activeProvider: CryptoProvider | undefined;
let activeConfig: CryptoConfig | undefined;

/**
 * The process-wide crypto provider, lazily self-initialized from the
 * environment on first use. Subsequent calls return the cached instance.
 */
export function getCryptoProvider(): CryptoProvider {
  if (activeProvider === undefined) {
    activeConfig = resolveCryptoConfig();
    activeProvider = createCryptoProvider(activeConfig);
  }
  return activeProvider;
}

/**
 * Replace the active provider. Intended for tests only — production code
 * relies on import-time self-initialization. Pass `undefined` to reset to
 * env-driven resolution on the next {@link getCryptoProvider} call.
 */
export function setCryptoProviderForTesting(provider: CryptoProvider | undefined): void {
  activeProvider = provider;
  if (provider === undefined) {
    activeConfig = undefined;
  }
}

// --- convenience helpers (used by the routed call-sites) --------------------

/** SHA-256 digest as lowercase hex — the audit hash chain primitive. */
export function sha256Hex(data: BinaryInput): string {
  return getCryptoProvider().hash("sha256", data, "hex");
}

/** Cryptographically secure random bytes via the active provider. */
export function randomBytes(size: number): Buffer {
  return getCryptoProvider().randomBytes(size);
}

/** RFC 4122 v4 UUID via the active provider. */
export function randomUuid(): string {
  return getCryptoProvider().randomUuid();
}
