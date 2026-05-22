/* Mail seed data — ported from the design handoff (app-mail.jsx THREADS /
   MAIL_LABELS). The backend `api.ts` covers search/thread/send tools, but the
   handoff's list view is modelled around folders, category tabs, and
   pre-rendered preview strings that the search API does not expose. This
   typed seed keeps the surface fully functional and faithful to the handoff. */

import type { IconName } from "@/components/icons";

export type MailFolderId =
  | "inbox"
  | "starred"
  | "snoozed"
  | "sent"
  | "drafts"
  | "archive"
  | "trash";

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

export const MAIL_FOLDERS: readonly MailFolder[] = [
  { id: "inbox", label: "Inbox", icon: "Inbox", count: 24 },
  { id: "starred", label: "Starred", icon: "Star", count: 7 },
  { id: "snoozed", label: "Snoozed", icon: "Snooze", count: 3 },
  { id: "sent", label: "Sent", icon: "Send" },
  { id: "drafts", label: "Drafts", icon: "EditPen", count: 2 },
  { id: "archive", label: "Archive", icon: "Archive" },
  { id: "trash", label: "Trash", icon: "Trash" },
];

export const MAIL_LABELS: readonly MailLabel[] = [
  { id: "team", label: "Team", color: "#7c3aed" },
  { id: "customers", label: "Customers", color: "#0891b2" },
  { id: "finance", label: "Finance", color: "#059669" },
  { id: "urgent", label: "Urgent", color: "#dc2626" },
  { id: "ext", label: "External", color: "#ea580c" },
];

export const MAIL_TABS: readonly MailTab[] = [
  { id: "primary", label: "Primary", icon: "Inbox" },
  { id: "updates", label: "Updates", icon: "Bell" },
  { id: "promotions", label: "Promotions", icon: "Tag" },
  { id: "social", label: "Social", icon: "Users" },
];

