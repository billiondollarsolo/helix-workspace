import { describe, expect, it } from "vitest";
import { assertContentFreeAudit } from "./audit.js";

describe("Chat compliance audit", () => {
  it("allows identifiers and policy values", () => {
    expect(() => {
      assertContentFreeAudit({
        roomId: "room",
        messageId: "message",
        retentionDays: 30,
        legalHold: false,
      });
    }).not.toThrow();
  });

  it.each(["body", "messageBody", "content", "renderedHtml", "markdown", "plainText"])(
    "rejects content-bearing audit key %s",
    (key) => {
      expect(() => {
        assertContentFreeAudit({ nested: { [key]: "secret" } });
      }).toThrow("cannot contain content");
    },
  );
});
