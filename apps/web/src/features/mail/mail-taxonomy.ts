import {
  Archive,
  Clock,
  File,
  Inbox,
  Mails,
  OctagonAlert,
  Search,
  Send,
  SendHorizontal,
  Star,
  Tag,
  Trash2,
  Users,
  Info,
  type LucideIcon,
} from "lucide-react";
import type { MailFolderKey } from "./api";

export type MailTabId = "primary" | "promotions" | "social" | "updates";

interface MailTab {
  readonly id: MailTabId;
  readonly label: string;
  readonly icon: LucideIcon;
}

/** Inbox category tabs, in the familiar order. Shown only in the Inbox. */
export const MAIL_TABS: readonly MailTab[] = [
  { id: "primary", label: "Primary", icon: Inbox },
  { id: "promotions", label: "Promotions", icon: Tag },
  { id: "social", label: "Social", icon: Users },
  { id: "updates", label: "Updates", icon: Info },
];

export const MAIL_TAB_IDS = MAIL_TABS.map((tab) => tab.id);

interface MailFolderMeta {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly emptyTitle: string;
  readonly emptyBody: string;
}

export const MAIL_FOLDERS: Readonly<Record<MailFolderKey, MailFolderMeta>> = {
  inbox: {
    label: "Inbox",
    icon: Inbox,
    emptyTitle: "Your inbox is clear",
    emptyBody: "New conversations land here.",
  },
  starred: {
    label: "Starred",
    icon: Star,
    emptyTitle: "No starred conversations",
    emptyBody: "Star a conversation to find it here quickly.",
  },
  snoozed: {
    label: "Snoozed",
    icon: Clock,
    emptyTitle: "No snoozed conversations",
    emptyBody: "Snoozed conversations come back to your inbox at the time you pick.",
  },
  sent: {
    label: "Sent",
    icon: Send,
    emptyTitle: "No conversations in Sent",
    emptyBody: "Messages you send show up here.",
  },
  drafts: {
    label: "Drafts",
    icon: File,
    emptyTitle: "No drafts",
    emptyBody: "Messages you start writing are saved here.",
  },
  scheduled: {
    label: "Scheduled",
    icon: SendHorizontal,
    emptyTitle: "Nothing scheduled",
    emptyBody: "Messages you schedule to send later wait here.",
  },
  all: {
    label: "All Mail",
    icon: Mails,
    emptyTitle: "No conversations in All Mail",
    emptyBody: "Everything except Spam and Trash shows up here.",
  },
  archive: {
    label: "Archive",
    icon: Archive,
    emptyTitle: "No archived conversations",
    emptyBody: "Archived conversations leave the inbox but stay searchable.",
  },
  spam: {
    label: "Spam",
    icon: OctagonAlert,
    emptyTitle: "No spam here",
    emptyBody: "Messages reported as spam, or caught by filters, land here.",
  },
  trash: {
    label: "Trash",
    icon: Trash2,
    emptyTitle: "Trash is empty",
    emptyBody: "Conversations in Trash are deleted for good after 30 days.",
  },
};

/** Sidebar order: the main folders, then the ones under "More". */
export const PRIMARY_FOLDERS: readonly MailFolderKey[] = [
  "inbox",
  "starred",
  "snoozed",
  "sent",
  "drafts",
  "scheduled",
];
export const MORE_FOLDERS: readonly MailFolderKey[] = ["all", "archive", "spam", "trash"];

export const SEARCH_EMPTY = {
  icon: Search,
  title: "No messages matched your search",
  body: "Try other words, or use Search options to look in a different place.",
} as const;

export const LABEL_EMPTY = {
  icon: Tag,
  title: "No conversations with this label",
  body: "Label conversations from the toolbar, or drag them onto the label.",
} as const;

export function isMailFolderKey(value: unknown): value is MailFolderKey {
  return typeof value === "string" && Object.hasOwn(MAIL_FOLDERS, value);
}

/** Only these folders show a count: unread for Inbox, the total for Drafts. */
export function folderCount(folder: {
  readonly id: MailFolderKey;
  readonly total: number;
  readonly unread: number;
}): number {
  if (folder.id === "inbox") return folder.unread;
  if (folder.id === "drafts") return folder.total;
  return 0;
}
