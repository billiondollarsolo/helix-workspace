import { describe, expect, it } from "vitest";
import { chatMutationAllowed, chatRetentionEligible } from "./compliance-policy.js";

const now = new Date("2026-07-28T12:00:00.000Z");

describe("Chat compliance policy", () => {
  it("uses an inclusive mutation-window cutoff", () => {
    expect(
      chatMutationAllowed({
        legalHold: false,
        windowSeconds: 60,
        sentAt: new Date(now.getTime() - 60_000),
        now,
      }),
    ).toBe(true);
    expect(
      chatMutationAllowed({
        legalHold: false,
        windowSeconds: 60,
        sentAt: new Date(now.getTime() - 60_001),
        now,
      }),
    ).toBe(false);
  });

  it("blocks mutation and retention deletion under legal hold", () => {
    expect(chatMutationAllowed({ legalHold: true, windowSeconds: 3600, sentAt: now, now })).toBe(
      false,
    );
    expect(
      chatRetentionEligible({
        legalHold: true,
        retentionDays: 1,
        sentAt: new Date("2020-01-01T00:00:00.000Z"),
        now,
      }),
    ).toBe(false);
  });

  it("deletes only strictly older messages at the retention cutoff", () => {
    expect(
      chatRetentionEligible({
        legalHold: false,
        retentionDays: 30,
        sentAt: new Date(now.getTime() - 30 * 86_400_000),
        now,
      }),
    ).toBe(false);
    expect(
      chatRetentionEligible({
        legalHold: false,
        retentionDays: 30,
        sentAt: new Date(now.getTime() - 30 * 86_400_000 - 1),
        now,
      }),
    ).toBe(true);
  });
});
