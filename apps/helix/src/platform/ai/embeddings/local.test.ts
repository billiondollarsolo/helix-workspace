import { describe, expect, it } from "vitest";
import { cosineSimilarity } from "../../assistant/attachment-retrieval.js";
import { createLocalEmbeddingProvider } from "./local.js";
import { createSemanticSearchEmbeddingProvider } from "../providers/factory.js";

describe("local embedding provider", () => {
  it("ranks overlapping tokens without an embeddings API", async () => {
    const provider = createLocalEmbeddingProvider();
    const [query, zip, weather] = await provider.embed([
      "What ZIP is Atlas in?",
      "The Atlas ZIP code is 20882.",
      "Weekend weather is sunny and warm.",
    ]);
    expect(cosineSimilarity(query ?? [], zip ?? [])).toBeGreaterThan(
      cosineSimilarity(query ?? [], weather ?? []),
    );
    expect(createSemanticSearchEmbeddingProvider(undefined, {})).toBeDefined();
    expect(
      createSemanticSearchEmbeddingProvider(undefined, { HELIX_LOCAL_EMBEDDINGS: "false" }),
    ).toBeUndefined();
  });
});
