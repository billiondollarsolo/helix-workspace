/**
 * The default crypto provider — a thin, behaviour-preserving wrapper over
 * `node:crypto`.
 *
 * This is the provider used by every standard Helix deployment (`docker
 * compose up`, the default Helm install). It applies NO algorithm restrictions
 * and performs NO FIPS toolchain work, so output is byte-identical to calling
 * `node:crypto` directly. FIPS is a separate, opt-in profile (see
 * {@link FipsCryptoProvider}).
 */

import {
  createHash,
  createHmac,
  getFips,
  hkdfSync,
  pbkdf2Sync,
  randomBytes as nodeRandomBytes,
  randomUUID,
  timingSafeEqual as nodeTimingSafeEqual,
} from "node:crypto";
import type {
  BinaryInput,
  CryptoProvider,
  CryptoProviderStatus,
  DigestEncoding,
  HkdfOptions,
  Pbkdf2Options,
} from "./provider.js";

/** Convert {@link BinaryInput} to a value `crypto` `.update()` accepts. */
export function toUpdatable(input: BinaryInput): Buffer | string {
  return typeof input === "string" ? input : Buffer.from(input);
}

function toBuffer(input: BinaryInput): Buffer {
  return typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
}

export class NodeCryptoProvider implements CryptoProvider {
  readonly id = "node" as const;

  hash(algorithm: string, data: BinaryInput, encoding: DigestEncoding = "hex"): string {
    return createHash(algorithm).update(toUpdatable(data)).digest(encoding);
  }

  hashBuffer(algorithm: string, data: BinaryInput): Buffer {
    return createHash(algorithm).update(toUpdatable(data)).digest();
  }

  hmac(
    algorithm: string,
    key: BinaryInput,
    data: BinaryInput,
    encoding: DigestEncoding = "hex",
  ): string {
    return createHmac(algorithm, toUpdatable(key)).update(toUpdatable(data)).digest(encoding);
  }

  hmacBuffer(algorithm: string, key: BinaryInput, data: BinaryInput): Buffer {
    return createHmac(algorithm, toUpdatable(key)).update(toUpdatable(data)).digest();
  }

  randomBytes(size: number): Buffer {
    return nodeRandomBytes(size);
  }

  randomUuid(): string {
    return randomUUID();
  }

  timingSafeEqual(a: BinaryInput, b: BinaryInput): boolean {
    const left = toBuffer(a);
    const right = toBuffer(b);
    if (left.length !== right.length) {
      return false;
    }
    return nodeTimingSafeEqual(left, right);
  }

  pbkdf2(options: Pbkdf2Options): Buffer {
    return pbkdf2Sync(
      toUpdatable(options.password),
      toUpdatable(options.salt),
      options.iterations,
      options.keyLength,
      options.digest,
    );
  }

  hkdf(options: HkdfOptions): Buffer {
    const derived = hkdfSync(
      options.digest,
      toBuffer(options.ikm),
      toBuffer(options.salt),
      toBuffer(options.info),
      options.keyLength,
    );
    return Buffer.from(derived);
  }

  status(): CryptoProviderStatus {
    return {
      providerId: "node",
      fipsEnforced: false,
      opensslFipsActive: readOpensslFips(),
      selfTestPassed: true,
    };
  }
}

/** Read `crypto.getFips()` defensively — it can throw on some builds. */
export function readOpensslFips(): boolean {
  try {
    return getFips() !== 0;
  } catch {
    return false;
  }
}
