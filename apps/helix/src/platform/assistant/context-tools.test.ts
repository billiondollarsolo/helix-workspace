import { describe, expect, it } from "vitest";
import { grepSources, pageSource } from "./context-tools.js";
import type { AssistantSource } from "./types.js";

const source: AssistantSource = {
  id: "src-1",
  type: "drive",
  trust: "untrusted_retrieved",
  classification: "standard",
  title: "notes.txt",
  body: "alpha\nGaithersburg forecast\nomega ".repeat(80),
  provenance: { sourceId: "src-1", sourceType: "drive", orgId: "org" },
};

describe("assistant context view/grep", () => {
  it("pages a source body and continues from nextOffset", () => {
    const first = pageSource([source], "src-1", 0, 40);
    expect(first.content.length).toBe(40);
    expect(first.nextOffset).toBe(40);
    const next = pageSource([source], "src-1", first.nextOffset ?? 0, 40);
    expect(next.offset).toBe(40);
    expect(next.content.length).toBeGreaterThan(0);
  });

  it("greps matching lines and rejects unknown sources", () => {
    expect(grepSources([source], "Gaithersburg")[0]?.line).toBe(2);
    expect(() => pageSource([source], "missing")).toThrow("not in the current turn");
  });
});
