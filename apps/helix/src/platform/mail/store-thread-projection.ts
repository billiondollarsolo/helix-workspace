import type { JsonObject } from "@helix/sdk-types";
import { classifyMailCategory, coerceMailCategory } from "./category.js";
import { sanitizeMailHtml } from "./content-safety.js";
import { mailAddress, mailAddressArray } from "./store-addresses.js";
import type {
  MailFolderId,
  MailOutboundStatus,
  MailThreadAttachment,
  MailThreadDetail,
  MailThreadMessage,
  MailThreadRowRecord,
} from "./types.js";

export interface MailThreadRow {
  readonly thread_id: string;
  readonly subject: string | null;
  readonly thread_archived_at: Date | null;
  readonly labels: readonly string[] | null;
  readonly archived_at: Date | null;
  readonly deleted_at: Date | null;
  readonly snoozed_until: Date | null;
  readonly read_at: Date | null;
  readonly starred: boolean | null;
  readonly message_id: string;
  readonly body: string;
  readonly body_format: string;
  readonly metadata: JsonObject;
  readonly sent_at: Date;
  readonly has_attachment: boolean;
  readonly attachments: readonly MailThreadAttachmentRow[] | null;
}

interface MailThreadAttachmentRow {
  readonly objectId?: unknown;
  readonly filename?: unknown;
  readonly contentId?: unknown;
  readonly mimeType?: unknown;
  readonly byteSize?: unknown;
  readonly sha256?: unknown;
  readonly disposition?: unknown;
}

export interface MailThreadListRow {
  readonly thread_id: string;
  readonly subject: string | null;
  readonly message_id: string;
  readonly body: string;
  readonly metadata: JsonObject;
  readonly sent_at: Date;
  readonly message_count: number;
  readonly has_attachment: boolean;
  readonly labels: readonly string[] | null;
  readonly read_at: Date | null;
  readonly starred: boolean | null;
  readonly category: string | null;
  readonly snoozed_until: Date | null;
  readonly outbound_status: MailOutboundStatus | null;
  readonly total: number;
}

export function mapThreadRow(row: MailThreadListRow, folder: MailFolderId): MailThreadRowRecord {
  const from = mailAddress(row.metadata.from);
  const fromAddress = from?.address ?? "";
  // A category may be missing on legacy threads — derive it on the fly so the
  // tab filter and the row payload are always populated.
  const category =
    row.category === null
      ? classifyMailCategory({
          fromAddress,
          ...(from?.name === undefined ? {} : { fromName: from.name }),
          subject: row.subject ?? "",
        })
      : coerceMailCategory(row.category);
  const spamMeta =
    typeof row.metadata === "object" && "spam" in row.metadata
      ? (row.metadata as { spam?: { catcher?: string | null } }).spam
      : undefined;
  const catcherRaw = spamMeta?.catcher;
  const spamCatcher =
    catcherRaw === "spamd" ||
    catcherRaw === "ai" ||
    catcherRaw === "rules" ||
    catcherRaw === "user" ||
    catcherRaw === "virus" ||
    catcherRaw === "scanner-policy" ||
    catcherRaw === "auth-failure"
      ? catcherRaw
      : null;
  return {
    threadId: row.thread_id,
    messageId: row.message_id,
    subject: row.subject ?? "",
    from: from?.name ?? fromAddress,
    fromEmail: fromAddress,
    preview: row.body.slice(0, 240),
    time: row.sent_at.toISOString(),
    unread: row.read_at === null || row.read_at < row.sent_at,
    starred: row.starred ?? false,
    hasAttachment: row.has_attachment,
    messageCount: row.message_count,
    labels: row.labels ?? [],
    category,
    folder,
    snoozedUntil: row.snoozed_until?.toISOString() ?? null,
    ...(folder === "spam" || spamCatcher !== null ? { spamCatcher } : {}),
  };
}

export function mapThreadDetail(rows: readonly MailThreadRow[]): MailThreadDetail {
  const first = rows[0];
  if (first === undefined) {
    throw new Error("Expected mail thread rows.");
  }

  const messages = rows.map(mapThreadMessage);
  const participants = uniqueAddresses(
    messages.flatMap((message) => [
      ...(message.from === undefined ? [] : [message.from]),
      ...message.to,
      ...message.cc,
      ...message.bcc,
    ]),
  );
  const directions = new Set(
    rows
      .map((row) =>
        typeof row.metadata.direction === "string" ? row.metadata.direction : undefined,
      )
      .filter(
        (direction): direction is "inbound" | "outbound" =>
          direction === "inbound" || direction === "outbound",
      ),
  );
  const last = messages[messages.length - 1];
  const onlyDirection = directions.values().next().value;
  const lastActivity = last?.sentAt ?? first.thread_archived_at ?? new Date(0);

  return {
    id: first.thread_id,
    subject: first.subject ?? "",
    preview: last?.body.slice(0, 240) ?? "",
    participants,
    messages,
    labels: first.labels ?? [],
    archivedAt: first.archived_at ?? first.thread_archived_at,
    deletedAt: first.deleted_at,
    snoozedUntil: first.snoozed_until,
    lastActivity,
    unread: first.read_at === null || first.read_at < lastActivity,
    starred: first.starred ?? false,
    direction: directions.size === 1 && onlyDirection !== undefined ? onlyDirection : "mixed",
  };
}

function mapThreadMessage(row: MailThreadRow): MailThreadMessage {
  const html = row.body_format === "html" ? sanitizeMailHtml(row.body).html : row.body;
  return {
    id: row.message_id,
    from: mailAddress(row.metadata.from),
    to: mailAddressArray(row.metadata.to),
    cc: mailAddressArray(row.metadata.cc),
    bcc: mailAddressArray(row.metadata.bcc),
    sentAt: row.sent_at,
    body: html,
    bodyFormat: row.body_format === "html" ? "html" : "plain",
    ...(typeof row.metadata.plainBody === "string" ? { plainBody: row.metadata.plainBody } : {}),
    hasAttachment: row.has_attachment,
    attachments: mailThreadAttachments(row.attachments),
  };
}

function mailThreadAttachments(
  attachments: readonly MailThreadAttachmentRow[] | null,
): MailThreadMessage["attachments"] {
  if (attachments === null) {
    return [];
  }
  const parsed: MailThreadAttachment[] = [];
  for (const attachment of attachments) {
    if (
      typeof attachment.objectId !== "string" ||
      typeof attachment.mimeType !== "string" ||
      typeof attachment.byteSize !== "number"
    ) {
      continue;
    }
    parsed.push({
      objectId: attachment.objectId,
      ...(typeof attachment.filename === "string" ? { filename: attachment.filename } : {}),
      ...(typeof attachment.contentId === "string" ? { contentId: attachment.contentId } : {}),
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      ...(typeof attachment.sha256 === "string" ? { sha256: attachment.sha256 } : {}),
      disposition:
        typeof attachment.disposition === "string" ? attachment.disposition : "attachment",
    });
  }
  return parsed;
}

function uniqueAddresses(addresses: readonly NonNullable<MailThreadMessage["from"]>[]) {
  const byAddress = new Map<string, NonNullable<MailThreadMessage["from"]>>();
  for (const address of addresses) {
    byAddress.set(address.address.toLowerCase(), address);
  }
  return [...byAddress.values()];
}
