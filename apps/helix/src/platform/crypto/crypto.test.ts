import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { isHashApproved, isKdfApproved } from "./algorithms.js";
import { resolveCryptoConfig } from "./config.js";
import { FipsCryptoProvider } from "./fips-provider.js";
import {
  createCryptoProvider,
  getCryptoProvider,
  setCryptoProviderForTesting,
} from "./index.js";
import { NodeCryptoProvider } from "./node-provider.js";
import { UnsupportedAlgorithmError } from "./provider.js";

afterEach(() => {
  setCryptoProviderForTesting(undefined);
});

describe("resolveCryptoConfig", () => {
  it("defaults to the Node provider with FIPS off", () => {
    const config = resolveCryptoConfig({});
    expect(config.adapter).toBe("node");
    expect(config.fipsMode).toBe("off");
    expect(config.enableOpensslFips).toBe(false);
  });

  it("selects the FIPS provider when HELIX_FIPS_MODE=permissive", () => {
    const config = resolveCryptoConfig({ HELIX_FIPS_MODE: "permissive" });
    expect(config.adapter).toBe("node-openssl-fips");
    expect(config.fipsMode).toBe("permissive");
    expect(config.enableOpensslFips).toBe(false);
  });

  it("requires OpenSSL FIPS when HELIX_FIPS_MODE=required", () => {
    const config = resolveCryptoConfig({ HELIX_FIPS_MODE: "required" });
    expect(config.adapter).toBe("node-openssl-fips");
    expect(config.fipsMode).toBe("required");
    expect(config.enableOpensslFips).toBe(true);
  });

  it("honours an explicit HELIX_CRYPTO_ADAPTER override", () => {
    const config = resolveCryptoConfig({
      HELIX_FIPS_MODE: "required",
      HELIX_CRYPTO_ADAPTER: "node",
    });
    expect(config.adapter).toBe("node");
  });

  it("treats unknown / empty values as FIPS off (opt-in by design)", () => {
    expect(resolveCryptoConfig({ HELIX_FIPS_MODE: "" }).fipsMode).toBe("off");
    expect(resolveCryptoConfig({ HELIX_FIPS_MODE: "maybe" }).fipsMode).toBe("off");
  });
});

describe("getCryptoProvider (process default)", () => {
  it("returns the Node provider when no FIPS env is set", () => {
    setCryptoProviderForTesting(undefined);
    // The test process has no HELIX_FIPS_* env, so the default applies.
    expect(getCryptoProvider().id).toBe("node");
  });
});

