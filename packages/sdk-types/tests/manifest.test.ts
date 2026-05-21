import { describe, expect, it } from "vitest";
import { assertPluginManifest, validatePluginManifest } from "../src/manifest.js";

describe("plugin manifest policy metadata", () => {
  it("accepts signed tier metadata", () => {
    expect(
      assertPluginManifest({
        ...baseManifest(),
        tierRequirements: {
          minTier: "business",
          tierRestrictions: {
            sovereign: "prohibited",
          },
        },
        signature: {
          bundleDigest: validDigest(),
          signerIdentity: "https://issuer.example/helix-builder",
          signedAt: "2026-05-20T12:00:00Z",
        },
      }),
    ).toMatchObject({
      id: "com.example.plugin",
      signature: { bundleDigest: validDigest() },
    });
  });

  it("rejects malformed tier and signature metadata", () => {
    const result = validatePluginManifest({
      ...baseManifest(),
      tierRequirements: {
        minTier: "gold",
        tierRestrictions: {
          unknown: true,
          sovereign: 1,
        },
      },
      signature: {
        bundleDigest: 123,
        signerIdentity: "not a signer",
        signedAt: "not a date",
      },
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "$.tierRequirements.minTier",
      "$.tierRequirements.tierRestrictions.unknown",
      "$.tierRequirements.tierRestrictions.unknown",
      "$.tierRequirements.tierRestrictions.sovereign",
      "$.signature.bundleDigest",
      "$.signature.signerIdentity",
      "$.signature.signedAt",
    ]);
  });
});

function validDigest(): string {
  return `sha256:${"a".repeat(64)}`;
}

function baseManifest(): Record<string, unknown> {
  return {
    id: "com.example.plugin",
    name: "Example Plugin",
    version: "1.0.0",
    sdkVersion: "^1.0.0",
    kind: "in-process",
    capabilities: {
      provides: [],
      consumes: [],
    },
    permissions: {
      scopes: [],
      "outbound-network": [],
      filesystem: [],
      envVars: [],
    },
  };
}
