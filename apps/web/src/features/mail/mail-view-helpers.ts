import {
  restoreMailThread,
  unarchiveMailThread,
  unsnoozeMailThread,
  type MailFolderKey,
  type MailThreadRow,
} from "./api";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** True when the beta AI/rules second pass — not spamd or a manual move — caught this thread. */
export function isBetaSpamCatch(row: Pick<MailThreadRow, "spamCatcher">): boolean {
  return row.spamCatcher === "ai" || row.spamCatcher === "rules";
}

export function restoreActionLabel(folder: MailFolderKey): string | null {
  if (folder === "trash") return "Restore";
  if (folder === "archive") return "Unarchive";
  if (folder === "snoozed") return "Unsnooze";
  return null;
}

export function reverseMailboxState(folder: MailFolderKey, threadId: string): Promise<void> {
  if (folder === "trash") return restoreMailThread(threadId);
  if (folder === "archive") return unarchiveMailThread(threadId);
  if (folder === "snoozed") return unsnoozeMailThread(threadId);
  return Promise.resolve();
}

/** Renders an ISO timestamp into a compact, mailbox-style display string. */
export function formatThreadTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((now.getTime() - date.getTime()) / dayMs);
  if (diffDays === 1) {
    return "Yesterday";
  }
  if (diffDays > 1 && diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
