import type postgres from "postgres";
import { decisionInputPricePerMillion, type ResolvedDecisionModelConfig } from "./config.js";

/**
 * Admin report: how the decision model would have done (shadow) or did
 * (enforce) against SpamAssassin and against people's own "Spam" / "Not spam"
 * actions, which are the ground truth. A message counts as "flagged" when its
 * proposed action is `spam` or `phishing`, i.e. after the org's thresholds;
 * the same definition applies in shadow and enforce mode.
 */

export interface ConfusionCounts {
  readonly labelled: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly trueNegatives: number;
  readonly falseNegatives: number;
  readonly precision: number | null;
  readonly recall: number | null;
  /** Share of mail people kept (Not spam) that was flagged. */
  readonly falsePositiveRate: number | null;
}

export interface DecisionModelReport {
  readonly window: { readonly days: number; readonly since: string; readonly until: string };
  readonly totals: {
    readonly recorded: number;
    readonly decided: number;
    readonly skipped: number;
    readonly error: number;
  };
  readonly outcomes: readonly {
    readonly outcome: string;
    readonly reason: string | null;
    readonly count: number;
  }[];
  readonly verdicts: Readonly<Record<"legitimate" | "spam" | "phishing" | "scam", number>>;
  readonly proposedActions: Readonly<Record<"none" | "spam" | "phishing" | "category", number>>;
  readonly actionsTaken: Readonly<Record<"none" | "spam" | "phishing" | "category", number>>;
  readonly spamAssassin: {
    readonly compared: number;
    readonly agree: number;
    readonly agreementRate: number | null;
    readonly modelOnly: number;
    readonly spamAssassinOnly: number;
  };
  readonly feedback: {
    readonly model: ConfusionCounts;
    readonly spamAssassin: ConfusionCounts;
  };
  readonly latency: { readonly averageMs: number | null; readonly p95Ms: number | null };
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly averageInputPerMessage: number | null;
  };
  readonly cost: { readonly estimatedUsd: number | null; readonly priced: boolean };
  readonly disagreements: readonly {
    readonly messageId: string;
    readonly senderDomain: string | null;
    readonly verdict: string | null;
    readonly confidence: number | null;
    readonly userLabel: "spam" | "ham";
    readonly decidedAt: string;
  }[];
}

interface LabelledRow {
  readonly message_id: string;
  readonly sender_domain: string | null;
  readonly verdict: string | null;
  readonly verdict_confidence: number | null;
  readonly proposed_action: string;
  readonly spamassassin_is_spam: boolean | null;
  readonly label: "spam" | "ham";
  readonly created_at: Date;
}

const MAX_LABELLED_ROWS = 20_000;
const MAX_DISAGREEMENTS = 20;

export async function buildDecisionModelReport(
  sql: postgres.Sql,
  input: {
    readonly orgId: string;
    readonly days: number;
    readonly now: Date;
    readonly config: ResolvedDecisionModelConfig;
  },
): Promise<DecisionModelReport> {
  const since = new Date(input.now.getTime() - input.days * 24 * 60 * 60 * 1000);
  const outcomes = await sql<{ outcome: string; reason: string | null; count: number }[]>`
    select outcome, reason, count(*)::int as count from mail_decision_verdicts
    where org_id = ${input.orgId} and created_at >= ${since}
    group by outcome, reason order by count(*) desc, outcome, reason
  `;
  const decided = await sql<
    {
      verdict: string | null;
      proposed_action: string;
      action_taken: string;
      spamassassin_is_spam: boolean | null;
      count: number;
    }[]
  >`
    select verdict, proposed_action, action_taken, spamassassin_is_spam, count(*)::int as count
    from mail_decision_verdicts
    where org_id = ${input.orgId} and created_at >= ${since} and outcome = 'decided'
    group by verdict, proposed_action, action_taken, spamassassin_is_spam
  `;
  const usage = await sql<
    {
      provider: string;
      model: string;
      calls: number;
      avg_latency: number | null;
      p95_latency: number | null;
      input_tokens: number;
      output_tokens: number;
    }[]
  >`
    select provider, model, count(*)::int as calls,
      avg(latency_ms)::float8 as avg_latency,
      percentile_cont(0.95) within group (order by latency_ms)::float8 as p95_latency,
      coalesce(sum(input_tokens), 0)::float8 as input_tokens,
      coalesce(sum(output_tokens), 0)::float8 as output_tokens
    from mail_decision_verdicts
    where org_id = ${input.orgId} and created_at >= ${since} and outcome in ('decided', 'error')
    group by provider, model
  `;
  const labelled = await sql<LabelledRow[]>`
    with labels as (
      select distinct on (f.message_id) f.message_id, f.label
      from mail_spam_feedback f
      where f.org_id = ${input.orgId} and f.source = 'user' and f.message_id is not null
      order by f.message_id, f.created_at desc, f.id desc
    )
    select v.message_id, v.sender_domain, v.verdict, v.verdict_confidence, v.proposed_action,
      v.spamassassin_is_spam, labels.label, v.created_at
    from mail_decision_verdicts v
    join labels on labels.message_id = v.message_id
    where v.org_id = ${input.orgId} and v.created_at >= ${since} and v.outcome = 'decided'
    order by v.created_at desc
    limit ${MAX_LABELLED_ROWS}
  `;
  return summarizeDecisionReport({
    days: input.days,
    since,
    until: input.now,
    config: input.config,
    outcomes,
    decided,
    usage,
    labelled,
  });
}

