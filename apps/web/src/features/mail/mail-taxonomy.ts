import { type IconName } from "@/components/icon-map";

export type MailTabId = "primary" | "updates" | "promotions" | "social";

export interface MailTab {
  readonly id: MailTabId;
  readonly label: string;
  readonly icon: IconName;
}

/** Static inbox-category tab taxonomy. UI configuration, not fabricated data. */
export const MAIL_TABS: readonly MailTab[] = [
  { id: "primary", label: "Primary", icon: "Inbox" },
  { id: "updates", label: "Updates", icon: "Bell" },
  { id: "promotions", label: "Promotions", icon: "Tag" },
  { id: "social", label: "Social", icon: "Users" },
];

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
