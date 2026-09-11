import { describe, expect, it } from "vitest";
import { cosineSimilarity, sourcesForPrompt } from "./attachment-retrieval.js";
import type { AssistantSource } from "./types.js";

const source = (body: string): AssistantSource => ({
  id: "note",
  type: "drive.attachment",
  trust: "untrusted_retrieved",
  classification: "standard",
  title: "notes.txt",
  body,
  provenance: { sourceId: "note", sourceType: "drive.attachment", orgId: "org" },
});

describe("assistant attachment retrieval", () => {
  it("ranks cosine similar chunks into the prompt excerpt", async () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    const intro = "Weather overview and weekend plans. ".repeat(200);
    const zip = "The Atlas ZIP code is 20882 and should be used for the forecast.";
    const prepared = await sourcesForPrompt(
      [source(`${intro}\n${zip}`)],
      [{ role: "user", content: "What ZIP is Atlas in?" }],
      async (texts) =>
        texts.map((text) => (text.includes("20882") || text.includes("ZIP") ? [1, 0] : [0, 1])),
    );
    expect(prepared[0]?.body).toContain("20882");
    expect(prepared[0]?.body?.length).toBeLessThan(intro.length);
  });

  it("truncates long attachments when embeddings are unavailable", async () => {
    const body = "alpha ".repeat(5_000);
    const prepared = await sourcesForPrompt(
      [source(body)],
      [{ role: "user", content: "summarize" }],
    );
    expect(prepared[0]?.body?.length).toBeLessThanOrEqual(4_000);
    expect(prepared[0]?.body?.startsWith("alpha")).toBe(true);
  });
});