/** Pure report math, separated so the formulas are unit-tested without a database. */
export function summarizeDecisionReport(input: {
  readonly days: number;
  readonly since: Date;
  readonly until: Date;
  readonly config: ResolvedDecisionModelConfig;
  readonly outcomes: readonly { outcome: string; reason: string | null; count: number }[];
  readonly decided: readonly {
    verdict: string | null;
    proposed_action: string;
    action_taken: string;
    spamassassin_is_spam: boolean | null;
    count: number;
  }[];
  readonly usage: readonly {
    provider: string;
    model: string;
    calls: number;
    avg_latency: number | null;
    p95_latency: number | null;
    input_tokens: number;
    output_tokens: number;
  }[];
  readonly labelled: readonly LabelledRow[];
}): DecisionModelReport {
  const total = (outcome: string) =>
    input.outcomes
      .filter((row) => row.outcome === outcome)
      .reduce((sum, row) => sum + row.count, 0);
  const verdicts = { legitimate: 0, spam: 0, phishing: 0, scam: 0 };
  const proposedActions = { none: 0, spam: 0, phishing: 0, category: 0 };
  const actionsTaken = { none: 0, spam: 0, phishing: 0, category: 0 };
  let compared = 0;
  let agree = 0;
  let modelOnly = 0;
  let spamAssassinOnly = 0;
  for (const row of input.decided) {
    if (row.verdict !== null && row.verdict in verdicts) {
      verdicts[row.verdict as keyof typeof verdicts] += row.count;
    }
    if (row.proposed_action in proposedActions) {
      proposedActions[row.proposed_action as keyof typeof proposedActions] += row.count;
    }
    if (row.action_taken in actionsTaken) {
      actionsTaken[row.action_taken as keyof typeof actionsTaken] += row.count;
    }
    if (row.spamassassin_is_spam === null) continue;
    const flagged = isFlagged(row.proposed_action);
    compared += row.count;
    if (flagged === row.spamassassin_is_spam) agree += row.count;
    else if (flagged) modelOnly += row.count;
    else spamAssassinOnly += row.count;
  }
  const calls = input.usage.reduce((sum, row) => sum + row.calls, 0);
  const inputTokens = input.usage.reduce((sum, row) => sum + row.input_tokens, 0);
  const outputTokens = input.usage.reduce((sum, row) => sum + row.output_tokens, 0);
  const weightedLatency = input.usage.reduce(
    (sum, row) => sum + (row.avg_latency ?? 0) * row.calls,
    0,
  );
  const p95 = input.usage
    .map((row) => row.p95_latency)
    .filter((value): value is number => value !== null);
  const prices = input.usage.map((row) => ({
    price: decisionInputPricePerMillion(row.provider, row.model, input.config),
    tokens: row.input_tokens,
  }));
  const priced = prices.every((row) => row.price !== null);
  const disagreements = input.labelled
    .filter((row) => isFlagged(row.proposed_action) !== (row.label === "spam"))
    .slice(0, MAX_DISAGREEMENTS)
    .map((row) => ({
      messageId: row.message_id,
      senderDomain: row.sender_domain,
      verdict: row.verdict,
      confidence: row.verdict_confidence,
      userLabel: row.label,
      decidedAt: row.created_at.toISOString(),
    }));
  return {
    window: {
      days: input.days,
      since: input.since.toISOString(),
      until: input.until.toISOString(),
    },
    totals: {
      recorded: total("decided") + total("skipped") + total("error"),
      decided: total("decided"),
      skipped: total("skipped"),
      error: total("error"),
    },
    outcomes: input.outcomes.map((row) => ({ ...row })),
    verdicts,
    proposedActions,
    actionsTaken,
    spamAssassin: {
      compared,
      agree,
      agreementRate: ratio(agree, compared),
      modelOnly,
      spamAssassinOnly,
    },
    feedback: {
      model: confusion(input.labelled, (row) => isFlagged(row.proposed_action)),
      spamAssassin: confusion(
        input.labelled.filter((row) => row.spamassassin_is_spam !== null),
        (row) => row.spamassassin_is_spam === true,
      ),
    },
    latency: {
      averageMs: calls === 0 ? null : Math.round(weightedLatency / calls),
      p95Ms: p95.length === 0 ? null : Math.round(Math.max(...p95)),
    },
    tokens: {
      input: inputTokens,
      output: outputTokens,
      averageInputPerMessage: calls === 0 ? null : Math.round(inputTokens / calls),
    },
    cost: {
      estimatedUsd:
        prices.length === 0
          ? 0
          : priced
            ? roundUsd(prices.reduce((sum, row) => sum + ((row.price ?? 0) * row.tokens) / 1e6, 0))
            : null,
      priced,
    },
    disagreements,
  };
}

/** Confusion matrix against user labels: positive = the user said spam. */
export function confusion<T extends { readonly label: "spam" | "ham" }>(
  rows: readonly T[],
  predicted: (row: T) => boolean,
): ConfusionCounts {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const row of rows) {
    const positive = predicted(row);
    if (row.label === "spam") {
      if (positive) tp += 1;
      else fn += 1;
    } else if (positive) fp += 1;
    else tn += 1;
  }
  return {
    labelled: rows.length,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    falsePositiveRate: ratio(fp, fp + tn),
  };
}

function isFlagged(action: string): boolean {
  return action === "spam" || action === "phishing";
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
