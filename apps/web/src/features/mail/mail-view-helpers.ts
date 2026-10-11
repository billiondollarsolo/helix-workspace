import type { CSSProperties } from "react";
import type { MailFolderKey, MailLabelSummary, MailThreadRow } from "./api";

/** True when the beta AI/rules second pass — not spamd or a manual move — caught this thread. */
export function isBetaSpamCatch(row: Pick<MailThreadRow, "spamCatcher">): boolean {
  return row.spamCatcher === "ai" || row.spamCatcher === "rules";
}

/** The toolbar's way back out of a folder, e.g. "Move to Inbox" from Trash. */
export function restoreActionLabel(folder: MailFolderKey): string | null {
  if (folder === "trash" || folder === "archive") return "Move to Inbox";
  if (folder === "snoozed") return "Unsnooze";
  return null;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/u)[0] ?? name;
}

/**
 * The sender column: "Samara Lee" for one person, "Samara, me (3)" for a
 * conversation, "Samara .. Ravi, me (6)" when more people joined than fit.
 * Drafts and scheduled sends list recipients (the caller adds "Draft").
 */
export function participantsLabel(
  row: Pick<MailThreadRow, "participants" | "from" | "messageCount">,
): string {
  const people = row.participants.map((person) =>
    person.isMe ? "me" : person.name || person.email,
  );
  if (people.length === 0) people.push(row.from);
  let names: string;
  if (people.length === 1) {
    names = people[0] ?? "";
  } else if (people.length <= 3) {
    names = people.map(firstName).join(", ");
  } else {
    const [first] = people;
    names = `${firstName(first ?? "")} .. ${people.slice(-2).map(firstName).join(", ")}`;
  }
  return row.messageCount > 1 ? `${names} (${String(row.messageCount)})` : names;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const NUMERIC_DATE = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
});
const FULL_DATE = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** List date: the time today, "Mar 4" this year, "3/4/2025" before that. */
export function formatThreadTime(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (date.toDateString() === now.toDateString()) return TIME.format(date);
  if (date.getFullYear() === now.getFullYear()) return MONTH_DAY.format(date);
  return NUMERIC_DATE.format(date);
}

/** Message header date, e.g. "Tue, Mar 4, 2026, 10:42 AM". */
export function formatFullDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : FULL_DATE.format(date);
}

/** "3 hours ago", "yesterday", "5 days ago"; empty past a month. */
export function formatRelativeTime(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  const diffMs = date.getTime() - now.getTime();
  if (Number.isNaN(diffMs)) return "";
  const minutes = Math.round(diffMs / 60_000);
  if (Math.abs(minutes) < 1) return "just now";
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) <= 30) return RELATIVE.format(days, "day");
  return "";
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded)} ${BYTE_UNITS[unit] ?? "B"}`;
}

/** Chip colours for a label: the tinted `--label-<name>-soft` fill keeps contrast with body text. */
export function labelChipStyle(label: Pick<MailLabelSummary, "colorName">): CSSProperties {
  return { background: `var(--label-${label.colorName}-soft)`, color: "var(--text)" };
}

export function labelDotStyle(label: Pick<MailLabelSummary, "colorName">): CSSProperties {
  return { background: `var(--label-${label.colorName})` };
}

/** Follow a link from a menu item: a download, or a page in a new tab. */
export function followLink(href: string, options: { readonly download?: string } = {}): void {
  const link = document.createElement("a");
  link.href = href;
  link.rel = "noopener noreferrer";
  if (options.download === undefined) link.target = "_blank";
  else link.download = options.download;
  document.body.append(link);
  link.click();
  link.remove();
}
