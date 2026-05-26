import { afterEach, describe, expect, it } from "vitest";
import {
  StaticFeatureFlagProvider,
  coerceFlagValue,
  flags,
  type FeatureFlagProvider,
} from "../src/feature-flags.js";

describe("feature flag client", () => {
  afterEach(() => {
    flags.resetProvider();
  });

  it("returns defaults before a provider is configured", async () => {
    expect(flags.get("ai_smart_compose", false)).toBe(false);
    await expect(flags.getAsync("ai_smart_compose", false)).resolves.toBe(false);
  });

  it("delegates sync and async evaluation to the configured provider", async () => {
    const provider = new StaticFeatureFlagProvider(
      new Map<string, unknown>([
        ["ai_smart_compose", true],
        ["support_tier", "premium-4h"],
      ]),
    );

    flags.setProvider(provider);

    expect(flags.get("ai_smart_compose", false)).toBe(true);
    await expect(flags.getAsync("support_tier", "community")).resolves.toBe("premium-4h");
  });

  it("passes evaluation context to providers", async () => {
    const seen: unknown[] = [];
    const provider: FeatureFlagProvider = {
      get(key, defaultValue, context) {
        seen.push({ key, context });
        return defaultValue;
      },
      async getAsync(key, defaultValue, context) {
        seen.push({ key, context });
        return defaultValue;
      },
    };
    flags.setProvider(provider);

    await flags.getAsync("editors_native_document", true, {
      orgId: "org-1",
      actorId: "actor-1",
      environment: "test",
    });

    expect(seen).toEqual([
      {
        key: "editors_native_document",
        context: { orgId: "org-1", actorId: "actor-1", environment: "test" },
      },
    ]);
  });
});

describe("coerceFlagValue", () => {
  it("keeps default value type stable", () => {
    expect(coerceFlagValue(true, false)).toBe(true);
    expect(coerceFlagValue("yes", false)).toBe(false);
    expect(coerceFlagValue("premium-4h", "community")).toBe("premium-4h");
    expect(coerceFlagValue(25, 10)).toBe(25);
    expect(coerceFlagValue("25", 10)).toBe(10);
  });
});
