import { describe, expect, it } from "vitest";
import {
  decisionConfigVersion,
  decisionInputPricePerMillion,
  decisionModelEndpoint,
  mailDecisionModelConfigSchema,
  resolveDecisionModelConfig,
} from "./config.js";
import { decisionEvidence, readDecisionEvidence } from "./evidence.js";
import type { DecisionAnswer, DecisionResult } from "./protocol.js";
import {
  buildTriageRequest,
  summarizeTriage,
  triageState,
  type DecisionCandidate,
} from "./triage.js";

const candidate: DecisionCandidate = {
  orgId: "org",
  messageId: "message",
  threadId: "thread",
  subject: "Your account is locked",
  fromAddress: "security@paypa1.example",
  fromName: "PayPal Security",
  replyTo: ["collect@evil.example"],
  toCount: 1,
  ccCount: 2,
  sentAt: new Date("2026-10-12T08:00:00.000Z"),
  headers: { "return-path": "<bounce@mailer.evil.example>" },
  auth: { spf: "fail", dkim: "none", dmarc: "fail" },
  spamAssassin: { score: 4.2, isSpam: false, symbols: ["HTML_MESSAGE", "URIBL_BLOCKED"] },
  body: '<p>Verify <a href="https://paypa1-login.example/x?y=1">here</a> and https://cdn.example/a</p>',
  bodyFormat: "html",
  attachments: [{ filename: "invoice.pdf.exe", mimeType: "application/octet-stream" }],
};

function choice(answer: string, confidence: number): DecisionAnswer {
  return { type: "choice", answer, probabilities: { [answer]: confidence }, confidence };
}

function result(answers: Record<string, DecisionAnswer>): DecisionResult {
  return { model: "clef-flash", usage: { inputTokens: 900, outputTokens: 0 }, answers };
}

describe("triage request", () => {
  it("summarizes envelope, authentication, links, and attachments ahead of the body", () => {
    const state = triageState(candidate);
    expect(state).toContain("From: PayPal Security <security@paypa1.example>");
    expect(state).toContain("Reply-To: collect@evil.example");
    expect(state).toContain("Return-Path domain: mailer.evil.example");
    expect(state).toContain("Recipients: 1 To, 2 Cc");
    expect(state).toContain("Authentication: SPF=fail DKIM=none DMARC=fail");
    expect(state).toContain("SpamAssassin: score 4.2 (HTML_MESSAGE, URIBL_BLOCKED)");
    expect(state).toContain("Link domains: paypa1-login.example, cdn.example");
    expect(state).toContain("Attachments: invoice.pdf.exe (application/octet-stream)");
    expect(state).toContain("Body:\nVerify here and https://cdn.example/a");
    expect(state).not.toContain("<p>");
  });

  it("prefers the stored text part and stays within the state budget", () => {
    const long = triageState({
      ...candidate,
      plainBody: `plain text part ${"x".repeat(20_000)}`,
    });
    expect(long.length).toBeLessThanOrEqual(8_000);
    expect(long).toContain("Body:\nplain text part xxx");
  });

  it("asks the four triage questions in one request", () => {
    const request = buildTriageRequest(candidate);
    expect(Object.keys(request.questions)).toEqual([
      "verdict",
      "category",
      "needs_reply",
      "urgency",
    ]);
    expect(request.questions.verdict).toMatchObject({
      type: "choice",
      criteria: { legitimate: expect.any(String), phishing: expect.any(String) },
    });
    expect(request.questions.urgency).toMatchObject({
      type: "score",
      criteria: ["can wait", "this week", "today"],
    });
    expect(request.instructions).toMatch(/conservative/u);
  });
});

