import type { JsonObject } from "@helix/sdk-types";
import { isRecord } from "../../util/json.js";
import { MAIL_CATEGORY_TABS, type MailCategoryTab } from "../category.js";
import type { TriageSummary } from "./triage.js";

export const DECISION_VERDICTS = ["legitimate", "spam", "phishing", "scam"] as const;
export type DecisionVerdict = (typeof DECISION_VERDICTS)[number];
export const URGENCY_LEVELS = ["can wait", "this week", "today"] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];
const DECISION_ACTIONS = ["none", "spam", "phishing", "category"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

/** Evidence shown to mail users (`messages.metadata.decision`); enforce mode only. */
export interface MailDecisionEvidence {
  readonly provider: string;
  readonly model: string;
  readonly verdict: DecisionVerdict;
  readonly confidence: number | null;
  /** Phishing above the org's threshold: show a strong warning even if already in Spam. */
  readonly phishing: boolean;
  readonly action: DecisionAction;
  readonly category: MailCategoryTab | null;
  readonly needsReply: boolean | null;
  readonly urgency: UrgencyLevel | null;
  readonly decidedAt: string;
}

export function decisionEvidence(input: {
  readonly provider: string;
  readonly model: string;
  readonly summary: TriageSummary;
  readonly action: DecisionAction;
  readonly decidedAt: Date;
}): JsonObject | null {
  const { summary } = input;
  if (summary.verdict === null) return null;
  return {
    provider: input.provider,
    model: input.model,
    verdict: summary.verdict,
    confidence: summary.verdictConfidence,
    phishing: summary.proposedAction === "phishing",
    action: input.action,
    category: summary.category,
    needsReply:
      summary.needsReplyProbability === null ? null : summary.needsReplyProbability >= 0.5,
    urgency: summary.urgency,
    decidedAt: input.decidedAt.toISOString(),
  };
}

/** Read `metadata.decision` back for thread rows and messages; tolerant of bad data. */
export function readDecisionEvidence(metadata: unknown): MailDecisionEvidence | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.decision)) return undefined;
  const value = metadata.decision;
  const verdict = DECISION_VERDICTS.find((item) => item === value.verdict);
  if (verdict === undefined || typeof value.provider !== "string") return undefined;
  const action = DECISION_ACTIONS.find((item) => item === value.action);
  return {
    provider: value.provider,
    model: typeof value.model === "string" ? value.model : "",
    verdict,
    confidence: typeof value.confidence === "number" ? value.confidence : null,
    phishing: value.phishing === true,
    action: action ?? "none",
    category: MAIL_CATEGORY_TABS.find((item) => item === value.category) ?? null,
    needsReply: typeof value.needsReply === "boolean" ? value.needsReply : null,
    urgency: URGENCY_LEVELS.find((item) => item === value.urgency) ?? null,
    decidedAt: typeof value.decidedAt === "string" ? value.decidedAt : "",
  };
}
