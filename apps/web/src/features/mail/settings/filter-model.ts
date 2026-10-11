/* Filter dialog state and its two translations: criteria → a Gmail-style
   search query (for the match preview) and the whole draft → the
   `mail.filter.create/update` payload. */

import type { MailFilterCreateInput, MailFilterRecord, MailLabelSummary } from "../api";
import type { MailFilterPrefill } from "./dialog-store";

export interface FilterCriteriaDraft {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly hasWords: string;
  readonly hasAttachment: boolean;
}

export interface FilterActionsDraft {
  readonly skipInbox: boolean;
  readonly markRead: boolean;
  readonly star: boolean;
  /** Label slug, or "" for none. */
  readonly applyLabel: string;
  readonly delete: boolean;
}

export interface FilterDraft {
  readonly criteria: FilterCriteriaDraft;
  readonly actions: FilterActionsDraft;
  /** Saved actions this dialog does not edit, kept on save: snooze and any further labels. */
  readonly preserved: { readonly snoozeUntil?: string; readonly extraLabels: readonly string[] };
  readonly enabled: boolean;
}

const NO_ACTIONS: FilterActionsDraft = {
  skipInbox: false,
  markRead: false,
  star: false,
  applyLabel: "",
  delete: false,
};

export function filterDraftFromPrefill(prefill: MailFilterPrefill): FilterDraft {
  return {
    criteria: {
      from: prefill.from?.trim() ?? "",
      to: prefill.to?.trim() ?? "",
      subject: prefill.subject?.trim() ?? "",
      hasWords: prefill.hasWords?.trim() ?? "",
      hasAttachment: prefill.hasAttachment ?? false,
    },
    actions: NO_ACTIONS,
    preserved: { extraLabels: [] },
    enabled: true,
  };
}

export function filterDraftFromRecord(filter: MailFilterRecord): FilterDraft {
  const { criteria, actions } = filter;
  return {
    criteria: {
      from: criteria.fromContains ?? "",
      to: criteria.toContains ?? "",
      subject: criteria.subjectContains ?? "",
      hasWords: criteria.bodyContains ?? "",
      hasAttachment: criteria.hasAttachment ?? false,
    },
    actions: {
      skipInbox: actions.archive ?? false,
      markRead: actions.markRead ?? false,
      star: actions.star ?? false,
      applyLabel: actions.applyLabels?.[0] ?? "",
      delete: actions.delete ?? false,
    },
    preserved: {
      ...(actions.snoozeUntil === undefined ? {} : { snoozeUntil: actions.snoozeUntil }),
      extraLabels: actions.applyLabels?.slice(1) ?? [],
    },
    enabled: filter.enabled,
  };
}

export function hasFilterCriteria(criteria: FilterCriteriaDraft): boolean {
  return (
    criteria.from.trim() !== "" ||
    criteria.to.trim() !== "" ||
    criteria.subject.trim() !== "" ||
    criteria.hasWords.trim() !== "" ||
    criteria.hasAttachment
  );
}

export function hasFilterAction(draft: FilterDraft): boolean {
  const { actions } = draft;
  return (
    actions.skipInbox ||
    actions.markRead ||
    actions.star ||
    actions.applyLabel !== "" ||
    actions.delete ||
    draft.preserved.snoozeUntil !== undefined ||
    draft.preserved.extraLabels.length > 0
  );
}

/** A search term, quoted when it holds spaces; the parser has no escape for `"`. */
function term(value: string): string {
  const cleaned = value.trim().replaceAll('"', "");
  return /\s/u.test(cleaned) ? `"${cleaned}"` : cleaned;
}

/** The same criteria as Mail search operators, e.g. `from:ada@x.org has:attachment`. */
export function filterCriteriaQuery(criteria: FilterCriteriaDraft): string {
  return [
    criteria.from.trim() === "" ? null : `from:${term(criteria.from)}`,
    criteria.to.trim() === "" ? null : `to:${term(criteria.to)}`,
    criteria.subject.trim() === "" ? null : `subject:${term(criteria.subject)}`,
    criteria.hasWords.trim() === "" ? null : term(criteria.hasWords),
    criteria.hasAttachment ? "has:attachment" : null,
  ]
    .filter((part): part is string => part !== null && part.replaceAll('"', "") !== "")
    .join(" ");
}

export function filterPayload(draft: FilterDraft): MailFilterCreateInput {
  const { criteria, actions } = draft;
  const text = (value: string) => (value.trim() === "" ? undefined : value.trim());
  const from = text(criteria.from);
  const to = text(criteria.to);
  const subject = text(criteria.subject);
  const words = text(criteria.hasWords);
  const labels = [
    ...new Set([actions.applyLabel, ...draft.preserved.extraLabels].filter((slug) => slug !== "")),
  ];
  return {
    name: filterCriteriaQuery(criteria) || "Filter",
    enabled: draft.enabled,
    criteria: {
      ...(from === undefined ? {} : { fromContains: from }),
      ...(to === undefined ? {} : { toContains: to }),
      ...(subject === undefined ? {} : { subjectContains: subject }),
      ...(words === undefined ? {} : { bodyContains: words }),
      ...(criteria.hasAttachment ? { hasAttachment: true } : {}),
    },
    actions: {
      ...(actions.skipInbox ? { archive: true } : {}),
      ...(actions.markRead ? { markRead: true } : {}),
      ...(actions.star ? { star: true } : {}),
      ...(labels.length === 0 ? {} : { applyLabels: labels }),
      ...(actions.delete ? { delete: true } : {}),
      ...(draft.preserved.snoozeUntil === undefined
        ? {}
        : { snoozeUntil: draft.preserved.snoozeUntil }),
    },
  };
}

/** "Matches: from:ada subject:report" for the filters list. */
export function describeFilterCriteria(filter: MailFilterRecord): string {
  return filterCriteriaQuery(filterDraftFromRecord(filter).criteria) || "All incoming mail";
}

/** "Skip Inbox, Mark as read, Apply label “Reports”" for the filters list. */
export function describeFilterActions(
  filter: MailFilterRecord,
  labels: readonly MailLabelSummary[],
  formatDate: (iso: string) => string,
): string {
  const { actions } = filter;
  const labelName = (slug: string) =>
    labels.find((label) => label.slug === slug)?.name ?? `${slug} (removed)`;
  return [
    actions.archive === true ? "Skip Inbox" : null,
    actions.markRead === true ? "Mark as read" : null,
    actions.star === true ? "Star it" : null,
    ...(actions.applyLabels ?? []).map((slug) => `Apply label “${labelName(slug)}”`),
    actions.delete === true ? "Delete it" : null,
    actions.snoozeUntil === undefined ? null : `Snooze until ${formatDate(actions.snoozeUntil)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}
