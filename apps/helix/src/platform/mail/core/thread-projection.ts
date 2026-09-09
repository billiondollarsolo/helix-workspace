import type { MailFolderId, MailThreadRowRecord } from "../types.js";

/**
 * Pure folder-membership predicates for the mail thread list projection.
 * No SQL / IO — unit-tested without a DB (G5).
 */
export interface ThreadProjectionSource {
  readonly deletedAt: Date | null;
  readonly spamAt: Date | null;
  readonly archivedAt: Date | null;
  readonly threadArchivedAt: Date | null;
  readonly starred: boolean;
  readonly snoozedUntil: Date | null;
  readonly hasOutbound: boolean;
  readonly outboundStatus: string | null;
  readonly isDraft?: boolean;
}

export function folderPredicate(
  folder: MailFolderId,
  row: ThreadProjectionSource,
  now: Date,
): boolean {
  switch (folder) {
    case "trash":
      return row.deletedAt !== null;
    case "spam":
      return row.deletedAt === null && row.spamAt !== null;
    case "archive":
      return (
        row.deletedAt === null &&
        row.spamAt === null &&
        (row.archivedAt !== null || row.threadArchivedAt !== null)
      );
    case "starred":
      return row.deletedAt === null && row.starred;
    case "snoozed":
      return (
        row.deletedAt === null &&
        row.snoozedUntil !== null &&
        row.snoozedUntil.getTime() > now.getTime()
      );
    case "sent":
      return row.deletedAt === null && row.hasOutbound;
    case "drafts":
      return row.deletedAt === null && (row.isDraft === true || row.outboundStatus === "queued");
    case "inbox":
    default:
      return (
        row.deletedAt === null &&
        row.spamAt === null &&
        row.archivedAt === null &&
        row.threadArchivedAt === null &&
        (row.snoozedUntil === null || row.snoozedUntil.getTime() <= now.getTime()) &&
        !row.hasOutbound
      );
  }
}

/** First matching folder wins — order encodes precedence (trash beats spam, …). */
const FOLDER_RESOLUTION_ORDER: readonly MailFolderId[] = [
  "trash",
  "spam",
  "drafts",
  "snoozed",
  "starred",
  "archive",
  "sent",
  "inbox",
];

export function resolveFolderForRow(row: ThreadProjectionSource, now: Date): MailFolderId {
  return FOLDER_RESOLUTION_ORDER.find((folder) => folderPredicate(folder, row, now)) ?? "inbox";
}

export interface ProjectThreadRowInput {
  readonly threadId: string;
  readonly messageId: string;
  readonly subject: string;
  readonly fromName: string;
  readonly fromEmail: string;
  readonly body: string;
  readonly sentAt: Date;
  readonly unread: boolean;
  readonly starred: boolean;
  readonly hasAttachment: boolean;
  readonly messageCount: number;
  readonly labels: readonly string[];
  readonly category: string;
  readonly snoozedUntil: Date | null;
  readonly projection: ThreadProjectionSource;
  readonly now: Date;
  readonly previewLength?: number;
}

export function projectThreadRow(input: ProjectThreadRowInput): MailThreadRowRecord {
  const previewLength = input.previewLength ?? 160;
  const preview = input.body.replace(/\s+/g, " ").trim().slice(0, previewLength);
  return {
    threadId: input.threadId,
    messageId: input.messageId,
    subject: input.subject,
    from: input.fromName.length > 0 ? input.fromName : input.fromEmail,
    fromEmail: input.fromEmail,
    preview,
    time: input.sentAt.toISOString(),
    unread: input.unread,
    starred: input.starred,
    hasAttachment: input.hasAttachment,
    messageCount: input.messageCount,
    labels: [...input.labels],
    category: input.category as MailThreadRowRecord["category"],
    folder: resolveFolderForRow(input.projection, input.now),
    snoozedUntil: input.snoozedUntil?.toISOString() ?? null,
  };
}

export function matchesFilterCriteria(
  message: {
    readonly from: { readonly address: string };
    readonly to: readonly { readonly address: string }[];
    readonly subject: string;
    readonly bodyText: string;
    readonly attachments?: readonly unknown[] | undefined;
  },
  criteria: {
    readonly fromContains?: string;
    readonly toContains?: string;
    readonly subjectContains?: string;
    readonly bodyContains?: string;
    readonly hasAttachment?: boolean;
  },
): boolean {
  const toContains = criteria.toContains;
  if (!containsFold(message.from.address, criteria.fromContains)) {
    return false;
  }
  if (toContains !== undefined && !message.to.some((a) => containsFold(a.address, toContains))) {
    return false;
  }
  if (!containsFold(message.subject, criteria.subjectContains)) {
    return false;
  }
  if (!containsFold(message.bodyText, criteria.bodyContains)) {
    return false;
  }
  if (
    criteria.hasAttachment !== undefined &&
    (message.attachments?.length ?? 0) > 0 !== criteria.hasAttachment
  ) {
    return false;
  }
  return true;
}

/** Case-insensitive substring test. An undefined `needle` means "no constraint". */
function containsFold(haystack: string, needle: string | undefined): boolean {
  return needle === undefined || haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Loop-prevention guards for vacation auto-responders. */
export function shouldSkipVacationResponse(input: {
  readonly senderEmail: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly isAutoReply?: boolean;
}): boolean {
  const sender = input.senderEmail.toLowerCase();
  if (
    sender.startsWith("mailer-daemon@") ||
    sender.startsWith("no-reply@") ||
    sender.startsWith("noreply@") ||
    sender.includes("mailer-daemon")
  ) {
    return true;
  }
  if (input.isAutoReply === true) {
    return true;
  }
  const headers = input.headers ?? {};
  const precedence = (headers.precedence ?? headers.Precedence ?? "").toLowerCase();
  if (precedence === "bulk" || precedence === "junk" || precedence === "list") {
    return true;
  }
  const autoSubmitted = (
    headers["auto-submitted"] ??
    headers["Auto-Submitted"] ??
    ""
  ).toLowerCase();
  if (autoSubmitted.length > 0 && autoSubmitted !== "no") {
    return true;
  }
  return false;
}
