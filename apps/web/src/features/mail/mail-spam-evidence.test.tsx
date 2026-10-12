// @vitest-environment jsdom

import type { MailDecisionEvidence } from "@helix/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, click, mount, unmountAll } from "@/test/ui";
import type { MailFolderKey, MailThreadDetail, MailThreadRow } from "./api";
import { decisionEvidenceFor, MailSpamEvidence } from "./mail-spam-evidence";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function evidence(overrides: Partial<MailDecisionEvidence> = {}): MailDecisionEvidence {
  return {
    provider: "cloudflare",
    model: "clef-flash",
    verdict: "spam",
    confidence: 0.94,
    phishing: false,
    action: "spam",
    category: null,
    needsReply: null,
    urgency: null,
    decidedAt: "2026-10-12T10:00:00.000Z",
    ...overrides,
  };
}

function row(overrides: Partial<MailThreadRow> = {}): MailThreadRow {
  return {
    threadId: "t-1",
    messageId: "m-1",
    from: "Prize Desk",
    fromEmail: "win@prizes.example",
    subject: "You won",
    preview: "Claim now",
    time: "2026-10-12T10:00:00.000Z",
    unread: true,
    starred: false,
    hasAttachment: false,
    labels: [],
    messageCount: 1,
    participants: [],
    category: "primary",
    folder: "spam",
    ...overrides,
  } as MailThreadRow;
}

function detailWith(...decisions: (MailDecisionEvidence | undefined)[]): MailThreadDetail {
  return {
    messages: decisions.map((decision, index) => ({
      id: `m-${String(index)}`,
      to: [],
      cc: [],
      bcc: [],
      sentAt: "2026-10-12T10:00:00.000Z",
      body: "",
      bodyFormat: "plain",
      hasAttachment: false,
      attachments: [],
      ...(decision === undefined ? {} : { decision }),
    })),
  } as unknown as MailThreadDetail;
}

function render(props: {
  row: MailThreadRow;
  detail?: MailThreadDetail | null;
  folder?: MailFolderKey;
  onAction?: (action: unknown) => void;
}) {
  return mount(
    <MailSpamEvidence
      row={props.row}
      detail={props.detail ?? null}
      folder={props.folder ?? "spam"}
      onAction={props.onAction ?? vi.fn()}
    />,
  );
}

afterEach(unmountAll);

describe("MailSpamEvidence", () => {
  it("explains a decision-model spam move with its confidence and keeps Not spam working", async () => {
    const onAction = vi.fn();
    const { container } = render({
      row: row({ spamCatcher: "decision-model", decision: evidence() }),
      onAction,
    });
    const banner = container.querySelector('[role="status"]');
    expect(banner?.textContent).toContain(
      "Moved to Spam by the Helix AI decision model — spam, 94% confidence.",
    );
    const notSpam = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "No, not spam",
    );
    click(notSpam ?? null);
    expect(onAction).toHaveBeenCalledWith({ kind: "notSpam" });
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows likely phishing as an alert with a strong warning, in any folder", async () => {
    const phishing = evidence({
      verdict: "phishing",
      phishing: true,
      action: "phishing",
      confidence: 0.93,
    });
    const { container } = render({
      row: row({ folder: "inbox" }),
      detail: detailWith(phishing),
      folder: "inbox",
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.classList.contains("mail-banner-danger")).toBe(true);
    expect(alert?.textContent).toContain(
      "Likely phishing — don't click links or reply with information.",
    );
    expect(alert?.textContent).toContain("phishing, 93% confidence");
    expect(container.querySelector("button")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("offers Yes/No feedback on a phishing catch in Spam", () => {
    const onAction = vi.fn();
    const phishing = evidence({ verdict: "phishing", phishing: true, action: "phishing" });
    const { container } = render({ row: row({ decision: phishing }), onAction });
    const yes = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Yes, spam",
    );
    click(yes ?? null);
    expect(onAction).toHaveBeenCalledWith({ kind: "spam" });
  });

  it("stays quiet for a non-phishing verdict once the thread left Spam", () => {
    const { container } = render({ row: row({ decision: evidence() }), folder: "inbox" });
    expect(container.textContent).toBe("");
  });

  it("keeps the beta second-pass banner", () => {
    const { container } = render({ row: row({ spamCatcher: "ai" }) });
    expect(container.textContent).toContain("Caught by Helix AI spam (beta).");
  });

  it("omits confidence when the model gave none", () => {
    const { container } = render({ row: row({ decision: evidence({ confidence: null }) }) });
    expect(container.textContent).toContain("by the Helix AI decision model — spam.");
  });
});

describe("decisionEvidenceFor", () => {
  it("prefers the latest phishing warning, then the latest move, over category-only verdicts", () => {
    const category = evidence({ action: "category", verdict: "legitimate", category: "updates" });
    const spam = evidence({ confidence: 0.91 });
    const phishing = evidence({ phishing: true, action: "phishing", verdict: "phishing" });
    expect(decisionEvidenceFor(row(), detailWith(spam, category))).toBe(spam);
    expect(decisionEvidenceFor(row(), detailWith(phishing, spam))).toBe(phishing);
    expect(decisionEvidenceFor(row(), detailWith(category))).toBeUndefined();
  });

  it("falls back to the list row until the thread has loaded", () => {
    const spam = evidence();
    expect(decisionEvidenceFor(row({ decision: spam }), undefined)).toBe(spam);
    expect(decisionEvidenceFor(row({ decision: spam }), detailWith(undefined))).toBeUndefined();
  });
});
