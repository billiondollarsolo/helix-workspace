import { deliverLocalMessage, resolveLocalMailboxes } from "../../platform/mail/local-delivery.js";
import {
  insertMailMessage,
  stageInlineAttachments,
} from "../../platform/mail/store-message-write.js";
import { prepareOutboundEnvelope } from "../../platform/mail/threading.js";
import type { MailOutboundEnvelope } from "../../platform/mail/types.js";
import { withTenantPostgresContext } from "../../platform/tenancy/postgres-roles.js";
import type { DemoRuntime } from "./runtime.js";

/**
 * Records internal mail that was sent and delivered before today.
 *
 * A message's send time is immutable once stored, and the send queue stamps
 * "now", so history cannot go through the queue. This runs the queue's own
 * steps with the original time instead: attachment staging and scanning, the
 * sender's copy through `insertMailMessage`, then the transport's local
 * delivery and recipient filters. Recent mail uses the real queue.
 */
export async function recordDeliveredMail(
  runtime: DemoRuntime,
  input: {
    readonly actorId: string;
    readonly threadId?: string | undefined;
    readonly envelope: MailOutboundEnvelope;
    readonly sentAt: Date;
  },
): Promise<{ readonly messageId: string; readonly threadId: string }> {
  const sql = runtime.sql;
  const orgId = runtime.orgId;
  const envelope = prepareOutboundEnvelope(input.envelope);
  const staged = await stageInlineAttachments(
    {
      orgId,
      actorId: input.actorId,
      from: envelope.from,
      to: envelope.to,
      cc: envelope.cc,
      bcc: envelope.bcc,
      subject: envelope.subject,
      bodyText: envelope.text,
      attachments: envelope.attachments,
    },
    runtime.mailIngestor,
  );
  try {
    const sent = await withTenantPostgresContext(
      sql,
      { orgId, actorId: input.actorId },
      async (tx) => {
        const message = await insertMailMessage(tx, {
          orgId,
          actorId: input.actorId,
          threadId: input.threadId,
          messageId: envelope.messageId,
          from: envelope.from,
          to: envelope.to,
          cc: envelope.cc,
          bcc: envelope.bcc,
          subject: envelope.subject,
          bodyText: envelope.text,
          ...(envelope.inReplyTo === undefined ? {} : { inReplyTo: envelope.inReplyTo }),
          ...(envelope.references === undefined ? {} : { references: envelope.references }),
          attachments: staged.input.attachments,
          receivedAt: input.sentAt,
          metadata: { direction: "outbound" },
        });
        const mailboxes = await resolveLocalMailboxes(sql, {
          orgId,
          envelope,
          senderAuthenticated: true,
        });
        return { message, mailboxes };
      },
    );
    await withTenantPostgresContext(sql, { orgId }, (tx) =>
      deliverLocalMessage(tx, sql, {
        orgId,
        threadId: sent.message.threadId,
        messageId: sent.message.messageId,
        envelope,
        mailboxes: sent.mailboxes,
      }),
    );
    return { messageId: sent.message.messageId, threadId: sent.message.threadId };
  } catch (error) {
    await runtime.mailIngestor.release(staged.stages).catch(() => undefined);
    throw error;
  }
}
