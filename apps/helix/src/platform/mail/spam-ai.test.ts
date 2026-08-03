import { describe, expect, it, vi } from "vitest";
import {
  combineSpamDecisions,
  createBetaSpamSecondPass,
  evaluateSpamRules,
  getMailSpamAiConfig,
  parseLlmSpamContent,
  runBetaSpamSecondPass,
} from "./spam-ai.js";

describe("evaluateSpamRules", () => {
  it("scores strong spammy subjects as spam", () => {
    const verdict = evaluateSpamRules({
      subject: "You WON free money prize NOW",
      bodyText: "Click here now to claim your wire transfer gift card",
      fromAddress: "promo@spam.example",
    });
    expect(verdict.score).toBeGreaterThanOrEqual(4);
    expect(verdict.label).toBe("spam");
    expect(verdict.hits.length).toBeGreaterThan(0);
  });

  it("scores normal mail as ham", () => {
    const verdict = evaluateSpamRules({
      subject: "Team standup notes",
      bodyText: "See you at 10am in the large conference room.",
      fromAddress: "alice@helix.local",
    });
    expect(verdict.label).toBe("ham");
    expect(verdict.score).toBeLessThan(2);
  });
});

describe("combineSpamDecisions", () => {
  it("defensive: if spamd already spam, combine reports spamd (AI layer should not run)", () => {
    const rules = evaluateSpamRules({
      subject: "hello",
      bodyText: "normal body",
      fromAddress: "a@b.com",
    });
    const d = combineSpamDecisions({ spamdIsSpam: true, rules, llm: null });
    expect(d.isSpam).toBe(true);
    expect(d.source).toBe("spamd");
  });

  it("does not call LLM when features say spamd already spam", async () => {
    const fetchImpl = vi.fn();
    const decision = await runBetaSpamSecondPass(
      {
        subject: "anything",
        bodyText: "body",
        fromAddress: "x@y.com",
        spamdIsSpam: true,
        spamdScore: 9,
      },
      getMailSpamAiConfig({
        MAIL_SPAM_AI_BETA_ENABLED: "true",
        MAIL_SPAM_AI_API_KEY: "sk-test",
      }),
      fetchImpl,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(decision.source).toBe("spamd");
    expect(decision.isSpam).toBe(true);
  });

  it("routes on strong rules when spamd is ham", () => {
    const rules = evaluateSpamRules({
      subject: "FREE MONEY lottery prize",
      bodyText: "Click here to claim your wire transfer gift card viagra",
      fromAddress: "noreply@bulk.example",
    });
    const d = combineSpamDecisions({ spamdIsSpam: false, rules, llm: null });
    expect(d.isSpam).toBe(true);
    expect(d.source).toBe("rules");
  });
});

describe("parseLlmSpamContent", () => {
  it("parses JSON labels", () => {
    const v = parseLlmSpamContent('{"label":"spam","confidence":0.9,"reason":"scam"}');
    expect(v.label).toBe("spam");
    expect(v.confidence).toBe(0.9);
  });
});

describe("getMailSpamAiConfig", () => {
  it("is off by default (beta)", () => {
    expect(getMailSpamAiConfig({}).enabled).toBe(false);
    expect(getMailSpamAiConfig({}).beta).toBe(true);
  });

  it("reads key base url and model env", () => {
    const cfg = getMailSpamAiConfig({
      MAIL_SPAM_AI_BETA_ENABLED: "true",
      MAIL_SPAM_AI_API_KEY: "sk-test",
      MAIL_SPAM_AI_BASE_URL: "https://llm.example/v1",
      MAIL_SPAM_AI_MODEL: "gpt-test",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.apiKey).toBe("sk-test");
    expect(cfg.baseUrl).toBe("https://llm.example/v1");
    expect(cfg.model).toBe("gpt-test");
  });
});

describe("runBetaSpamSecondPass", () => {
  it("does not call LLM when disabled", async () => {
    const fetchImpl = vi.fn();
    const decision = await runBetaSpamSecondPass(
      {
        subject: "FREE MONEY lottery prize",
        bodyText: "Click here to claim wire transfer gift card",
        fromAddress: "x@y.com",
      },
      getMailSpamAiConfig({}),
      fetchImpl,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(decision.isSpam).toBe(true);
  });

  it("fails open when LLM transport errors", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const decision = await runBetaSpamSecondPass(
      {
        subject: "Meeting notes",
        bodyText: "See agenda attached.",
        fromAddress: "alice@helix.local",
        spamdIsSpam: false,
      },
      getMailSpamAiConfig({
        MAIL_SPAM_AI_BETA_ENABLED: "true",
        MAIL_SPAM_AI_API_KEY: "sk-test",
      }),
      fetchImpl,
    );
    expect(decision.isSpam).toBe(false);
  });

  it("uses LLM spam vote when high confidence", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"label":"spam","confidence":0.95,"reason":"phishing"}',
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const decision = await runBetaSpamSecondPass(
      {
        subject: "Please verify account",
        bodyText: "We need your password.",
        fromAddress: "it@evil.example",
        spamdIsSpam: false,
      },
      getMailSpamAiConfig({
        MAIL_SPAM_AI_BETA_ENABLED: "true",
        MAIL_SPAM_AI_API_KEY: "sk-test",
      }),
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalled();
    expect(decision.isSpam).toBe(true);
    expect(decision.source).toBe("llm");
    expect(decision.evidence.source).toBe("ai");
  });
});

describe("createBetaSpamSecondPass", () => {
  it("always returns a runner; disabled beta yields null per call", async () => {
    const runner = createBetaSpamSecondPass({});
    expect(runner).toBeTypeOf("function");
    await expect(
      runner({
        subject: "hello",
        bodyText: "world",
        fromAddress: "a@b.com",
      }),
    ).resolves.toBeNull();
  });

  it("returns a spam decision when beta enabled", async () => {
    const runner = createBetaSpamSecondPass({
      MAIL_SPAM_AI_BETA_ENABLED: "true",
      MAIL_SPAM_AI_API_KEY: "sk",
    });
    expect(runner).toBeTypeOf("function");
    const result = await runner({
      subject: "hello",
      bodyText: "world",
      fromAddress: "a@b.com",
    });
    expect(result).not.toBeNull();
    expect(typeof result!.isSpam).toBe("boolean");
    expect(result!.evidence).toBeTruthy();
  });

  it("re-resolves enablement on each call (Admin hot-reload path)", async () => {
    const env: Record<string, string | undefined> = {};
    const runner = createBetaSpamSecondPass(env);
    await expect(
      runner({ subject: "x", bodyText: "y", fromAddress: "a@b.com" }),
    ).resolves.toBeNull();

    env.MAIL_SPAM_AI_BETA_ENABLED = "true";
    env.MAIL_SPAM_AI_API_KEY = "sk";
    const afterEnable = await runner({
      subject: "hello",
      bodyText: "world",
      fromAddress: "a@b.com",
    });
    expect(afterEnable).not.toBeNull();
    expect(typeof afterEnable!.isSpam).toBe("boolean");

    env.MAIL_SPAM_AI_BETA_ENABLED = "false";
    await expect(
      runner({ subject: "x", bodyText: "y", fromAddress: "a@b.com" }),
    ).resolves.toBeNull();
  });

  it("picks up Admin operator-settings overlay without recreating the runner", async () => {
    const { applyOperatorAiFromHelixConfig } = await import("../ai/operator-settings.js");
    // Isolate: empty process-like bag so only the overlay can enable beta.
    const env: Record<string, string | undefined> = {};
    const runner = createBetaSpamSecondPass(env);

    await expect(
      runner({ subject: "x", bodyText: "y", fromAddress: "a@b.com" }),
    ).resolves.toBeNull();

    applyOperatorAiFromHelixConfig({
      security: { tier: "personal" },
      ai: {
        operatorLlm: { apiKey: "sk-admin", model: "gpt-4o-mini" },
        mailSpamAi: { betaEnabled: true },
      },
    });
    // Overlay wins when merged inside getMailSpamAiConfig(env).
    const afterAdmin = await runner({
      subject: "hello",
      bodyText: "world",
      fromAddress: "a@b.com",
    });
    expect(afterAdmin).not.toBeNull();

    applyOperatorAiFromHelixConfig({
      security: { tier: "personal" },
      ai: { mailSpamAi: { betaEnabled: false } },
    });
    await expect(
      runner({ subject: "x", bodyText: "y", fromAddress: "a@b.com" }),
    ).resolves.toBeNull();

    // Clear overlay so other tests are not polluted.
    applyOperatorAiFromHelixConfig({ security: { tier: "personal" } });
  });
});
