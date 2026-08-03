/**
 * Optional beta AI + rules spam second-pass.
 *
 * Off by default. When enabled, combines lightweight header/body rules with an
 * optional OpenAI-compatible LLM. Failures never block SMTP accept — callers
 * must treat thrown LLM errors as "no AI vote".
 *
 * Env (document in docs/mail-security-and-reliability.md):
 *   MAIL_SPAM_AI_BETA_ENABLED  truthy to enable (default off)
 *   MAIL_SPAM_AI_API_KEY       bearer token (or fall back to OPENAI_API_KEY)
 *   MAIL_SPAM_AI_BASE_URL      API base (default https://api.openai.com/v1 or OPENAI_BASE_URL)
 *   MAIL_SPAM_AI_MODEL         model id (or OPENAI_MODEL / gpt-4o-mini)
 */

import type { JsonObject } from "@helix/sdk-types";
import { resolveAiEnv } from "../ai/operator-settings.js";

export type SpamLabel = "spam" | "ham" | "unsure";

export interface SpamRuleHit {
  readonly id: string;
  readonly weight: number;
  readonly detail: string;
}

export interface SpamRulesVerdict {
  readonly label: SpamLabel;
  readonly score: number;
  readonly hits: readonly SpamRuleHit[];
  readonly evidence: JsonObject;
}

export interface SpamLlmVerdict {
  readonly label: SpamLabel;
  readonly confidence: number;
  readonly reason: string;
  readonly evidence: JsonObject;
}

export interface CombinedSpamDecision {
  /** Route to Spam folder when true. */
  readonly isSpam: boolean;
  readonly label: SpamLabel;
  readonly source: "rules" | "llm" | "spamd" | "combined";
  readonly evidence: JsonObject;
}

