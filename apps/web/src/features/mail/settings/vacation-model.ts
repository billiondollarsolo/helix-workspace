/* Vacation responder form: dates are whole local days. The first day starts
   at local midnight; the last day runs to the end of that day. */

import type { MailVacationSetInput, MailVacationSettings } from "../api";

export interface VacationDraft {
  readonly enabled: boolean;
  /** `YYYY-MM-DD`. */
  readonly firstDay: string;
  readonly hasLastDay: boolean;
  /** `YYYY-MM-DD`. */
  readonly lastDay: string;
  readonly subject: string;
  readonly message: string;
}

export type VacationField = "firstDay" | "lastDay" | "subject" | "message";
export type VacationErrors = Partial<Record<VacationField, string>>;

const MAX_SUBJECT_LENGTH = 998;

/** The local calendar day of `date` as `YYYY-MM-DD`. */
function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfLocalDay(day: string): Date {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

export function vacationDraftFromSettings(
  settings: MailVacationSettings | null,
  today: Date,
): VacationDraft {
  const lastDay =
    settings?.endsAt == null ? null : localDay(new Date(new Date(settings.endsAt).getTime() - 1));
  return {
    enabled: settings?.enabled ?? false,
    firstDay: settings?.startsAt == null ? localDay(today) : localDay(new Date(settings.startsAt)),
    hasLastDay: lastDay !== null,
    lastDay: lastDay ?? "",
    subject: settings?.subject ?? "",
    message: settings?.body ?? "",
  };
}

export function validateVacationDraft(draft: VacationDraft): VacationErrors {
  const errors: VacationErrors = {};
  if (draft.subject.length > MAX_SUBJECT_LENGTH) {
    errors.subject = `Use at most ${String(MAX_SUBJECT_LENGTH)} characters.`;
  }
  if (!draft.enabled) return errors;
  if (draft.firstDay === "") errors.firstDay = "Choose the first day.";
  if (draft.hasLastDay) {
    if (draft.lastDay === "") errors.lastDay = "Choose the last day, or clear Last day.";
    else if (draft.firstDay !== "" && draft.lastDay < draft.firstDay) {
      errors.lastDay = "The last day can't be before the first day.";
    }
  }
  if (draft.subject.trim() === "") errors.subject = "Add a subject.";
  if (draft.message.trim() === "") errors.message = "Write the reply people will get.";
  return errors;
}

export function vacationInputFromDraft(draft: VacationDraft): MailVacationSetInput {
  const lastDay = draft.hasLastDay && draft.lastDay !== "" ? draft.lastDay : null;
  let endsAt: string | null = null;
  if (lastDay !== null) {
    const nextDay = startOfLocalDay(lastDay);
    nextDay.setDate(nextDay.getDate() + 1);
    endsAt = new Date(nextDay.getTime() - 1).toISOString();
  }
  return {
    enabled: draft.enabled,
    subject: draft.subject.trim(),
    body: draft.message,
    startsAt: draft.firstDay === "" ? null : startOfLocalDay(draft.firstDay).toISOString(),
    endsAt,
  };
}
