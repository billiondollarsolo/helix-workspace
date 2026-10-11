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
    expect(flags.get("mail_outbound", false)).toBe(false);
    await expect(flags.getAsync("mail_outbound", false)).resolves.toBe(false);
  });

  it("delegates sync and async evaluation to the configured provider", async () => {
    const provider = new StaticFeatureFlagProvider(
      new Map<string, unknown>([
        ["mail_outbound", true],
        ["calendar_import_invitations", true],
      ]),
    );

    flags.setProvider(provider);

    expect(flags.get("mail_outbound", false)).toBe(true);
    await expect(flags.getAsync("calendar_import_invitations", false)).resolves.toBe(true);
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

    await flags.getAsync("assistant_retrieval", true, {
      orgId: "org-1",
      actorId: "actor-1",
      environment: "test",
    });

    expect(seen).toEqual([
      {
        key: "assistant_retrieval",
        context: { orgId: "org-1", actorId: "actor-1", environment: "test" },
      },
    ]);
  });
});

describe("coerceFlagValue", () => {
  it("keeps default value type stable", () => {
    expect(coerceFlagValue(true, false)).toBe(true);
    expect(coerceFlagValue("yes", false)).toBe(false);
    expect(coerceFlagValue("block", "off")).toBe("block");
    expect(coerceFlagValue(25, 10)).toBe(25);
    expect(coerceFlagValue("25", 10)).toBe(10);
  });
});