export interface MailSpamAiConfig {
  readonly enabled: boolean;
  readonly beta: true;
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export interface SpamMessageFeatures {
  readonly subject: string;
  readonly bodyText: string;
  readonly fromAddress: string;
  readonly rawHeaders?: string | undefined;
  /** Prior spamd score if available. */
  readonly spamdScore?: number | undefined;
  readonly spamdIsSpam?: boolean | undefined;
}

const SPAM_SUBJECT_PATTERNS: readonly {
  readonly id: string;
  readonly re: RegExp;
  readonly weight: number;
}[] = [
  { id: "subj_free_money", re: /\b(free\s+money|you\s+won|winner|lottery|prize)\b/iu, weight: 3 },
  {
    id: "subj_crypto",
    re: /\b(crypto|bitcoin|nft|airdrop)\b.*\b(urgent|claim|wallet)\b/iu,
    weight: 2.5,
  },
  { id: "subj_viagra", re: /\b(viagra|cialis|pharmacy)\b/iu, weight: 3 },
  { id: "subj_reply_only", re: /^(re|fwd):\s*$/iu, weight: 1 },
  { id: "subj_all_caps", re: /^[A-Z0-9\s!?.$]{12,}$/u, weight: 1.5 },
];

const SPAM_BODY_PATTERNS: readonly {
  readonly id: string;
  readonly re: RegExp;
  readonly weight: number;
}[] = [
  { id: "body_click_here", re: /\bclick\s+here\s+(now|to\s+claim)\b/iu, weight: 2 },
  {
    id: "body_wire_transfer",
    re: /\b(wire\s+transfer|western\s+union|gift\s+card)\b/iu,
    weight: 2.5,
  },
  { id: "body_unsubscribe_only", re: /unsubscribe/iu, weight: 0.5 },
  { id: "body_too_many_urls", re: /https?:\/\//giu, weight: 0 }, // special-cased
];

/** Pure rule scorer — no I/O. */
export function evaluateSpamRules(features: SpamMessageFeatures): SpamRulesVerdict {
  const hits: SpamRuleHit[] = [];
  let score = 0;
  const subject = features.subject;
  const body = features.bodyText;
  const from = features.fromAddress;

  for (const rule of SPAM_SUBJECT_PATTERNS) {
    if (rule.re.test(subject)) {
      hits.push({ id: rule.id, weight: rule.weight, detail: `subject matched ${rule.id}` });
      score += rule.weight;
    }
  }
  for (const rule of SPAM_BODY_PATTERNS) {
    if (rule.id === "body_too_many_urls") {
      const urls = body.match(rule.re) ?? [];
      if (urls.length >= 5) {
        const weight = Math.min(3, urls.length * 0.4);
        hits.push({ id: rule.id, weight, detail: `${String(urls.length)} urls in body` });
        score += weight;
      }
      continue;
    }
    if (rule.re.test(body)) {
      hits.push({ id: rule.id, weight: rule.weight, detail: `body matched ${rule.id}` });
      score += rule.weight;
    }
  }
  if (/noreply|no-reply|marketing@|promo@/iu.test(from) && score > 0) {
    hits.push({ id: "from_bulk", weight: 0.5, detail: "bulk-like envelope from" });
    score += 0.5;
  }

  let label: SpamLabel = "ham";
  if (score >= 4) label = "spam";
  else if (score >= 2) label = "unsure";

  return {
    label,
    score,
    hits,
    evidence: {
      beta: true,
      kind: "rules",
      score,
      label,
      hits: hits.map((h) => h.id),
    },
  };
}

/**
 * Ordered pipeline after spamd has already **passed** (not spam).
 * Callers must not invoke this when spamd already classified spam.
 * Inside: rules + optional LLM only — never re-apply spamd vote here except evidence.
 */
export function combineSpamDecisions(input: {
  readonly spamdIsSpam?: boolean | undefined;
  readonly spamdScore?: number | undefined;
  readonly rules: SpamRulesVerdict;
  readonly llm?: SpamLlmVerdict | null | undefined;
}): CombinedSpamDecision {
  const evidence: JsonObject = {
    beta: true,
    layering: "spamd_then_ai_if_pass",
    spamdIsSpam: input.spamdIsSpam ?? null,
    spamdScore: input.spamdScore ?? null,
    rules: input.rules.evidence,
    llm: input.llm?.evidence ?? null,
  };

  // Spamd already caught it — AI layer should not have been called; preserve signal.
  if (input.spamdIsSpam === true) {
    return { isSpam: true, label: "spam", source: "spamd", evidence };
  }
  // AI tool: LLM high confidence spam
  if (input.llm?.label === "spam" && input.llm.confidence >= 0.7) {
    return { isSpam: true, label: "spam", source: "llm", evidence: { ...evidence, source: "ai" } };
  }
  // AI tool: strong rules
  if (input.rules.label === "spam") {
    return {
      isSpam: true,
      label: "spam",
      source: "rules",
      evidence: { ...evidence, source: "rules" },
    };
  }
  // Combined uncertain rules + moderate LLM
  if (
    input.rules.label === "unsure" &&
    input.llm?.label === "spam" &&
    input.llm.confidence >= 0.55
  ) {
    return {
      isSpam: true,
      label: "spam",
      source: "combined",
      evidence: { ...evidence, source: "ai" },
    };
  }
  return {
    isSpam: false,
    label: input.rules.label === "unsure" || input.llm?.label === "unsure" ? "unsure" : "ham",
    source: "combined",
    evidence: { ...evidence, source: "pass" },
  };
}

export function getMailSpamAiConfig(
  env: Readonly<Record<string, string | undefined>>,
): MailSpamAiConfig {
  // Admin-saved operator settings (platform-config) overlay env bootstrap.
  const merged = resolveAiEnv(env);
  const enabled = envFlag(merged.MAIL_SPAM_AI_BETA_ENABLED);
  const apiKey = merged.MAIL_SPAM_AI_API_KEY ?? merged.OPENAI_API_KEY;
  const baseUrl = (
    merged.MAIL_SPAM_AI_BASE_URL ??
    merged.OPENAI_BASE_URL ??
    "https://api.openai.com/v1"
  ).replace(/\/+$/u, "");
  const model = merged.MAIL_SPAM_AI_MODEL ?? merged.OPENAI_MODEL ?? "gpt-4o-mini";
  const timeoutMs = parsePositiveInt(merged.MAIL_SPAM_AI_TIMEOUT_MS) ?? 4_000;
  return {
    enabled,
    beta: true,
    apiKey,
    baseUrl,
    model,
    timeoutMs,
  };
}

export type LlmFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Call an OpenAI-compatible chat completions endpoint. Throws on transport errors. */
export async function classifySpamWithLlm(
  features: SpamMessageFeatures,
  config: MailSpamAiConfig,
  fetchImpl: LlmFetch = globalThis.fetch,
): Promise<SpamLlmVerdict> {
  if (!config.enabled) {
    throw new Error("MAIL_SPAM_AI_BETA is disabled");
  }
  if (config.apiKey === undefined || config.apiKey.trim().length === 0) {
    throw new Error("MAIL_SPAM_AI_API_KEY (or OPENAI_API_KEY) is not set");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, config.timeoutMs);
  try {
    const prompt = [
      "Classify this email as spam, ham, or unsure. Reply JSON only:",
      '{"label":"spam|ham|unsure","confidence":0-1,"reason":"short"}',
      `From: ${features.fromAddress}`,
      `Subject: ${features.subject}`,
      `Body: ${features.bodyText.slice(0, 2_000)}`,
    ].join("\n");

    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are a beta spam classifier for Helix Mail. Be conservative: prefer ham/unsure over false spam.",
          },
          { role: "user", content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`LLM spam classify HTTP ${String(response.status)}`);
    }
    const json = (await response.json()) as {
      choices?: readonly { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    return parseLlmSpamContent(content);
  } finally {
    clearTimeout(timer);
  }
}

export function parseLlmSpamContent(content: string): SpamLlmVerdict {
  const trimmed = content.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  const slice =
    jsonStart >= 0 && jsonEnd > jsonStart ? trimmed.slice(jsonStart, jsonEnd + 1) : trimmed;
  let parsed: { label?: string; confidence?: number; reason?: string } = {};
  try {
    parsed = JSON.parse(slice) as typeof parsed;
  } catch {
    parsed = {};
  }
  const rawLabel = (parsed.label ?? "unsure").toLowerCase();
  const label: SpamLabel =
    rawLabel === "spam" || rawLabel === "ham" || rawLabel === "unsure" ? rawLabel : "unsure";
  const confidence = clamp01(parsed.confidence ?? 0.5);
  const reason = typeof parsed.reason === "string" ? parsed.reason : "beta llm";
  return {
    label,
    confidence,
    reason,
    evidence: {
      beta: true,
      kind: "llm",
      label,
      confidence,
      reason,
    },
  };
}

/**
 * AI spam tool after spamd **pass**. If features.spamdIsSpam is true, returns
 * spamd spam immediately without LLM (defensive).
 * Never throws for LLM failures — fail-open to rules-only / ham.
 */
export async function runBetaSpamSecondPass(
  features: SpamMessageFeatures,
  config: MailSpamAiConfig,
  fetchImpl: LlmFetch = globalThis.fetch,
): Promise<CombinedSpamDecision> {
  // Hard gate: do not spend LLM budget if spamd already flagged spam.
  if (features.spamdIsSpam === true) {
    return combineSpamDecisions({
      spamdIsSpam: true,
      spamdScore: features.spamdScore,
      rules: evaluateSpamRules(features),
      llm: null,
    });
  }
  const rules = evaluateSpamRules(features);
  if (!config.enabled) {
    return combineSpamDecisions({
      spamdIsSpam: false,
      spamdScore: features.spamdScore,
      rules,
      llm: null,
    });
  }
  let llm: SpamLlmVerdict | null = null;
  try {
    if (config.apiKey !== undefined && config.apiKey.trim().length > 0) {
      llm = await classifySpamWithLlm(features, config, fetchImpl);
    }
  } catch {
    llm = null;
  }
  return combineSpamDecisions({
    spamdIsSpam: false,
    spamdScore: features.spamdScore,
    rules,
    llm,
  });
}

function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const n = value.trim().toLowerCase();
  return n === "1" || n === "true" || n === "yes";
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/**
 * Factory for inbound scan second-pass.
 *
 * Always returns a runner so the SMTP path can wire it once at boot. Config is
 * re-resolved on **every** invocation via {@link getMailSpamAiConfig} (which
 * merges the Admin operator-settings overlay), so enablement / key / model
 * changes from platform-config hot-reload apply without rebuilding the
 * receiver. When beta is off at call time, returns `null` (skip — no vote).
 */
export function createBetaSpamSecondPass(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: LlmFetch = globalThis.fetch,
): (features: SpamMessageFeatures) => Promise<{
  readonly isSpam: boolean;
  readonly evidence: JsonObject;
} | null> {
  return async (features) => {
    // Re-read env + Admin overlay each call — do not freeze config at factory time.
    const config = getMailSpamAiConfig(env);
    if (!config.enabled) {
      return null;
    }
    const decision = await runBetaSpamSecondPass(features, config, fetchImpl);
    return { isSpam: decision.isSpam, evidence: decision.evidence };
  };
}
