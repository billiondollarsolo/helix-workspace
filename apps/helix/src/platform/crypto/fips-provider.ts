/**
 * {@link FipsCryptoProvider} — the opt-in, Tier-4 crypto provider
 * (PRD §6.3, §14.4).
 *
 * It is NEVER the default. It is constructed only when an explicit config /
 * env flag selects it (see {@link resolveCryptoConfig}). A standard Helix
 * deployment never instantiates this class.
 *
 * Behaviour:
 *  - Every primitive is checked against the FIPS algorithm policy
 *    ({@link ./algorithms}). A non-approved algorithm throws
 *    {@link UnsupportedAlgorithmError} — the provider fails closed.
 *  - When `enableOpensslFips` is set it drives `crypto.setFips(true)` so the
 *    underlying OpenSSL also enforces FIPS. On a non-FIPS OpenSSL build that
 *    call fails; in `required` mode that failure is fatal
 *    ({@link CryptoInitializationError}).
 *  - For approved algorithms it delegates to the same `node:crypto` calls as
 *    {@link NodeCryptoProvider}, so output is byte-identical.
 *
 * No FIPS-specific npm dependency is used: enforcement is the algorithm
 * allow-list plus the host's OpenSSL FIPS module (an ops/procurement concern).
 */

import { setFips } from "node:crypto";
import {
  FIPS_MIN_KEY_BITS,
  FIPS_MIN_PBKDF2_ITERATIONS,
  isHashApproved,
  isKdfApproved,
} from "./algorithms.js";
import { NodeCryptoProvider, readOpensslFips } from "./node-provider.js";
import {
  CryptoInitializationError,
  UnsupportedAlgorithmError,
  type BinaryInput,
  type CryptoProvider,
  type CryptoProviderStatus,
  type DigestEncoding,
  type HkdfOptions,
  type Pbkdf2Options,
} from "./provider.js";

export interface FipsProviderOptions {
  /** Attempt `crypto.setFips(true)` during construction. */
  readonly enableOpensslFips: boolean;
  /**
   * When true, a runtime that cannot enter OpenSSL FIPS mode is fatal. Maps to
   * `HELIX_FIPS_MODE=required`. When false (`permissive`), the algorithm
   * allow-list is still enforced but a non-FIPS OpenSSL is tolerated.
   */
  readonly requireOpensslFips: boolean;
}

export class FipsCryptoProvider implements CryptoProvider {
  readonly id = "node-openssl-fips" as const;

  /** Delegate for the actual primitive calls (approved algorithms only). */
  private readonly delegate = new NodeCryptoProvider();

  private readonly opensslFipsActive: boolean;
  private readonly selfTestPassed: boolean;

  constructor(options: FipsProviderOptions) {
    this.opensslFipsActive = this.initializeOpensslFips(options);
    this.selfTestPassed = this.runSelfTest();
    if (!this.selfTestPassed) {
      throw new CryptoInitializationError(
        "FIPS crypto provider self-test failed: an approved primitive did not produce the expected output.",
      );
    }
  }

  private initializeOpensslFips(options: FipsProviderOptions): boolean {
    if (!options.enableOpensslFips) {
      // Permissive without an explicit opt-in: report whatever OpenSSL is in.
      return readOpensslFips();
    }
    try {
      setFips(true);
    } catch (error) {
      if (options.requireOpensslFips) {
        throw new CryptoInitializationError(
          `HELIX_FIPS_MODE=required but the runtime cannot enter OpenSSL FIPS mode. ` +
            `Run on a FIPS-validated OpenSSL build (e.g. the STIG image) or launch Node ` +
            `with --enable-fips / --force-fips. Cause: ${(error as Error).message}`,
        );
      }
      // Permissive: the allow-list still applies even without OpenSSL FIPS.
      return readOpensslFips();
    }
    const active = readOpensslFips();
    if (!active && options.requireOpensslFips) {
      throw new CryptoInitializationError(
        "HELIX_FIPS_MODE=required: crypto.setFips(true) did not put OpenSSL into FIPS mode.",
      );
    }
    return active;
  }

