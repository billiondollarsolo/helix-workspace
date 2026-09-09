import { describe, expect, it } from "vitest";
import { mailSearchHitMatchesOperators, parseMailSearchQuery } from "./search-query.js";

describe("parseMailSearchQuery (M13)", () => {
  it("parses from/to/subject/has/is operators and free text", () => {
    const parsed = parseMailSearchQuery(
      'invoice from:alice@example.com to:bob@helix.test subject:"Q1 report" has:attachment is:unread remaining words',
    );
    expect(parsed.from).toEqual(["alice@example.com"]);
    expect(parsed.to).toEqual(["bob@helix.test"]);
    expect(parsed.subject).toEqual(["q1 report"]);
    expect(parsed.hasAttachment).toBe(true);
    expect(parsed.isUnread).toBe(true);
    expect(parsed.freeText).toBe("invoice remaining words");
    expect(parsed.operators).toEqual(
      expect.arrayContaining([
        "from:alice@example.com",
        "to:bob@helix.test",
        "subject:Q1 report",
        "has:attachment",
        "is:unread",
      ]),
    );
  });

  it("returns empty structure for blank queries", () => {
    expect(parseMailSearchQuery("   ")).toMatchObject({
      freeText: "",
      from: [],
      operators: [],
    });
  });
});

describe("mailSearchHitMatchesOperators", () => {
  const base = {
    subject: "Q1 report invoice",
    from: { address: "alice@example.com", name: "Alice" },
    to: [{ address: "bob@helix.test" }],
    hasAttachment: true,
    unread: true,
    starred: false,
  };

  it("accepts hits that satisfy every operator", () => {
    const parsed = parseMailSearchQuery("from:alice subject:report has:attachment is:unread");
    expect(mailSearchHitMatchesOperators(base, parsed)).toBe(true);
  });

  it("rejects cross-operator mismatches (negative)", () => {
    const parsed = parseMailSearchQuery("from:eve@evil.example is:starred");
    expect(mailSearchHitMatchesOperators(base, parsed)).toBe(false);
  });
});
