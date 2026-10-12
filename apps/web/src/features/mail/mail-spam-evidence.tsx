/* Why a conversation is in Spam, shown above its messages: the AI decision
   model's verdict (with a strong warning for likely phishing) or the beta AI /
   rules second pass. In the Spam folder it asks whether the call was right. */

import type { MailDecisionEvidence } from "@helix/contracts";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MailFolderKey, MailThreadDetail, MailThreadRow } from "./api";
import type { MailAction } from "./mail-actions";
import { isBetaSpamCatch } from "./mail-view-helpers";

function moved(evidence: MailDecisionEvidence): boolean {
  return evidence.action === "spam" || evidence.action === "phishing";
}

/**
 * The decision-model evidence worth showing for a conversation: the latest
 * phishing warning if any message has one, else the latest message the model
 * moved to Spam. Falls back to the list row before the thread has loaded.
 */
export function decisionEvidenceFor(
  row: Pick<MailThreadRow, "decision">,
  detail: Pick<MailThreadDetail, "messages"> | null | undefined,
): MailDecisionEvidence | undefined {
  const all = [
    ...(detail?.messages ?? []).map((message) => message.decision),
    ...(detail === null || detail === undefined ? [row.decision] : []),
  ].filter((evidence): evidence is MailDecisionEvidence => evidence !== undefined);
  return all.findLast((evidence) => evidence.phishing) ?? all.findLast(moved);
}

/** "spam, 94% confidence" */
function verdictText(evidence: MailDecisionEvidence): string {
  return evidence.confidence === null
    ? evidence.verdict
    : `${evidence.verdict}, ${String(Math.round(evidence.confidence * 100))}% confidence`;
}

function FeedbackButtons({ onAction }: { readonly onAction: (action: MailAction) => void }) {
  return (
    <>
      <Button type="button" size="sm" onClick={() => onAction({ kind: "spam" })}>
        Yes, spam
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onAction({ kind: "notSpam" })}
      >
        No, not spam
      </Button>
    </>
  );
}

export function MailSpamEvidence({
  row,
  detail,
  folder,
  onAction,
}: {
  readonly row: MailThreadRow;
  readonly detail: MailThreadDetail | null | undefined;
  readonly folder: MailFolderKey;
  readonly onAction: (action: MailAction) => void;
}) {
  const inSpam = folder === "spam";
  const evidence = decisionEvidenceFor(row, detail);

  if (evidence?.phishing === true) {
    return (
      <div role="alert" className="mail-banner mail-banner-danger">
        <ShieldAlert aria-hidden="true" className="mail-banner-icon" />
        <span className="flex-1">
          <strong>Likely phishing — don't click links or reply with information.</strong> Flagged by
          the Helix AI decision model — {verdictText(evidence)}.
          {inSpam ? " Was this correct?" : null}
        </span>
        {inSpam ? <FeedbackButtons onAction={onAction} /> : null}
      </div>
    );
  }

  /* Outside Spam a non-phishing verdict is old news: someone already said "Not spam". */
  if (inSpam && (evidence !== undefined || row.spamCatcher === "decision-model")) {
    return (
      <div role="status" className="mail-banner">
        <span className="flex-1">
          Moved to Spam by the Helix AI decision model
          {evidence === undefined ? "" : ` — ${verdictText(evidence)}`}. Was this correct?
        </span>
        <FeedbackButtons onAction={onAction} />
      </div>
    );
  }

  if (!isBetaSpamCatch(row)) return null;
  return (
    <div role="status" className="mail-banner">
      <span className="flex-1">
        {row.spamCatcher === "ai"
          ? "Caught by Helix AI spam (beta)."
          : "Caught by Helix spam rules (beta)."}{" "}
        Was this correct?
      </span>
      {inSpam ? <FeedbackButtons onAction={onAction} /> : null}
    </div>
  );
}
