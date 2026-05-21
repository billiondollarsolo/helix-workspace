/**
 * The {@link CryptoProvider} contract — the single abstraction every Helix
 * crypto call-site routes through (PRD §6.3, §14.4 Tier 4).
 *
 * Two implementations exist:
 *  - {@link NodeCryptoProvider}  — default; thin wrapper over `node:crypto`.
 *  - {@link FipsCryptoProvider}  — restricts the algorithm set to FIPS-approved
 *    primitives and fails closed on anything else.
 *
 * Both produce byte-identical output for the algorithms they share, so routing
 * existing call-sites through the provider is behaviour-preserving when FIPS is
 * off (the documented constraint for this change).
 */

/** Binary input accepted by the digest / HMAC primitives. */
export type BinaryInput = Buffer | Uint8Array | string;

/** Digest / signature output encoding. */
export type DigestEncoding = "hex" | "base64" | "base64url";

export interface Pbkdf2Options {
  readonly password: BinaryInput;
  readonly salt: BinaryInput;
  readonly iterations: number;
  readonly keyLength: number;
  /** Inner hash, e.g. `sha256`. */
  readonly digest: string;
}

export interface HkdfOptions {
  readonly ikm: BinaryInput;
  readonly salt: BinaryInput;
  readonly info: BinaryInput;
  readonly keyLength: number;
  /** Inner hash, e.g. `sha256`. */
  readonly digest: string;
}

/** Diagnostic snapshot of the active provider, used by readiness reporting. */
export interface CryptoProviderStatus {
  readonly providerId: "node" | "node-openssl-fips";
  readonly fipsEnforced: boolean;
  /** Whether the host OpenSSL is actually in FIPS mode (`crypto.getFips()`). */
  readonly opensslFipsActive: boolean;
  /** Result of the provider self-test run at initialization. */
  readonly selfTestPassed: boolean;
}

/**
 * The crypto primitives Helix actually uses. Deliberately small — every method
 * here maps to a real call-site in the codebase (audit hash chain, webhook
 * HMAC, API-key hashing, credential fingerprints, random token minting).
 */
export interface CryptoProvider {
  /** Stable identifier for the active provider. */
  readonly id: "node" | "node-openssl-fips";

  /**
   * Compute a one-shot digest. Throws {@link UnsupportedAlgorithmError} under a
   * FIPS provider when `algorithm` is not FIPS-approved for digest use.
   */
  hash(algorithm: string, data: BinaryInput, encoding?: DigestEncoding): string;

  /** Compute a raw (Buffer) digest. */
  hashBuffer(algorithm: string, data: BinaryInput): Buffer;

  /**
   * Compute an HMAC. Throws under a FIPS provider when the inner hash is not
   * approved for keyed use.
   */
  hmac(algorithm: string, key: BinaryInput, data: BinaryInput, encoding?: DigestEncoding): string;

  /** Compute a raw (Buffer) HMAC. */
  hmacBuffer(algorithm: string, key: BinaryInput, data: BinaryInput): Buffer;

  /** Cryptographically secure random bytes. */
  randomBytes(size: number): Buffer;

  /** RFC 4122 v4 UUID. */
  randomUuid(): string;

  /** Constant-time buffer comparison; false when lengths differ. */
  timingSafeEqual(a: BinaryInput, b: BinaryInput): boolean;

  /** PBKDF2 key derivation. Throws under FIPS when policy is violated. */
  pbkdf2(options: Pbkdf2Options): Buffer;

  /** HKDF key derivation. Throws under FIPS when the inner hash is not approved. */
  hkdf(options: HkdfOptions): Buffer;

  /** Current provider status — for the FIPS readiness check / attestation. */
  status(): CryptoProviderStatus;
}

/** Thrown when a FIPS provider is asked to use a non-approved algorithm. */
export class UnsupportedAlgorithmError extends Error {
  readonly code = "HELIX_CRYPTO_ALGORITHM_NOT_APPROVED";

  constructor(message: string) {
    super(message);
    this.name = "UnsupportedAlgorithmError";
  }
}

/**
 * Thrown when a FIPS provider cannot satisfy its `required` contract — e.g.
 * the host runtime cannot enter OpenSSL FIPS mode or the self-test fails.
 * Surfacing this fails the process closed rather than silently degrading.
 */
export class CryptoInitializationError extends Error {
  readonly code = "HELIX_CRYPTO_FIPS_INIT_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "CryptoInitializationError";
  }
}
