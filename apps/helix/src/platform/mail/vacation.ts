import { shouldSkipVacationResponse } from "./core/thread-projection.js";
import { storedHeaderMap } from "./inbound-message.js";
import { replyThreadingHeaders } from "./reply-context.js";
import type { MailStore } from "./store.js";
import { normalizeMessageId, prepareOutboundEnvelope } from "./threading.js";
import type { MailMessageInput } from "./types.js";

/**
 * Queue one RFC 3834 vacation reply for a delivered message, at most once per
 * sender per vacation. The reply carries `Auto-Submitted: auto-replied` so
 * other responders (including Helix's own) do not answer it.
 */
export async function maybeQueueVacationResponse(
  store: MailStore,
  input: {
    readonly message: MailMessageInput;
    readonly actorId: string;
    readonly recipientAddress: string;
    readonly stored: { readonly threadId: string; readonly messageId: string };
    readonly now?: Date;
  },
): Promise<boolean> {
  const vacation = await store.getActiveVacation(input.message.orgId, input.actorId, input.now);
  if (vacation === null) {
    return false;
  }

  const senderEmail = input.message.from.address.toLowerCase();
  const metadata = input.message.metadata ?? {};
  const aliases = (await store.listAliases?.(input.message.orgId, input.actorId)) ?? [];
  if (
    shouldSkipVacationResponse({
      senderEmail,
      headers: storedHeaderMap(metadata),
      isAutoReply: metadata.autoReply === true || metadata.isAutoReply === true,
      ownAddresses: [input.recipientAddress, ...aliases.map((alias) => alias.email)].filter(
        (address) => address.length > 0,
      ),
      visibleRecipients: [...input.message.to, ...(input.message.cc ?? [])].map(
        (recipient) => recipient.address,
      ),
    })
  ) {
    return false;
  }

  const responseRecorded = await store.recordVacationResponse({
    vacationId: vacation.id,
    orgId: input.message.orgId,
    actorId: input.actorId,
    senderEmail,
    messageId: input.stored.messageId,
    threadId: input.stored.threadId,
  });
  if (!responseRecorded) {
    return false;
  }

  const parentId = normalizeMessageId(input.message.messageId) ?? undefined;
  const threading = replyThreadingHeaders({
    messageIdHeader: parentId,
    references: input.message.references,
  });
  await store.createOutbound({
    orgId: input.message.orgId,
    actorId: input.actorId,
    threadId: input.stored.threadId,
    envelope: prepareOutboundEnvelope({
      from: { address: input.recipientAddress },
      to: [input.message.from],
      cc: [],
      bcc: [],
      subject: vacation.subject,
      text: vacation.body,
      attachments: [],
      headers: { "Auto-Submitted": "auto-replied" },
      ...(threading.inReplyTo === undefined ? {} : { inReplyTo: threading.inReplyTo }),
      ...(threading.references.length === 0 ? {} : { references: threading.references }),
    }),
    undoUntil: input.now ?? new Date(),
    outboxSubject: "mail.send",
  });
  return true;
}
