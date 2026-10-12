/* Payloads shaped exactly as the backend's decision-model admin routes send
 * them (apps/helix/src/platform/mail/decision/admin-routes.ts `decisionModelView`
 * and report.ts `DecisionModelReport`). */

import type { DecisionModelReport, DecisionModelView } from "./mail-decision-model-api";

export function decisionModelViewFixture(
  overrides: Partial<DecisionModelView> = {},
): DecisionModelView {
  return {
    mode: "shadow",
    provider: "cloudflare",
    model: "clef-flash",
    defaultModel: "clef-flash",
    baseUrl: null,
    cloudflareAccountId: "0123456789abcdef0123456789abcdef",
    spamThreshold: 0.9,
    phishingThreshold: 0.8,
    categoryThreshold: 0.75,
    applyCategories: false,
    dailyMessageCap: 5000,
    inputPricePerMillionTokensUsd: null,
    credentialConfigured: true,
    credentialUpdatedAt: "2026-10-12T00:00:00.000Z",
    providerLabel: "Cloudflare Workers AI",
    endpointHost: "api.cloudflare.com",
    notice:
      "Message content is sent to Cloudflare Workers AI for classification. Mail labelled confidential or restricted is never sent.",
    ...overrides,
  };
}

const emptyConfusion = {
  labelled: 0,
  truePositives: 0,
  falsePositives: 0,
  trueNegatives: 0,
  falseNegatives: 0,
  precision: null,
  recall: null,
  falsePositiveRate: null,
};

export function decisionModelReportFixture(
  overrides: Partial<DecisionModelReport> = {},
): DecisionModelReport {
  return {
    window: {
      days: 30,
      since: "2026-09-12T12:00:00.000Z",
      until: "2026-10-12T12:00:00.000Z",
    },
    totals: { recorded: 1210, decided: 1200, skipped: 8, error: 2 },
    outcomes: [
      { outcome: "decided", reason: null, count: 1200 },
      { outcome: "skipped", reason: "classified_restricted", count: 8 },
      { outcome: "error", reason: "timeout", count: 2 },
    ],
    verdicts: { legitimate: 1100, spam: 80, phishing: 15, scam: 5 },
    proposedActions: { none: 1105, spam: 80, phishing: 15, category: 0 },
    actionsTaken: { none: 1200, spam: 0, phishing: 0, category: 0 },
    spamAssassin: {
      compared: 1180,
      agree: 1150,
      agreementRate: 0.9746,
      modelOnly: 22,
      spamAssassinOnly: 8,
    },
    feedback: {
      model: {
        labelled: 120,
        truePositives: 36,
        falsePositives: 1,
        trueNegatives: 79,
        falseNegatives: 4,
        precision: 0.973,
        recall: 0.9,
        falsePositiveRate: 0.0125,
      },
      spamAssassin: {
        labelled: 118,
        truePositives: 30,
        falsePositives: 3,
        trueNegatives: 75,
        falseNegatives: 10,
        precision: 0.9091,
        recall: 0.75,
        falsePositiveRate: 0.0385,
      },
    },
    latency: { averageMs: 380, p95Ms: 910 },
    tokens: { input: 1_440_000, output: 0, averageInputPerMessage: 1200 },
    cost: { estimatedUsd: 0.05472, priced: true },
    disagreements: [
      {
        messageId: "msg-7",
        senderDomain: "newsletters.example",
        verdict: "spam",
        confidence: 0.91,
        userLabel: "ham",
        decidedAt: "2026-10-11T08:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

export const emptyFeedback = { model: emptyConfusion, spamAssassin: emptyConfusion };
