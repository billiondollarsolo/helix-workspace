import { describe, expect, it } from "vitest";
import { pendingMailReviewSchema } from "./actions.js";

describe("pending email review contract", () => {
  it("keeps the concrete email and strips unrelated or credential material", () => {
    const review = pendingMailReviewSchema.parse({
      from: { address: "atlas@example.test", name: "Atlas" },
      to: [{ address: "mike@example.test" }],
      subject: "Please review",
      bodyText: "The exact message",
      idempotencyKey: "private-key",
      metadata: { secret: "must-not-leak" },
    });
    expect(review).toMatchObject({
      subject: "Please review",
      bodyText: "The exact message",
      cc: [],
      bcc: [],
      attachments: [],
    });
    expect(JSON.stringify(review)).not.toContain("private-key");
    expect(JSON.stringify(review)).not.toContain("must-not-leak");
  });
  it("rejects a missing recipient and malformed mail fields", () => {
    expect(pendingMailReviewSchema.safeParse({ to: [], subject: "", bodyText: "" }).success).toBe(
      false,
    );
    expect(
      pendingMailReviewSchema.safeParse({ to: [{ address: "invalid" }], subject: "", bodyText: "" })
        .success,
    ).toBe(false);
  });
});
