/* ---------------------------------------------------------- backend fixtures */

export const FOLDERS = [
  { id: "inbox", label: "Inbox", total: 12, unread: 3 },
  { id: "starred", label: "Starred", total: 2, unread: 0 },
  { id: "snoozed", label: "Snoozed", total: 0, unread: 0 },
  { id: "sent", label: "Sent", total: 0, unread: 0 },
  { id: "drafts", label: "Drafts", total: 0, unread: 0 },
  { id: "archive", label: "Archive", total: 0, unread: 0 },
  { id: "spam", label: "Spam", total: 1, unread: 1 },
  { id: "trash", label: "Trash", total: 0, unread: 0 },
];

export const LABELS = [
  {
    id: "l1",
    slug: "team",
    name: "Team",
    color: "#7c3aed",
    sortOrder: 0,
    threadCount: 4,
    shared: true,
  },
];

export function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "thread-1",
    messageId: "message-1",
    subject: "Q3 roadmap sign-off",
    from: "Mira Okafor",
    fromEmail: "mira@helix.io",
    preview: "Final roadmap attached",
    time: "2026-05-21T10:42:00.000Z",
    unread: true,
    starred: false,
    hasAttachment: true,
    messageCount: 1,
    labels: ["team"],
    category: "primary",
    folder: "inbox",
    snoozedUntil: null,
    ...overrides,
  };
}

export const UPDATES_ROW = threadRow({
  threadId: "thread-2",
  messageId: "message-2",
  subject: "PR #4521 was merged",
  from: "GitHub",
  fromEmail: "noreply@github.com",
  category: "updates",
  labels: [],
});

export const THREAD_DETAIL = {
  id: "thread-1",
  subject: "Q3 roadmap sign-off",
  preview: "Final roadmap attached",
  participants: [{ address: "mira@helix.io", name: "Mira Okafor" }],
  messages: [
    {
      id: "message-1",
      from: { address: "mira@helix.io", name: "Mira Okafor" },
      to: [{ address: "alex@helix.io", name: "Alex" }],
      cc: [],
      bcc: [],
      sentAt: "2026-05-21T10:42:00.000Z",
      body: "Here is the consolidated roadmap for review.",
      bodyFormat: "plain",
      hasAttachment: true,
    },
  ],
  labels: ["team"],
  archivedAt: null,
  deletedAt: null,
  snoozedUntil: null,
  lastActivity: "2026-05-21T10:42:00.000Z",
  unread: true,
  starred: false,
  direction: "inbound",
};
