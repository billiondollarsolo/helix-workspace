import { describe, expect, it } from "vitest";
import { answersFromMetadata, askUserResult } from "./ask-user.js";

describe("ask.user answers", () => {
  it("copies bounded string and boolean answers from approve metadata", () => {
    expect(
      answersFromMetadata({
        answers: { zip: "20882", ok: true, nested: { x: 1 }, long: "a".repeat(2_001) },
      }),
    ).toEqual({ zip: "20882", ok: true, long: "a".repeat(2_000) });
    expect(answersFromMetadata({ zip: "20882" })).toEqual({ zip: "20882" });
    expect(askUserResult("memory.add", { saved: true }, { zip: "20882" })).toEqual({ saved: true });
    expect(askUserResult("ask.user", { question: "ZIP?" }, { answers: { zip: "20882" } })).toEqual({
      question: "ZIP?",
      answers: { zip: "20882" },
    });
  });
});
