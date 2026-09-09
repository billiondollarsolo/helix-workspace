import { describe, expect, it } from "vitest";
import { assertPluginManifest, validatePluginManifest } from "../src/manifest.js";

describe("plugin manifest policy metadata", () => {
  it("accepts canonical ids, artifact paths, and tier metadata", () => {
    expect(
      assertPluginManifest({
        ...baseManifest(),
        tierRequirements: {
          minTier: "business",
          tierRestrictions: {
            sovereign: "prohibited",
          },
        },
        main: "dist/index.js",
      }),
    ).toMatchObject({
      id: "com.example.plugin",
      main: "dist/index.js",
    });
  });

  it("rejects malformed tier metadata, ids, dependencies, and artifact paths", () => {
    const result = validatePluginManifest({
      ...baseManifest(),
      id: "../plugin",
      main: "../outside.js",
      migrations: "/etc/passwd",
      dependencies: ["notcanonical", { id: "com.example.-bad" }],
      tierRequirements: {
        minTier: "gold",
        tierRestrictions: {
          unknown: true,
          sovereign: 1,
        },
      },
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "$.id",
      "$.dependencies[0]",
      "$.dependencies[1].id",
      "$.main",
      "$.migrations",
      "$.tierRequirements.minTier",
      "$.tierRequirements.tierRestrictions.unknown",
      "$.tierRequirements.tierRestrictions.unknown",
      "$.tierRequirements.tierRestrictions.sovereign",
    ]);
  });
});

function baseManifest(): Record<string, unknown> {
  return {
    id: "com.example.plugin",
    name: "Example Plugin",
    version: "1.0.0",
    sdkVersion: "^1.0.0",
    kind: "sandboxed",
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
