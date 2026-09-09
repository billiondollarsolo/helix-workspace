import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  pluginCatalogPayloadBytes,
  verifyPluginArtifactSignature,
  verifyPluginCatalog,
  type PluginCatalogEntry,
  type PluginCatalogPayload,
  type PluginTrustOptions,
} from "./trust.js";

const now = new Date("2026-09-02T12:00:00.000Z");

describe("signed plugin catalog", () => {
  it("verifies an Ed25519 signature from an explicitly trusted key", () => {
    expect(verifyPluginCatalog(signedTrust())?.plugins[0]).toMatchObject({
      id: "com.example.plugin",
      version: "1.0.0",
    });
  });

  it("rejects forged payloads, attacker keys, expiry, and revoked keys", () => {
    const trusted = signedTrust();
    const catalogEntry = trusted.catalog.payload.plugins[0];
    if (catalogEntry === undefined) throw new Error("test catalog entry is missing");
    const forged = {
      ...trusted,
      catalog: {
        ...trusted.catalog,
        payload: {
          ...trusted.catalog.payload,
          plugins: [{ ...catalogEntry, bundleDigest: digest("b") }],
        },
      },
    };
    expect(() => verifyPluginCatalog(forged)).toThrow("signature verification failed");

    const attacker = signedTrust("attacker-catalog");
    expect(() =>
      verifyPluginCatalog({
        ...attacker,
        trustedCatalogKeys: trusted.trustedCatalogKeys,
      }),
    ).toThrow("not trusted");
    expect(() =>
      verifyPluginCatalog({ ...trusted, revokedKeyIds: [trusted.catalog.keyId] }),
    ).toThrow("revoked");
    expect(() =>
      verifyPluginCatalog({
        ...trusted,
        now: () => new Date("2026-09-04T00:00:00.000Z"),
      }),
    ).toThrow("expired");
  });

  it("requires the pinned Sigstore publisher, exact identity, and transparency verification", async () => {
    const trust = signedTrust();
    const entry = trust.catalog.payload.plugins[0];
    if (entry === undefined) throw new Error("test catalog entry is missing");

    await expect(verifyPluginArtifactSignature(entry, entry.bundleDigest, trust)).resolves.toBe(
      undefined,
    );
    await expect(verifyPluginArtifactSignature(entry, digest("b"), trust)).rejects.toThrow(
      "bundle digest mismatch",
    );
    await expect(
      verifyPluginArtifactSignature(entry, entry.bundleDigest, {
        ...trust,
        revokedPublishers: [entry.publisher],
      }),
    ).rejects.toThrow("revoked");
    await expect(
      verifyPluginArtifactSignature({ ...entry, publisher: "attacker" }, entry.bundleDigest, trust),
    ).rejects.toThrow("not trusted");
    await expect(
      verifyPluginArtifactSignature(
        { ...entry, sigstoreBundle: fakeSigstoreBundle(digest("c")) },
        entry.bundleDigest,
        trust,
      ),
    ).rejects.toThrow("Sigstore verification failed");
  });
});

function signedTrust(keyId = "catalog-test"): PluginTrustOptions {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payload: PluginCatalogPayload = {
    version: 1,
    issuedAt: "2026-09-02T00:00:00.000Z",
    expiresAt: "2026-09-03T00:00:00.000Z",
    plugins: [catalogEntry("com.example.plugin", "1.0.0", digest("a"))],
  };
  return {
    catalog: {
      keyId,
      payload,
      signature: sign(null, pluginCatalogPayloadBytes(payload), privateKey).toString("base64"),
    },
    trustedCatalogKeys: {
      [keyId]: publicKey.export({ format: "pem", type: "spki" }).toString(),
    },
    trustedPublishers: {
      "helix-release": {
        issuer: "https://token.actions.githubusercontent.com",
        uri: "https://github.com/helix/workspace/.github/workflows/release.yml@refs/heads/main",
      },
    },
    createBundleVerifier: async (options) => {
      expect(options).toMatchObject({
        certificateIssuer: "https://token.actions.githubusercontent.com/",
        certificateIdentityURI:
          "^https://github\\.com/helix/workspace/\\.github/workflows/release\\.yml@refs/heads/main$",
        ctLogThreshold: 1,
        tlogThreshold: 1,
      });
      return {
        verify(bundle, data) {
          const marker = (bundle as unknown as { readonly testDigest?: string }).testDigest;
          if (marker !== data?.toString("utf8")) throw new Error("invalid test proof");
          return {} as never;
        },
      };
    },
    now: () => now,
  };
}

function catalogEntry(id: string, version: string, bundleDigest: string): PluginCatalogEntry {
  return {
    id,
    version,
    bundleDigest,
    publisher: "helix-release",
    sigstoreBundle: fakeSigstoreBundle(bundleDigest),
  };
}

function fakeSigstoreBundle(bundleDigest: string): PluginCatalogEntry["sigstoreBundle"] {
  return { testDigest: bundleDigest } as unknown as PluginCatalogEntry["sigstoreBundle"];
}

function digest(char: string): string {
  return `sha256:${char.repeat(64)}`;
}
