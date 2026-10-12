/* Admin → Mail → Spam filtering → AI decision model report: how the model did
 * (enforce) or would have done (shadow) against SpamAssassin and against
 * people's own "Spam" / "Not spam" actions, plus latency, tokens and cost. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { AdminSelect } from "@/features/admin/console/controls";
import { formatCount } from "@/features/admin/console/format";
import {
  EmptyRow,
  LoadingState,
  PanelHeading,
  QueryFailureBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import { AdminTable, type AdminColumn } from "@/features/admin/console/table";
import { RelativeTime } from "@/features/admin/console/widgets";
import {
  REPORT_WINDOWS,
  decisionModelQueryKeys,
  decisionModelReportQueryOptions,
  type DecisionConfusion,
  type DecisionModelReport,
} from "./mail-decision-model-api";
import { formatConfidence } from "./mail-decision-model-form";

/** 0.0123 → "1.2%"; null → "—". */
function formatRate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

const OUTCOME_REASON_LABELS: Readonly<Record<string, string>> = {
  daily_cap: "Daily message limit reached",
  credential_missing: "No API key stored",
  credential_unreadable: "Stored API key could not be read",
  classified_confidential: "Labelled confidential (never sent)",
  classified_restricted: "Labelled restricted (never sent)",
  invalid_response: "Provider sent an unusable answer",
  unauthorized: "Provider rejected the API key",
  rate_limited: "Provider rate limit",
  timeout: "Provider timed out",
  provider_unavailable: "Provider unavailable",
};

function reasonLabel(reason: string | null): string {
  if (reason === null) return "—";
  return OUTCOME_REASON_LABELS[reason] ?? reason.replace(/_/gu, " ");
}

function Stat({
  label,
  value,
  children,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="panel p-4">
      <h3 className="type-caption text-muted-foreground font-semibold uppercase [letter-spacing:.06em] m-0">
        {label}
      </h3>
      <div className="type-h1 font-bold mt-2">{value}</div>
      {children === undefined ? null : (
        <div className="type-caption text-muted-foreground mt-1">{children}</div>
      )}
    </div>
  );
}

interface FeedbackRow {
  readonly id: "model" | "spamAssassin";
  readonly label: string;
  readonly counts: DecisionConfusion;
}

function ratioCell(row: FeedbackRow, value: number | null): string {
  return row.counts.labelled === 0 ? "—" : formatRate(value);
}

const FEEDBACK_COLUMNS: readonly AdminColumn<FeedbackRow>[] = [
  { id: "filter", header: "Filter", cell: (row) => row.label },
  {
    id: "labelled",
    header: "Labelled by people",
    align: "right",
    cell: (row) =>
      row.counts.labelled === 0 ? "Not enough feedback yet" : formatCount(row.counts.labelled),
  },
  {
    id: "fpr",
    header: "False-positive rate",
    align: "right",
    cell: (row) => <strong>{ratioCell(row, row.counts.falsePositiveRate)}</strong>,
  },
  {
    id: "precision",
    header: "Precision",
    align: "right",
    cell: (row) => ratioCell(row, row.counts.precision),
  },
  {
    id: "recall",
    header: "Recall",
    align: "right",
    cell: (row) => ratioCell(row, row.counts.recall),
  },
  {
    id: "counts",
    header: "Caught / wrongly flagged / missed",
    align: "right",
    cell: (row) =>
      row.counts.labelled === 0
        ? "—"
        : `${formatCount(row.counts.truePositives)} / ${formatCount(row.counts.falsePositives)} / ${formatCount(row.counts.falseNegatives)}`,
  },
];

type Disagreement = DecisionModelReport["disagreements"][number];

const DISAGREEMENT_COLUMNS: readonly AdminColumn<Disagreement>[] = [
  { id: "when", header: "Decided", cell: (row) => <RelativeTime value={row.decidedAt} /> },
  { id: "sender", header: "Sender domain", cell: (row) => row.senderDomain ?? "—" },
  {
    id: "verdict",
    header: "Model said",
    cell: (row) =>
      row.verdict === null ? "—" : `${row.verdict} (${formatConfidence(row.confidence)})`,
  },
  {
    id: "label",
    header: "Person said",
    cell: (row) => (row.userLabel === "spam" ? "Spam" : "Not spam"),
  },
];

type Outcome = DecisionModelReport["outcomes"][number];

const OUTCOME_COLUMNS: readonly AdminColumn<Outcome>[] = [
  {
    id: "outcome",
    header: "Outcome",
    cell: (row) => (row.outcome === "error" ? "Error" : "Skipped"),
  },
  { id: "reason", header: "Reason", cell: (row) => reasonLabel(row.reason) },
  { id: "count", header: "Messages", align: "right", cell: (row) => formatCount(row.count) },
];

