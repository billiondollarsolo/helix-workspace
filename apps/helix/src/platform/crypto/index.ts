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
import {
  CryptoInitializationError,
  type BinaryInput,
  type CryptoProvider,
  type DigestEncoding,
} from "./provider.js";

export type {
  BinaryInput,
  CryptoProvider,
  CryptoProviderStatus,
  DigestEncoding,
  HkdfOptions,
  Pbkdf2Options,
} from "./provider.js";
export { CryptoInitializationError, UnsupportedAlgorithmError } from "./provider.js";
export type { CryptoAdapterId, CryptoConfig, FipsMode } from "./config.js";
export { resolveCryptoConfig } from "./config.js";
export { NodeCryptoProvider } from "./node-provider.js";
export { FipsCryptoProvider } from "./fips-provider.js";
export { isHashApproved, isKdfApproved, normalizeAlgorithm } from "./algorithms.js";

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

/** The resolved crypto configuration backing the active provider. */
export function getCryptoConfig(): CryptoConfig {
  if (activeConfig === undefined) {
    getCryptoProvider();
  }
  return activeConfig as CryptoConfig;
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

/** One-shot digest in any encoding via the active provider. */
export function hashHex(algorithm: string, data: BinaryInput): string {
  return getCryptoProvider().hash(algorithm, data, "hex");
}

/** HMAC digest via the active provider. */
export function hmac(
  algorithm: string,
  key: BinaryInput,
  data: BinaryInput,
  encoding: DigestEncoding = "hex",
): string {
  return getCryptoProvider().hmac(algorithm, key, data, encoding);
}

/** Cryptographically secure random bytes via the active provider. */
export function randomBytes(size: number): Buffer {
  return getCryptoProvider().randomBytes(size);
}

/** RFC 4122 v4 UUID via the active provider. */
export function randomUuid(): string {
  return getCryptoProvider().randomUuid();
}

/** Constant-time comparison via the active provider. */
export function timingSafeEqual(a: BinaryInput, b: BinaryInput): boolean {
  return getCryptoProvider().timingSafeEqual(a, b);
}

/**
 * Assert the active provider initialized cleanly. Safe to call at startup as a
 * fail-closed gate; throws {@link CryptoInitializationError} on a broken FIPS
 * profile. A no-op for the default Node provider.
 */
export function assertCryptoProviderReady(): void {
  const status = getCryptoProvider().status();
  if (!status.selfTestPassed) {
    throw new CryptoInitializationError("Active crypto provider failed its self-test.");
  }
}
