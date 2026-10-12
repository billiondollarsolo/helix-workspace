import { describe, expect, it } from "vitest";
import { resolveDecisionModelConfig } from "./config.js";
import { confusion, summarizeDecisionReport } from "./report.js";

const config = resolveDecisionModelConfig({ mode: "shadow", provider: "typesafe" });

function labelled(
  id: number,
  proposed: string,
  label: "spam" | "ham",
  spamAssassin: boolean | null = null,
) {
  return {
    message_id: `m${String(id)}`,
    sender_domain: "example.test",
    verdict: proposed === "none" ? "legitimate" : "spam",
    verdict_confidence: 0.95,
    proposed_action: proposed,
    spamassassin_is_spam: spamAssassin,
    label,
    created_at: new Date(Date.UTC(2026, 9, 12, 0, 0, 100 - id)),
  };
}

describe("decision report math", () => {
  it("computes precision, recall, and the false-positive rate on kept mail", () => {
    const rows = [
      { label: "spam" as const, flagged: true },
      { label: "spam" as const, flagged: true },
      { label: "spam" as const, flagged: false },
      { label: "ham" as const, flagged: true },
      { label: "ham" as const, flagged: false },
      { label: "ham" as const, flagged: false },
      { label: "ham" as const, flagged: false },
    ];
    expect(confusion(rows, (row) => row.flagged)).toEqual({
      labelled: 7,
      truePositives: 2,
      falsePositives: 1,
      trueNegatives: 3,
      falseNegatives: 1,
      precision: 0.6667,
      recall: 0.6667,
      falsePositiveRate: 0.25,
    });
    expect(confusion([], () => true)).toMatchObject({
      precision: null,
      recall: null,
      falsePositiveRate: null,
    });
  });

  it("summarizes outcomes, SpamAssassin agreement, cost, and disagreements", () => {
    const report = summarizeDecisionReport({
      days: 30,
      since: new Date("2026-09-12T00:00:00.000Z"),
      until: new Date("2026-10-12T00:00:00.000Z"),
      config,
      outcomes: [
        { outcome: "decided", reason: null, count: 8 },
        { outcome: "skipped", reason: "daily_cap", count: 2 },
        { outcome: "error", reason: "rate_limited", count: 1 },
      ],
      decided: [
        {
          verdict: "legitimate",
          proposed_action: "none",
          action_taken: "none",
          spamassassin_is_spam: false,
          count: 5,
        },
        {
          verdict: "spam",
          proposed_action: "spam",
          action_taken: "none",
          spamassassin_is_spam: true,
          count: 2,
        },
        {
          verdict: "phishing",
          proposed_action: "phishing",
          action_taken: "none",
          spamassassin_is_spam: false,
          count: 1,
        },
      ],
      usage: [
        {
          provider: "typesafe",
          model: "jev-1.13.0",
          calls: 9,
          avg_latency: 200,
          p95_latency: 450,
          input_tokens: 9_000_000,
          output_tokens: 0,
        },
      ],
      labelled: [
        labelled(1, "spam", "spam", true),
        labelled(2, "phishing", "ham", false),
        labelled(3, "none", "spam", true),
        labelled(4, "none", "ham", false),
      ],
    });
    expect(report.totals).toEqual({ recorded: 11, decided: 8, skipped: 2, error: 1 });
    expect(report.verdicts).toEqual({ legitimate: 5, spam: 2, phishing: 1, scam: 0 });
    expect(report.proposedActions).toEqual({ none: 5, spam: 2, phishing: 1, category: 0 });
    expect(report.spamAssassin).toEqual({
      compared: 8,
      agree: 7,
      agreementRate: 0.875,
      modelOnly: 1,
      spamAssassinOnly: 0,
    });
    expect(report.feedback.model).toMatchObject({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 1,
      trueNegatives: 1,
      falsePositiveRate: 0.5,
    });
    expect(report.feedback.spamAssassin).toMatchObject({
      truePositives: 2,
      falsePositives: 0,
      falsePositiveRate: 0,
    });
    expect(report.latency).toEqual({ averageMs: 200, p95Ms: 450 });
    expect(report.tokens).toEqual({
      input: 9_000_000,
      output: 0,
      averageInputPerMessage: 1_000_000,
    });
    expect(report.cost).toEqual({ estimatedUsd: 0.378, priced: true });
    expect(report.disagreements.map((row) => [row.messageId, row.userLabel])).toEqual([
      ["m2", "ham"],
      ["m3", "spam"],
    ]);
    expect(Object.keys(report.disagreements[0] ?? {}).sort()).toEqual([
      "confidence",
      "decidedAt",
      "messageId",
      "senderDomain",
      "userLabel",
      "verdict",
    ]);
  });
});
