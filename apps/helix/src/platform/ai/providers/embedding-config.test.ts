import { describe, expect, it } from "vitest";
import { createSemanticSearchEmbeddingProvider } from "./factory.js";

describe("workspace embedding configuration", () => {
  it("supports semantic dimensions independently and preserves explicit credential clearing", async () => {
    let headers: HeadersInit | undefined;
    const provider = createSemanticSearchEmbeddingProvider(
      {
        embeddingProvider: {
          plugin: "openai-compatible",
          config: {
            baseUrl: "https://embedding.example.test/v1",
            model: "small",
            dimensions: 384,
            apiKey: "",
            apiKeyEnv: "OLD_KEY",
          },
        },
      },
      { OLD_KEY: "must-not-return" },
      async (_input, init) => {
        headers = init?.headers;
        return Response.json({
          data: [{ index: 0, embedding: Array.from({ length: 384 }, () => 1) }],
        });
      },
    );
    expect((await provider?.embed(["source"]))?.[0]).toHaveLength(384);
    expect(new Headers(headers).has("authorization")).toBe(false);
  });
});
