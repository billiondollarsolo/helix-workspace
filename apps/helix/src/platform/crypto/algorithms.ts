/**
 * FIPS-approved algorithm policy (PRD §14.4; NIST SP 800-140C / FIPS 140-3
 * approved-security-functions; NIST SP 800-131A transition guidance).
 *
 * The {@link FipsCryptoProvider} consults this module before performing any
 * primitive and fails closed on a non-approved algorithm. The default Node
 * provider does not — it is byte-identical to direct `node:crypto` usage.
 */

/** A category of crypto primitive, used for policy lookup and error messages. */
export type CryptoPrimitiveKind = "hash" | "hmac" | "kdf" | "signature";

/**
 * FIPS-approved hash / digest functions. SHA-1 is permitted for HMAC and KDF
 * use but NOT for digital signatures or general hashing — callers that need a
 * collision-resistant digest must use SHA-2 or SHA-3.
 *
 * Names are normalized lowercase, matching Node's `crypto.getHashes()` style.
 */
const FIPS_APPROVED_HASHES: ReadonlySet<string> = new Set([
  "sha224",
  "sha256",
  "sha384",
  "sha512",
  "sha512-224",
  "sha512-256",
  "sha3-224",
  "sha3-256",
  "sha3-384",
  "sha3-512",
]);

/**
 * Hashes approved as the inner primitive of HMAC / HKDF / PBKDF2 only. SHA-1
 * remains FIPS-approved inside HMAC (NIST SP 800-107) even though it is
 * disallowed as a standalone digest.
 */
const FIPS_APPROVED_KEYED_HASHES: ReadonlySet<string> = new Set([
  ...FIPS_APPROVED_HASHES,
  "sha1",
]);

/**
 * Explicitly disallowed algorithm tokens. Surfaced for clear error messages
 * and to reject values that are not even real Node algorithms.
 */
const NEVER_APPROVED: ReadonlySet<string> = new Set([
  "md5",
  "md4",
  "ripemd160",
  "rmd160",
  "sha1", // standalone digest use
  "shake128",
  "shake256",
]);

/** FIPS-approved KDF identifiers used by Helix. */
const FIPS_APPROVED_KDFS: ReadonlySet<string> = new Set(["pbkdf2", "hkdf"]);

/** Normalize an algorithm name to the lowercase form used for lookups. */
export function normalizeAlgorithm(name: string): string {
  return name.trim().toLowerCase();
}

export interface AlgorithmPolicyResult {
  readonly approved: boolean;
  /** Populated when `approved` is false. */
  readonly reason?: string;
}

/**
 * Decide whether a hash algorithm is FIPS-approved for the given primitive
 * kind. `kind` defaults to `hash` (the strictest — standalone digest use).
 */
export function isHashApproved(
  algorithm: string,
  kind: CryptoPrimitiveKind = "hash",
): AlgorithmPolicyResult {
  const normalized = normalizeAlgorithm(algorithm);

  if (kind === "hmac" || kind === "kdf") {
    if (FIPS_APPROVED_KEYED_HASHES.has(normalized)) {
      return { approved: true };
    }
    return {
      approved: false,
      reason: `Hash "${algorithm}" is not FIPS-approved for ${kind} use.`,
    };
  }

  if (NEVER_APPROVED.has(normalized)) {
    return {
      approved: false,
      reason: `Hash "${algorithm}" is never FIPS-approved for standalone digest use.`,
    };
  }
  if (FIPS_APPROVED_HASHES.has(normalized)) {
    return { approved: true };
  }
  return {
    approved: false,
    reason: `Hash "${algorithm}" is not a FIPS-approved digest function.`,
  };
}

/** Decide whether a KDF identifier is FIPS-approved. */
export function isKdfApproved(kdf: string): AlgorithmPolicyResult {
  const normalized = normalizeAlgorithm(kdf);
  if (FIPS_APPROVED_KDFS.has(normalized)) {
    return { approved: true };
  }
  return {
    approved: false,
    reason: `Key-derivation function "${kdf}" is not FIPS-approved (use pbkdf2 or hkdf).`,
  };
}

/**
 * The minimum PBKDF2 iteration count Helix accepts under FIPS. NIST SP 800-132
 * sets no fixed floor; this is a defensive operational minimum.
 */
export const FIPS_MIN_PBKDF2_ITERATIONS = 10_000;

/** The minimum derived-key / random-byte length (bits) accepted under FIPS. */
export const FIPS_MIN_KEY_BITS = 112;

/** Exposed for tests and diagnostics. */
export const FIPS_APPROVED_HASH_LIST: readonly string[] = [...FIPS_APPROVED_HASHES].sort();
