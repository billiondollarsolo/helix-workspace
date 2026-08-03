/* Mail — shared types + static UI taxonomy.
 *
 * The seed thread/folder/label arrays that lived here have been removed.
 * Mail rows, folders, and labels now come exclusively from the live Mail
 * tools (`mail.threads.list`, `mail.folders.list`, `mail.labels.list`); the
 * shell surfaces loading / error / empty states for those queries instead
 * of a fabricated dataset. What remains here is the static category-tab
 * taxonomy and empty-state copy — UI configuration, not fabricated data. */

import type { IconName } from "@/components/icons";

export type MailFolderId =
  "inbox" | "starred" | "snoozed" | "sent" | "drafts" | "archive" | "spam" | "trash";

export type MailTabId = "primary" | "updates" | "promotions" | "social";

export interface MailFolder {
  readonly id: MailFolderId;
  readonly label: string;
  readonly icon: IconName;
  readonly count?: number;
}

export interface MailLabel {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

export interface MailTab {
  readonly id: MailTabId;
  readonly label: string;
  readonly icon: IconName;
}

export interface MailThread {
  readonly id: string;
  readonly tab: MailTabId;
  readonly from: string;
  readonly fromEmail?: string;
  readonly subject: string;
  readonly preview: string;
  readonly time: string;
  readonly unread?: boolean;
  readonly starred?: boolean;
  readonly labels: readonly string[];
  readonly hasAttachment?: boolean;
  readonly count?: number;
  readonly body?: string;
  readonly participants?: readonly string[];
}

/** Static inbox-category tab taxonomy. UI configuration, not fabricated data. */
export const MAIL_TABS: readonly MailTab[] = [
  { id: "primary", label: "Primary", icon: "Inbox" },
  { id: "updates", label: "Updates", icon: "Bell" },
  { id: "promotions", label: "Promotions", icon: "Tag" },
  { id: "social", label: "Social", icon: "Users" },
];

/** Folder ids that have a tailored empty-state message. */
export const MAIL_EMPTY_FOLDERS = [
  "drafts",
  "snoozed",
  "trash",
  "archive",
  "sent",
  "spam",
] as const satisfies readonly MailFolderId[];

export interface MailEmptyState {
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
}

export const MAIL_EMPTY_STATES: Readonly<Record<string, MailEmptyState>> = {
  drafts: {
    icon: "EditPen",
    title: "No drafts",
    body: "Messages you start writing show up here.",
  },
  snoozed: {
    icon: "Snooze",
    title: "No snoozed messages",
    body: "Snoozed messages reappear at the time you pick.",
  },
  trash: {
    icon: "Trash",
    title: "Trash is empty",
    body: "Items in trash are permanently deleted after 30 days.",
  },
  archive: {
    icon: "Archive",
    title: "No archived mail",
    body: "Archived threads stay searchable but stay out of your inbox.",
  },
  sent: {
    icon: "Send",
    title: "Nothing sent yet",
    body: "Messages you send appear here.",
  },
  spam: {
    icon: "Bell",
    title: "No spam",
    body: "Messages you report as spam (or that Helix auto-filters) show up here. Use Not spam if something is wrong.",
  },
};
