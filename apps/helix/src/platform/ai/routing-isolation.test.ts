import type { LLMProviderCapability } from "@helix/sdk-types";
import { expect, it, vi } from "vitest";
import { AIRouter } from "./routing.js";

it("does not send meeting transcripts to a shared provider when the selected route is unavailable", async () => {
  const chat = vi.fn<LLMProviderCapability["chat"]>();
  for (const primary of ["missing", "cloud"]) {
    const providers = ["cloud", "local"].map((id): LLMProviderCapability => ({
      id,
      protocol: "openai-compatible",
      tags: id === "local" ? ["local-only"] : ["admin-allowlisted"],
      chat,
      models: async () => [],
      countTokens: async () => 0,
    }));
    const router = new AIRouter({
      providers,
      policy: {
        defaultProviderId: "local",
        featureRoutes: {
          "meet.summarize": { primary: { providerId: primary, model: "recap-model" } },
        },
      },
    });
    await expect(
      router.chat(
        { feature: "meet.summarize", messages: [{ role: "user", content: "Private transcript" }] },
        {
          actor: { id: "owner", orgId: "org", type: "user" },
          classification: "restricted",
        },
      ),
    ).rejects.toThrow("No allowed AI provider");
  }
  expect(chat).not.toHaveBeenCalled();
});
