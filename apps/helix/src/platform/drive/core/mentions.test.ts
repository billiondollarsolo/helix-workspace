import { describe, expect, it } from "vitest";
import {
  mentionedActorIds,
  parseMentions,
  mentionTokensForComment,
  normalizeMentionToken,
} from "./mentions.js";

describe("parseMentions", () => {
  it("extracts @tokens from free text", () => {
    expect(parseMentions("hi @maya and @leo!")).toEqual(["maya", "leo"]);
  });

  it("ignores bare @ and empty tokens", () => {
    expect(parseMentions("email me @")).toEqual([]);
  });
});

describe("mentionTokensForComment", () => {
  it("unions metadata mentionsText with body tokens", () => {
    expect(
      mentionTokensForComment({ mentionsText: ["@Avery"] }, "cc @maya"),
    ).toEqual(expect.arrayContaining(["avery", "maya"]));
  });
});

describe("normalizeMentionToken", () => {
  it("strips leading @ and lowercases", () => {
    expect(normalizeMentionToken("@Maya")).toBe("maya");
  });
});

describe("mentionedActorIds", () => {
  it("matches display name and skips the author", () => {
    const ids = mentionedActorIds({
      authorActorId: "a1",
      tokens: ["maya"],
      actors: [
        { id: "a1", display_name: "Author", email: "a@x.io" },
        { id: "a2", display_name: "Maya", email: "maya@x.io" },
      ],
    });
    expect(ids).toEqual(["a2"]);
  });
});