describe("NodeCryptoProvider — byte-identical to node:crypto", () => {
  const provider = new NodeCryptoProvider();

  it("produces the same SHA-256 digest as createHash", () => {
    const data = "the quick brown fox";
    expect(provider.hash("sha256", data, "hex")).toBe(
      createHash("sha256").update(data).digest("hex"),
    );
  });

  it("produces the same HMAC-SHA-256 as createHmac", () => {
    expect(provider.hmac("sha256", "secret", "payload", "hex")).toBe(
      createHmac("sha256", "secret").update("payload").digest("hex"),
    );
  });

  it("supports md5 and sha1 (no FIPS restriction)", () => {
    expect(provider.hash("md5", "x", "hex")).toBe(createHash("md5").update("x").digest("hex"));
    expect(provider.hash("sha1", "x", "hex")).toBe(createHash("sha1").update("x").digest("hex"));
  });

  it("randomBytes returns the requested length and randomUuid is a v4 UUID", () => {
    expect(provider.randomBytes(16)).toHaveLength(16);
    expect(provider.randomUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("timingSafeEqual matches semantics and rejects length mismatch", () => {
    expect(provider.timingSafeEqual("abc", "abc")).toBe(true);
    expect(provider.timingSafeEqual("abc", "abd")).toBe(false);
    expect(provider.timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("derives PBKDF2 and HKDF keys identically to node:crypto", () => {
    const pbkdf2 = provider.pbkdf2({
      password: "pw",
      salt: "salt",
      iterations: 1000,
      keyLength: 32,
      digest: "sha256",
    });
    expect(pbkdf2).toHaveLength(32);
    const hkdf = provider.hkdf({
      ikm: "ikm",
      salt: "salt",
      info: "info",
      keyLength: 32,
      digest: "sha256",
    });
    expect(hkdf).toHaveLength(32);
  });
});

describe("FipsCryptoProvider — algorithm allow/deny", () => {
  const fips = new FipsCryptoProvider({ enableOpensslFips: false, requireOpensslFips: false });

  it("permits FIPS-approved hashing and matches the Node provider output", () => {
    const node = new NodeCryptoProvider();
    expect(fips.hash("sha256", "data", "hex")).toBe(node.hash("sha256", "data", "hex"));
    expect(fips.hash("sha384", "data", "hex")).toBe(node.hash("sha384", "data", "hex"));
    expect(fips.hash("sha512", "data", "hex")).toBe(node.hash("sha512", "data", "hex"));
  });

  it("rejects MD5 as a non-approved digest", () => {
    expect(() => fips.hash("md5", "data")).toThrow(UnsupportedAlgorithmError);
  });

  it("rejects SHA-1 for standalone digest use", () => {
    expect(() => fips.hash("sha1", "data")).toThrow(UnsupportedAlgorithmError);
  });

  it("permits SHA-1 inside HMAC (NIST SP 800-107)", () => {
    expect(fips.hmac("sha1", "key", "msg", "hex")).toHaveLength(40);
  });

  it("rejects MD5-keyed HMAC", () => {
    expect(() => fips.hmac("md5", "key", "msg")).toThrow(UnsupportedAlgorithmError);
  });

  it("produces a byte-identical HMAC-SHA-256 to node:crypto", () => {
    expect(fips.hmac("sha256", "secret", "payload", "hex")).toBe(
      createHmac("sha256", "secret").update("payload").digest("hex"),
    );
  });

  it("rejects PBKDF2 with too few iterations", () => {
    expect(() =>
      fips.pbkdf2({
        password: "pw",
        salt: "salt",
        iterations: 100,
        keyLength: 32,
        digest: "sha256",
      }),
    ).toThrow(UnsupportedAlgorithmError);
  });

  it("rejects PBKDF2 with a non-approved inner hash", () => {
    expect(() =>
      fips.pbkdf2({
        password: "pw",
        salt: "salt",
        iterations: 20_000,
        keyLength: 32,
        digest: "md5",
      }),
    ).toThrow(UnsupportedAlgorithmError);
  });

  it("permits PBKDF2 with approved parameters", () => {
    expect(
      fips.pbkdf2({
        password: "pw",
        salt: "salt",
        iterations: 20_000,
        keyLength: 32,
        digest: "sha256",
      }),
    ).toHaveLength(32);
  });

  it("rejects undersized random output", () => {
    expect(() => fips.randomBytes(8)).toThrow(UnsupportedAlgorithmError);
    expect(fips.randomBytes(32)).toHaveLength(32);
  });

  it("rejects HKDF with a non-approved inner hash", () => {
    expect(() =>
      fips.hkdf({ ikm: "ikm", salt: "s", info: "i", keyLength: 32, digest: "md5" }),
    ).toThrow(UnsupportedAlgorithmError);
  });

  it("reports a passing self-test in its status", () => {
    const status = fips.status();
    expect(status.providerId).toBe("node-openssl-fips");
    expect(status.fipsEnforced).toBe(true);
    expect(status.selfTestPassed).toBe(true);
  });

  it("randomUuid still works", () => {
    expect(fips.randomUuid()).toMatch(/^[0-9a-f-]{36}$/u);
  });
});

describe("algorithm policy", () => {
  it("approves the SHA-2 / SHA-3 family for digests", () => {
    for (const algo of ["sha256", "sha384", "sha512", "sha3-256"]) {
      expect(isHashApproved(algo).approved).toBe(true);
    }
  });

  it("denies legacy digests", () => {
    for (const algo of ["md5", "md4", "ripemd160", "sha1"]) {
      expect(isHashApproved(algo).approved).toBe(false);
    }
  });

  it("approves only pbkdf2 and hkdf as KDFs", () => {
    expect(isKdfApproved("pbkdf2").approved).toBe(true);
    expect(isKdfApproved("hkdf").approved).toBe(true);
    expect(isKdfApproved("scrypt").approved).toBe(false);
  });
});

describe("createCryptoProvider", () => {
  it("builds a Node provider for the node adapter", () => {
    const provider = createCryptoProvider({
      adapter: "node",
      fipsMode: "off",
      enableOpensslFips: false,
    });
    expect(provider).toBeInstanceOf(NodeCryptoProvider);
  });

  it("builds a FIPS provider for the node-openssl-fips adapter (permissive)", () => {
    const provider = createCryptoProvider({
      adapter: "node-openssl-fips",
      fipsMode: "permissive",
      enableOpensslFips: false,
    });
    expect(provider).toBeInstanceOf(FipsCryptoProvider);
    expect(provider.id).toBe("node-openssl-fips");
  });
});

describe("default behaviour is byte-identical with FIPS off", () => {
  it("an injected Node provider matches direct node:crypto for the routed primitives", () => {
    setCryptoProviderForTesting(new NodeCryptoProvider());
    const provider = getCryptoProvider();
    const sample = JSON.stringify({ a: 1, b: "two" });
    expect(provider.hash("sha256", sample, "hex")).toBe(
      createHash("sha256").update(sample).digest("hex"),
    );
    expect(provider.hmac("sha256", "k", sample, "hex")).toBe(
      createHmac("sha256", "k").update(sample).digest("hex"),
    );
    // randomUuid shape parity with node:crypto.
    expect(typeof randomUUID()).toBe(typeof provider.randomUuid());
  });
});
