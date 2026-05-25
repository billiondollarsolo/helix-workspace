import { describe, expect, it } from "vitest";
import { generatePresentationDeck } from "./presentation-ai";

describe("presentation assist", () => {
  it("generates a deterministic native deck plan from a prompt", () => {
    const first = generatePresentationDeck("enterprise launch; customer proof; rollout risks");
    const second = generatePresentationDeck("enterprise launch; customer proof; rollout risks");

    expect(second).toEqual(first);
    expect(first.title).toBe("Enterprise Launch Customer Proof Rollout Risks");
    expect(first.slides).toHaveLength(6);
    expect(first.slides.map((slide) => slide.content.layout)).toEqual([
      "title",
      "agenda",
      "bullets",
      "stats",
      "split",
      "bullets",
    ]);
    expect(first.slides[1]?.content).toMatchObject({
      layout: "agenda",
      items: ["Enterprise Launch", "Customer Proof", "Rollout Risks"],
    });
  });
});
