import type postgres from "postgres";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { evaluateInboundMail } from "./filters.js";
import { PostgresMailStore } from "./store.js";
import { MailDeliveryError } from "./errors.js";
import type { OutboundMailTransport } from "./outbound.js";
import type { ClaimedOutboundMail } from "./store-contracts.js";
import { deliverInboundMessage } from "./store-message-write.js";
import { MailRoutingStore } from "./store-routing.js";
import type { MailOutboundEnvelope } from "./types.js";

/** Dispatch local mail after the undo window, through the existing mailbox ledger. */
export class LocalMailTransport implements OutboundMailTransport {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly outbound: ClaimedOutboundMail,
    private readonly remote: () => Promise<OutboundMailTransport>,
  ) {}

  async send(envelope: MailOutboundEnvelope, handoff: { readonly idempotencyKey: string }) {
    const { local, actors } = await withTenantPostgresContext(
      this.sql,
      {
        orgId: this.outbound.orgId,
        ...(this.outbound.deliveryMetadata.senderAuthenticated === true
          ? { actorId: this.outbound.actorId }
          : {}),
      },
      async (tx) => {
        await this.assertLease(tx);
        const routing = new MailRoutingStore(this.sql);
        const addresses = new Set<string>();
        const actors = new Map<string, string>();
        for (const recipient of [...envelope.to, ...envelope.cc, ...envelope.bcc]) {
          const resolution = await routing.resolveInboundAddress(
            recipient.address,
            this.outbound.deliveryMetadata.senderAuthenticated === true,
          );
          const sameTenant = resolution.recipients.filter(
            (entry) => entry.orgId === this.outbound.orgId,
          );
          if (sameTenant.length === 0) continue;
          // Routing rules must keep using the SMTP ingress rule engine.
          if (resolution.rules.length !== 0) continue;
          addresses.add(recipient.address.toLowerCase());
          for (const entry of sameTenant) actors.set(entry.actorId, entry.address);
        }
        return { local: addresses, actors };
      },
    );
    if (actors.size > 0) {
      await withTenantPostgresContext(this.sql, { orgId: this.outbound.orgId }, async (tx) => {
        await this.assertLease(tx);
        const message = {
          orgId: this.outbound.orgId,
          mailboxActorIds: [...actors.keys()],
          from: envelope.from,
          to: envelope.to,
          cc: envelope.cc,
          subject: envelope.subject,
          bodyText: envelope.text,
          bodyHtml: envelope.html,
          attachments: envelope.attachments,
          messageId: envelope.messageId,
          references: envelope.references,
          metadata: { direction: "inbound" },
        };
        const delivered = await deliverInboundMessage(tx, {
          threadId: this.outbound.threadId,
          messageId: this.outbound.messageId,
          input: message,
        });
        for (const actorId of delivered) {
          await evaluateInboundMail(new PostgresMailStore(this.sql), {
            message,
            stored: { threadId: this.outbound.threadId, messageId: this.outbound.messageId },
            recipientActorId: actorId,
            recipientAddress: actors.get(actorId) ?? "",
          });
        }
      });
    }
    const external = {
      ...envelope,
      to: envelope.to.filter((entry) => !local.has(entry.address.toLowerCase())),
      cc: envelope.cc.filter((entry) => !local.has(entry.address.toLowerCase())),
      bcc: envelope.bcc.filter((entry) => !local.has(entry.address.toLowerCase())),
    };
    if (external.to.length + external.cc.length + external.bcc.length > 0) {
      return (await this.remote()).send(external, handoff);
    }
    return {
      providerMessageId: envelope.messageId,
      deliveryMetadata: { transport: "local", mailboxCount: actors.size },
    };
  }
  private async assertLease(tx: postgres.TransactionSql): Promise<void> {
    const rows = await tx<{ readonly id: string }[]>`
      select id from mail_outbound_messages
      where org_id = ${this.outbound.orgId} and id = ${this.outbound.id}
        and actor_id = ${this.outbound.actorId}
        and message_id = ${this.outbound.messageId} and thread_id = ${this.outbound.threadId}
        and lease_token = ${this.outbound.leaseToken} and status = 'sending'
        and lease_expires_at > now()
        and coalesce((delivery_metadata->>'senderAuthenticated')::boolean, false)
          = ${this.outbound.deliveryMetadata.senderAuthenticated === true}
      for update
    `;
    if (rows.length !== 1)
      throw new MailDeliveryError(
        "Local delivery lease or sender provenance is no longer valid.",
        false,
      );
  }
}
