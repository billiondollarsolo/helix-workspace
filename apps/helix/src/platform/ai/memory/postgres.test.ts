import { describe, expect, it } from "vitest";
import { validateMemoryText, validateRecallLimit, type MemoryEmbeddingProvider } from "./index.js";

describe("Postgres memory store helpers", () => {
  it("validates memory content and recall limits", () => {
    expect(validateMemoryText(" remember this ", "Memory content")).toBe("remember this");
    expect(validateRecallLimit(3)).toBe(3);
    expect(() => validateMemoryText(" ", "Memory content")).toThrow("Memory content is required");
    expect(() => validateRecallLimit(0)).toThrow("positive");
  });

  it("keeps the embedding provider contract typed", async () => {
    const provider: MemoryEmbeddingProvider = {
      async embed(texts) {
        return texts.map((text) => [text.length, 1]);
      },
    };

    await expect(provider.embed(["abc"])).resolves.toEqual([[3, 1]]);
  });
});