export function DecisionModelReportPanel() {
  const uid = useId();
  const [days, setDays] = useState<number>(30);
  const queryClient = useQueryClient();
  const query = useQuery(decisionModelReportQueryOptions(days));
  const failure = useQueryFailure(query, () => {
    void queryClient.invalidateQueries({ queryKey: decisionModelQueryKeys.report(days) });
  });
  const report = query.data?.report;

  return (
    <section className="admin-card" aria-labelledby={`${uid}-heading`}>
      <PanelHeading
        id={`${uid}-heading`}
        title="AI decision model report"
        subtitle="People's own Spam and Not spam actions are the ground truth."
        actions={
          <label className="flex items-center gap-2">
            <span className="admin-field-label">Report window</span>
            <AdminSelect
              value={String(days)}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              {REPORT_WINDOWS.map((window) => (
                <option key={window} value={String(window)}>
                  Last {window} days
                </option>
              ))}
            </AdminSelect>
          </label>
        }
      />
      {failure !== null ? (
        <QueryFailureBanner
          summary="Couldn't load the AI decision model report"
          subject="the AI decision model report"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
        />
      ) : report === undefined ? (
        <LoadingState label="Loading the AI decision model report…" />
      ) : (
        <ReportBody report={report} />
      )}
    </section>
  );
}

function ReportBody({ report }: { readonly report: DecisionModelReport }) {
  const days = report.window.days;
  if (report.totals.recorded === 0) {
    return (
      <EmptyRow>
        No mail was sent to the model in the last {days} days. Turn on shadow mode to start
        collecting verdicts without changing anyone's mailbox.
      </EmptyRow>
    );
  }
  const { totals, verdicts, spamAssassin, feedback, latency, tokens, cost } = report;
  const feedbackRows: FeedbackRow[] = [
    { id: "model", label: "AI decision model", counts: feedback.model },
    { id: "spamAssassin", label: "SpamAssassin", counts: feedback.spamAssassin },
  ];
  const noFeedback = feedback.model.labelled === 0 && feedback.spamAssassin.labelled === 0;
  const skippedOrFailed = report.outcomes.filter((row) => row.outcome !== "decided");

  return (
    <div className="admin-stack">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Messages classified" value={formatCount(totals.decided)}>
          {formatCount(totals.recorded)} recorded · {formatCount(totals.skipped)} skipped ·{" "}
          {formatCount(totals.error)} errors
        </Stat>
        <Stat
          label="Flagged"
          value={formatCount(report.proposedActions.spam + report.proposedActions.phishing)}
        >
          Spam {formatCount(verdicts.spam)} · Phishing {formatCount(verdicts.phishing)} · Scam{" "}
          {formatCount(verdicts.scam)} · Legitimate {formatCount(verdicts.legitimate)}. Moved by
          Helix: {formatCount(report.actionsTaken.spam + report.actionsTaken.phishing)}
        </Stat>
        <Stat label="Agrees with SpamAssassin" value={formatRate(spamAssassin.agreementRate)}>
          {formatCount(spamAssassin.compared)} compared · model only{" "}
          {formatCount(spamAssassin.modelOnly)} · SpamAssassin only{" "}
          {formatCount(spamAssassin.spamAssassinOnly)}
        </Stat>
        <Stat
          label="Latency"
          value={latency.averageMs === null ? "—" : `${formatCount(latency.averageMs)} ms`}
        >
          Average · p95 {latency.p95Ms === null ? "—" : `${formatCount(latency.p95Ms)} ms`}
        </Stat>
        <Stat label="Input tokens" value={formatCount(tokens.input)}>
          {tokens.averageInputPerMessage === null
            ? "No provider calls"
            : `${formatCount(tokens.averageInputPerMessage)} per message`}{" "}
          · {formatCount(tokens.output)} output
        </Stat>
        <Stat label="Estimated cost" value={formatUsd(cost.estimatedUsd)}>
          {cost.priced
            ? `Input tokens at list price over ${String(days)} days`
            : "No published price for this model — set a price per million input tokens above."}
        </Stat>
      </div>

      <div className="grid gap-2">
        <h3 className="type-body-sm font-semibold m-0">Accuracy against people's feedback</h3>
        <p className="admin-muted">
          The false-positive rate is the share of mail people kept that was flagged — keep it near
          zero before you enforce.
        </p>
        {noFeedback ? (
          <EmptyRow>
            Not enough feedback yet. Precision, recall and the false-positive rate appear once
            people mark classified mail as Spam or Not spam.
          </EmptyRow>
        ) : (
          <AdminTable
            label="Accuracy against people's feedback"
            columns={FEEDBACK_COLUMNS}
            rows={feedbackRows}
            rowKey={(row) => row.id}
          />
        )}
      </div>

      {skippedOrFailed.length === 0 ? null : (
        <div className="grid gap-2">
          <h3 className="type-body-sm font-semibold m-0">Skipped and failed</h3>
          <AdminTable
            label="Skipped and failed messages"
            columns={OUTCOME_COLUMNS}
            rows={skippedOrFailed}
            rowKey={(row) => `${row.outcome}:${row.reason ?? ""}`}
          />
        </div>
      )}

      <div className="grid gap-2">
        <h3 className="type-body-sm font-semibold m-0">Where people disagreed with the model</h3>
        <AdminTable
          label="Where people disagreed with the model"
          columns={DISAGREEMENT_COLUMNS}
          rows={report.disagreements}
          rowKey={(row) => row.messageId}
          empty={<EmptyRow>No disagreements in this window.</EmptyRow>}
        />
      </div>
    </div>
  );
}