export const MAIL_THREADS: readonly MailThread[] = [
  {
    id: "t1",
    tab: "primary",
    from: "Mira Okafor",
    fromEmail: "mira@helix.io",
    subject: "Q3 roadmap — final sign-off needed by Friday",
    preview:
      "Here's the consolidated roadmap with the changes we discussed in Monday's sync. Three open items still need product review before…",
    time: "10:42 AM",
    unread: true,
    starred: true,
    labels: ["team", "urgent"],
    hasAttachment: true,
    body: `Hi Alex,

Here's the consolidated roadmap with the changes we discussed in Monday's sync. Three open items still need product review before we share with the leadership team on Friday:

1. The migration window for Atlas customers — I'd like to push to Q4 if possible
2. Hiring plan for the platform team (Jonas is drafting)
3. Whether we hold the line on the new pricing tier or revise post-customer feedback

Could we get 30 minutes today to walk through? I'm free between 2 and 4.

Mira`,
    participants: ["mira", "alex", "jonas"],
  },
  {
    id: "t2",
    tab: "primary",
    from: "Helix Security",
    fromEmail: "security@helix.io",
    subject: "Weekly security digest — 2 anomalies flagged",
    preview:
      "This week we observed 2 sign-in anomalies from new geographies, both verified by the user. Full report inside…",
    time: "9:15 AM",
    unread: true,
    starred: false,
    labels: ["urgent"],
    body: "Weekly digest covering sign-in anomalies, MFA enrollment progress, and policy violations.",
  },
  {
    id: "t3",
    tab: "primary",
    from: "Priya Anand",
    subject: "Design review — new onboarding flow",
    preview:
      "I've uploaded the latest mocks to Drive. The big change is moving SSO selection before account details. WDYT?",
    time: "Yesterday",
    unread: true,
    starred: false,
    labels: ["team"],
    hasAttachment: true,
  },
  {
    id: "t4",
    tab: "primary",
    from: "Naveen Iyer, Owen Hart",
    count: 4,
    subject: "Re: Pricing experiment results",
    preview:
      "Owen — agreed, the lift on annual is real but I'm not convinced the monthly cohort is statistically meaningful yet. Naveen…",
    time: "Yesterday",
    unread: false,
    starred: true,
    labels: ["finance"],
  },
  {
    id: "t5",
    tab: "primary",
    from: "Daniel Cho",
    subject: "Postmortem: auth service incident 05/15",
    preview:
      "Writing this up now. TLDR: stale TLS cert in the staging mesh propagated to prod after the routing change.",
    time: "Yesterday",
    unread: false,
    starred: false,
    labels: ["team"],
  },
  {
    id: "t6",
    tab: "primary",
    from: "Rumi Tanaka",
    subject: "Atlas Holdings — they want to renew early",
    preview:
      "Talked to Caroline today. They want to lock in current pricing through 2027. Worth a chat?",
    time: "Mon",
    unread: false,
    starred: false,
    labels: ["customers"],
  },
  {
    id: "t7",
    tab: "primary",
    from: "Sasha Levin",
    count: 7,
    subject: "Re: Re: Engineering manager candidates",
    preview:
      "Final round for Maya Chen this Thursday. Loop is set with you, Jonas, Priya. Bringing two onsite next week as well.",
    time: "Mon",
    unread: false,
    starred: false,
    labels: ["team"],
  },
  {
    id: "t8",
    tab: "primary",
    from: "Theo Marchetti",
    subject: "Customer escalation — Northwind",
    preview:
      "They've hit the API rate limit three times this month. Recommending we either bump them up or have a hard conversation about usage.",
    time: "Mon",
    unread: false,
    starred: false,
    labels: ["customers", "urgent"],
  },
  {
    id: "t9",
    tab: "primary",
    from: "Iris Lambert",
    subject: "DPA template — please review tracked changes",
    preview:
      "Updated the data processing addendum based on EU AI Act guidance. Most changes are in §4 and §7.",
    time: "Sun",
    unread: false,
    starred: false,
    labels: [],
    hasAttachment: true,
  },
  {
    id: "t10",
    tab: "primary",
    from: "Jonas Reichert",
    subject: "1:1 prep — biggest unblocks",
    preview:
      "Three things I want to cover: the platform hiring plan, our SLO targets for Q3, and how we handle on-call for the new region.",
    time: "Sun",
    unread: false,
    starred: false,
    labels: ["team"],
  },
  {
    id: "t11",
    tab: "primary",
    from: "Calendly",
    subject: "New booking — Caroline Reyes / 30 min",
    preview: "Caroline Reyes booked a 30 minute call for Thursday 2:00 PM PT.",
    time: "Fri",
    unread: false,
    labels: [],
  },
  {
    id: "t12",
    tab: "primary",
    from: "Owen Hart",
    count: 3,
    subject: "Re: Q3 launch plan — content calendar",
    preview:
      "I've blocked out the weeks and assigned owners. Two slots in week 3 are still open.",
    time: "Fri",
    unread: false,
    labels: ["team"],
  },
  {
    id: "u1",
    tab: "updates",
    from: "GitHub",
    subject: "[helix/platform] PR #4521 was merged",
    preview: "daniel-cho merged 'Add rate limiting for /v1/embeddings'",
    time: "10:55 AM",
    unread: true,
    labels: [],
  },
  {
    id: "u2",
    tab: "updates",
    from: "Stripe",
    subject: "Invoice for May paid — $42,180.00",
    preview: "Atlas Holdings paid invoice INV-2025-0421.",
    time: "8:30 AM",
    unread: true,
    labels: ["finance"],
  },
  {
    id: "u3",
    tab: "updates",
    from: "Linear",
    subject: "Weekly digest: 23 issues completed",
    preview: "Your team completed 23 issues across 4 projects this week.",
    time: "Yesterday",
    unread: false,
    labels: [],
  },
  {
    id: "p1",
    tab: "promotions",
    from: "Figma",
    subject: "Config 2026 — early bird ends Friday",
    preview: "Save 20% on your ticket. Three days of design, prototyping and dev craft.",
    time: "Yesterday",
    unread: false,
    labels: [],
  },
  {
    id: "p2",
    tab: "promotions",
    from: "DataDog",
    subject: "Webinar: SLO design for AI products",
    preview: "Join us next Thursday for a deep dive on SLO design.",
    time: "Mon",
    unread: false,
    labels: [],
  },
  {
    id: "s1",
    tab: "social",
    from: "LinkedIn",
    subject: "5 people viewed your profile this week",
    preview: "See who's been looking.",
    time: "Mon",
    unread: false,
    labels: [],
  },
];

/** Folders that, in the seed dataset, have no threads — drives empty states. */
export const MAIL_EMPTY_FOLDERS = [
  "drafts",
  "snoozed",
  "trash",
  "archive",
  "sent",
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
};

export function getMailLabel(id: string): MailLabel | undefined {
  return MAIL_LABELS.find((label) => label.id === id);
}
