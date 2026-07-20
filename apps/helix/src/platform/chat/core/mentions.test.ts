import { describe, expect, it } from "vitest";
import { memberHandleResolver, parseMentions } from "./mentions.js";

describe("parseMentions", () => {
  const resolve = (handle: string): string | null => {
    if (handle === "alice") return "a1";
    if (handle === "bob") return "b2";
    return null;
  };

  it("parses @alice @bob to their ids", () => {
    expect(parseMentions("hey @alice and @bob", resolve)).toEqual(["a1", "b2"]);
  });

  it("ignores email addresses", () => {
    expect(parseMentions("email me at alice@x.com please", resolve)).toEqual([]);
  });

  it("dedupes repeated mentions", () => {
    expect(parseMentions("@alice hi @alice", resolve)).toEqual(["a1"]);
  });

  it("handles @here and @channel as sentinels", () => {
    expect(parseMentions("@here team, @channel", resolve)).toEqual(["@here", "@channel"]);
  });

  it("resolves unknown handles to nothing", () => {
    expect(parseMentions("hi @nobody", resolve)).toEqual([]);
  });
});

describe("memberHandleResolver", () => {
  it("resolves by email local-part and display name", () => {
    const resolve = memberHandleResolver([
      {
        actorId: "a1",
        displayName: "Alice Wonder",
        email: "alice@example.com",
      },
      {
        actorId: "b2",
        displayName: "Bob",
        email: null,
      },
    ]);
    expect(resolve("alice")).toBe("a1");
    expect(resolve("alice.wonder")).toBe("a1");
    expect(resolve("bob")).toBe("b2");
    expect(resolve("missing")).toBeNull();
  });
});
