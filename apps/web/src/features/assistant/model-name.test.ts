import { describe, expect, it } from "vitest";
import { assistantModelName, assistantModelNames, humanizeModelId } from "./model-name";

describe("assistant model names", () => {
  it("humanizes raw model ids", () => {
    expect(humanizeModelId("helix-e2e-model")).toBe("Helix E2E Model");
    expect(humanizeModelId("claude-sonnet-4-5-20250929")).toBe("Claude Sonnet 4.5");
    expect(humanizeModelId("gpt-4o-mini")).toBe("GPT-4o Mini");
    expect(humanizeModelId("meta-llama/llama3.1:8b")).toBe("Llama3.1 8B");
    expect(humanizeModelId("mistral-large-latest")).toBe("Mistral Large");
  });

  it("prefers the provider's configured display name", () => {
    expect(
      assistantModelName({
        id: "work/gpt-4o",
        label: "Work models · Fast drafting",
        providerId: "work",
        model: "gpt-4o",
      }),
    ).toBe("Fast drafting");
    expect(
      assistantModelName({
        id: "openai-compatible.default/helix-e2e-model",
        label: "openai-compatible.default · helix-e2e-model",
        providerId: "openai-compatible.default",
        model: "helix-e2e-model",
      }),
    ).toBe("Helix E2E Model");
  });

  it("adds the provider when two models share a name", () => {
    const names = assistantModelNames([
      { id: "a/gpt-4o", label: "Azure · gpt-4o", providerId: "a", model: "gpt-4o" },
      { id: "b/gpt-4o", label: "OpenAI · gpt-4o", providerId: "b", model: "gpt-4o" },
    ]);
    expect([...names.values()]).toEqual(["GPT-4o (Azure)", "GPT-4o (OpenAI)"]);
  });
});
