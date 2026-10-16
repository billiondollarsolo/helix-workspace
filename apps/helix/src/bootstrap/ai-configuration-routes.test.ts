import type { HelixConfig } from "@helix/sdk-types";
import { expect, it, vi } from "vitest";
import { registerAiConfigurationRoutes } from "./ai-configuration-routes.js";

const captured = vi.hoisted(() => ({
  validate: undefined as ((config: HelixConfig) => void) | undefined,
}));
vi.mock("../platform/config/admin.js", () => ({
  registerPlatformConfigAdminRoutes: (
    _app: unknown,
    options: { validateConfig: (config: HelixConfig) => void },
  ) => {
    captured.validate = options.validateConfig;
    return Promise.resolve();
  },
}));
vi.mock("../platform/config/ai-retrieval-routes.js", () => ({
  registerAiRetrievalRoutes: () => Promise.resolve(),
}));

it("validates provider residency before an administrator's configuration can be persisted", async () => {
  const assertRuntimeResidency = vi.fn<(config: HelixConfig) => void>(() => {
    throw new Error("Region mismatch");
  });
  const context = {
    app: {},
    platformConfig: {},
    actorFromAuthenticatedRequest: vi.fn(),
    runtimeConfiguration: { current: {} },
    semanticSearchRuntime: { validate: vi.fn() },
    assertRuntimeResidency,
  };
  await registerAiConfigurationRoutes(
    context as unknown as Parameters<typeof registerAiConfigurationRoutes>[0],
  );
  const validate = captured.validate;
  if (validate === undefined) throw new Error("Config validation was not registered");
  const config: HelixConfig = { security: { tier: "business" }, ai: { enabled: true } };
  expect(() => {
    validate(config);
  }).toThrow(/violates deployment residency/u);
  expect(assertRuntimeResidency).toHaveBeenCalledWith(config);
  assertRuntimeResidency.mockImplementation(() => undefined);
  expect(() => {
    validate(config);
  }).not.toThrow();
});