  /**
   * Adapter-level known-answer self-test for the approved primitives Helix
   * relies on. A FIPS module performs its own power-on self-test; this is the
   * Helix-layer check that the provider is wired correctly and producing the
   * expected SHA-256 / HMAC-SHA-256 outputs.
   */
  private runSelfTest(): boolean {
    try {
      const digest = this.delegate.hash("sha256", "helix-fips-self-test", "hex");
      const mac = this.delegate.hmac("sha256", "helix-fips-key", "helix-fips-self-test", "hex");
      const expectedDigest =
        "259c64d02d1c7de6a7191c11e09ff66cdce5e8db878d39401f2f2a05644bcb80";
      const expectedMac =
        "130d62c789c556ffbefb55d50d0547b2aa5acb0bd578a8346f8e49aa0449ff96";
      return digest === expectedDigest && mac === expectedMac;
    } catch {
      return false;
    }
  }

  private assertHash(algorithm: string, kind: "hash" | "hmac"): void {
    const result = isHashApproved(algorithm, kind);
    if (!result.approved) {
      throw new UnsupportedAlgorithmError(
        result.reason ?? `Algorithm "${algorithm}" is not FIPS-approved.`,
      );
    }
  }

  hash(algorithm: string, data: BinaryInput, encoding: DigestEncoding = "hex"): string {
    this.assertHash(algorithm, "hash");
    return this.delegate.hash(algorithm, data, encoding);
  }

  hashBuffer(algorithm: string, data: BinaryInput): Buffer {
    this.assertHash(algorithm, "hash");
    return this.delegate.hashBuffer(algorithm, data);
  }

  hmac(
    algorithm: string,
    key: BinaryInput,
    data: BinaryInput,
    encoding: DigestEncoding = "hex",
  ): string {
    this.assertHash(algorithm, "hmac");
    return this.delegate.hmac(algorithm, key, data, encoding);
  }

  hmacBuffer(algorithm: string, key: BinaryInput, data: BinaryInput): Buffer {
    this.assertHash(algorithm, "hmac");
    return this.delegate.hmacBuffer(algorithm, key, data);
  }

  randomBytes(size: number): Buffer {
    if (size > 0 && size * 8 < FIPS_MIN_KEY_BITS) {
      throw new UnsupportedAlgorithmError(
        `Random output of ${String(size)} bytes is below the FIPS minimum of ` +
          `${String(FIPS_MIN_KEY_BITS)} bits.`,
      );
    }
    return this.delegate.randomBytes(size);
  }

  randomUuid(): string {
    return this.delegate.randomUuid();
  }

  timingSafeEqual(a: BinaryInput, b: BinaryInput): boolean {
    return this.delegate.timingSafeEqual(a, b);
  }

  pbkdf2(options: Pbkdf2Options): Buffer {
    const kdf = isKdfApproved("pbkdf2");
    if (!kdf.approved) {
      throw new UnsupportedAlgorithmError(kdf.reason ?? "PBKDF2 is not approved.");
    }
    this.assertHash(options.digest, "hmac");
    if (options.iterations < FIPS_MIN_PBKDF2_ITERATIONS) {
      throw new UnsupportedAlgorithmError(
        `PBKDF2 iteration count ${String(options.iterations)} is below the FIPS operational ` +
          `minimum of ${String(FIPS_MIN_PBKDF2_ITERATIONS)}.`,
      );
    }
    if (options.keyLength * 8 < FIPS_MIN_KEY_BITS) {
      throw new UnsupportedAlgorithmError(
        `PBKDF2 derived-key length ${String(options.keyLength)} bytes is below the FIPS minimum ` +
          `of ${String(FIPS_MIN_KEY_BITS)} bits.`,
      );
    }
    return this.delegate.pbkdf2(options);
  }

  hkdf(options: HkdfOptions): Buffer {
    const kdf = isKdfApproved("hkdf");
    if (!kdf.approved) {
      throw new UnsupportedAlgorithmError(kdf.reason ?? "HKDF is not approved.");
    }
    this.assertHash(options.digest, "hmac");
    return this.delegate.hkdf(options);
  }

  status(): CryptoProviderStatus {
    return {
      providerId: "node-openssl-fips",
      fipsEnforced: true,
      opensslFipsActive: this.opensslFipsActive,
      selfTestPassed: this.selfTestPassed,
    };
  }
}
