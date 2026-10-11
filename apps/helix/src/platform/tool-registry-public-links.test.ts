import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createToolRegistry, featureFlagForTool } from "./tool-registry.js";

const schema = {
  parse: (value: unknown) => value,
  toJsonSchema: () => ({ type: "object" }),
};

const actor: Actor = {
  id: "actor-1",
  orgId: "org-1",
  type: "agent",
  scopes: ["platform.read"],
};

/* Helix has no plans (ADR-0030): public share links used to sit behind the
   `b2b_sharing` plan entitlement. Permission checks still apply; no tenant
   feature flag does. */
describe("drive.link.create", () => {
  it("has no tenant feature flag", () => {
    expect(featureFlagForTool({ id: "drive.link.create" })).toBeUndefined();
  });

  it("stays visible and invocable even when every tenant flag reads false", async () => {
    const evaluations: string[] = [];
    const registry = createToolRegistry({
      featureFlags: {
        get: (_key, _defaultValue) => false as typeof _defaultValue,
        async getAsync<T>(key: string) {
          evaluations.push(key);
          return false as T;
        },
      },
    });
    registry.register({
      id: "drive.link.create",
      description: "drive.link.create",
      permission: "platform.read",
      sideEffects: "read",
      inputSchema: schema,
      outputSchema: schema,
      handler: async () => ({ created: true }),
    });

    await expect(registry.listVisible(actor)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "drive.link.create" })]),
    );
    await expect(registry.invoke("drive.link.create", {}, { actor })).resolves.toMatchObject({
      ok: true,
      output: { created: true },
    });
    expect(evaluations).not.toContain("b2b_sharing");
  });
});