describe("proposed actions", () => {
  const config = resolveDecisionModelConfig({ mode: "enforce", provider: "typesafe" });

  it.each([
    ["phishing at threshold", choice("phishing", 0.8), "phishing"],
    ["phishing below threshold", choice("phishing", 0.79), "none"],
    ["spam at threshold", choice("spam", 0.9), "spam"],
    ["scam counts as spam", choice("scam", 0.95), "spam"],
    ["spam below threshold", choice("spam", 0.89), "none"],
    ["legitimate", choice("legitimate", 0.99), "none"],
  ])("%s", (_label, verdict, expected) => {
    expect(summarizeTriage(result({ verdict }), config).proposedAction).toBe(expected);
  });

  it("re-tabs only when categories are enabled and confident", () => {
    const answers = { verdict: choice("legitimate", 0.9), category: choice("promotions", 0.8) };
    expect(summarizeTriage(result(answers), config).proposedAction).toBe("none");
    const applying = { ...config, applyCategories: true };
    expect(summarizeTriage(result(answers), applying).proposedAction).toBe("category");
    expect(
      summarizeTriage(result({ ...answers, category: choice("promotions", 0.7) }), applying)
        .proposedAction,
    ).toBe("none");
  });

  it("round-trips user-facing evidence and ignores malformed metadata", () => {
    const summary = summarizeTriage(
      result({
        verdict: choice("phishing", 0.93),
        needs_reply: {
          type: "noul",
          answer: false,
          probabilities: { true: 0.1, false: 0.9 },
          confidence: 0.9,
        },
      }),
      config,
    );
    const evidence = decisionEvidence({
      provider: "typesafe",
      model: "jev-1.13.0",
      summary,
      action: "none",
      decidedAt: new Date("2026-10-12T09:00:00.000Z"),
    });
    expect(readDecisionEvidence({ decision: evidence })).toEqual({
      provider: "typesafe",
      model: "jev-1.13.0",
      verdict: "phishing",
      confidence: 0.93,
      phishing: true,
      action: "none",
      category: null,
      needsReply: false,
      urgency: null,
      decidedAt: "2026-10-12T09:00:00.000Z",
    });
    expect(readDecisionEvidence({ decision: { verdict: "maybe" } })).toBeUndefined();
    expect(readDecisionEvidence({})).toBeUndefined();
  });
});

describe("decision model configuration", () => {
  it("defaults to off and fills provider defaults", () => {
    expect(resolveDecisionModelConfig(undefined)).toMatchObject({
      mode: "off",
      provider: "cloudflare",
      model: "clef-flash",
      spamThreshold: 0.9,
      phishingThreshold: 0.8,
      categoryThreshold: 0.75,
      applyCategories: false,
      dailyMessageCap: 5000,
    });
    expect(resolveDecisionModelConfig({ provider: "typesafe" }).model).toBe("jev-latest");
    // Invalid stored settings fail safe.
    expect(resolveDecisionModelConfig({ mode: "enforce", provider: "nope" }).mode).toBe("off");
  });

  it.each([
    [{ provider: "typesafe", baseUrl: "http://api.typesafe.ai" }, "baseUrl"],
    [{ provider: "typesafe", baseUrl: "https://user:pw@api.typesafe.ai" }, "baseUrl"],
    [{ provider: "cloudflare", baseUrl: "https://api.typesafe.ai" }, "baseUrl"],
    [{ provider: "cloudflare", model: "jev-latest" }, "model"],
    [{ provider: "cloudflare", mode: "shadow" }, "cloudflareAccountId"],
    [{ spamThreshold: 0.2 }, "spamThreshold"],
    [{ dailyMessageCap: 0 }, "dailyMessageCap"],
    [{ unexpected: true }, ""],
  ])("rejects %j", (settings, path) => {
    const parsed = mailDecisionModelConfigSchema.safeParse(settings);
    expect(parsed.success).toBe(false);
    if (!parsed.success && path !== "") {
      expect(parsed.error.issues.map((issue) => issue.path.join("."))).toContain(path);
    }
  });

  it("derives the endpoint, a stable version, and list prices", () => {
    const cf = resolveDecisionModelConfig({
      provider: "cloudflare",
      model: "clef",
      cloudflareAccountId: "0123456789abcdef0123456789abcdef",
    });
    expect(decisionModelEndpoint(cf).toString()).toBe(
      "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef",
    );
    expect(decisionConfigVersion(cf)).toBe(decisionConfigVersion({ ...cf }));
    expect(decisionConfigVersion(cf)).not.toBe(
      decisionConfigVersion({ ...cf, spamThreshold: 0.95 }),
    );
    expect(decisionInputPricePerMillion("cloudflare", "@cf/cloudflare/clef-flash")).toBe(0.038);
    expect(decisionInputPricePerMillion("typesafe", "jev-1.13.0")).toBe(0.042);
    expect(decisionInputPricePerMillion("typesafe", "other")).toBeNull();
    expect(
      decisionInputPricePerMillion("cloudflare", "clef", {
        ...cf,
        inputPricePerMillionTokensUsd: 0.2,
      }),
    ).toBe(0.2);
  });
});
