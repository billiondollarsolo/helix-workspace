import type postgres from "postgres";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { evaluateInboundMail } from "./filters.js";
import { PostgresMailStore } from "./store.js";
import { MailDeliveryError } from "./errors.js";
import type { OutboundMailTransport } from "./outbound.js";
import type { ClaimedOutboundMail } from "./store-contracts.js";
import { deliverInboundMessage } from "./store-message-write.js";
import { MailRoutingStore } from "./store-routing.js";
import { allowlistedOutboundHeaders, formatMailboxAddress } from "./outbound-format.js";
import type { MailOutboundEnvelope } from "./types.js";

export function localHeaderMap(envelope: MailOutboundEnvelope): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(allowlistedOutboundHeaders(envelope.headers))) {
    headers[name.toLowerCase()] = value;
  }
  if (envelope.replyTo !== undefined) headers["reply-to"] = formatMailboxAddress(envelope.replyTo);
  return headers;
}

/**
 * Envelope for the remote leg of a mixed local/remote send, or null when every
 * recipient was delivered locally. Visible To/Cc stay intact; only the SMTP
 * envelope (`envelopeRecipients`) skips the mailboxes already delivered.
 */
export function remoteDeliveryEnvelope(
  envelope: MailOutboundEnvelope,
  localAddresses: ReadonlySet<string>,
): MailOutboundEnvelope | null {
  const remote = [
    ...new Set(
      [...envelope.to, ...envelope.cc, ...envelope.bcc]
        .map((entry) => entry.address.toLowerCase())
        .filter((address) => !localAddresses.has(address)),
    ),
  ];
  if (remote.length === 0) return null;
  return localAddresses.size === 0 ? envelope : { ...envelope, envelopeRecipients: remote };
}

export interface LocalMailboxes {
  /** Envelope addresses that resolved to mailboxes in the sender's tenant. */
  readonly local: ReadonlySet<string>;
  /** Mailbox actor id to the address it was reached at. */
  readonly actors: ReadonlyMap<string, string>;
}

export async function areLocalMailRecipients(
  sql: postgres.Sql,
  orgId: string,
  addresses: readonly string[],
): Promise<boolean> {
  if (addresses.length === 0) return false;
  return withTenantPostgresContext(sql, { orgId }, async () => {
    const routing = new MailRoutingStore(sql);
    for (const address of new Set(addresses.map((entry) => entry.toLowerCase()))) {
      const resolved = await routing.resolveInboundAddress(address, true);
      if (
        resolved.rules.length ||
        resolved.recipients.length === 0 ||
        resolved.recipients.some((recipient) => recipient.orgId !== orgId)
      )
        return false;
    }
    return true;
  });
}

/**
 * The envelope recipients that are mailboxes in the sender's tenant. Runs in
 * the caller's tenant context; addresses with routing rules stay with SMTP.
 */
export async function resolveLocalMailboxes(
  sql: postgres.Sql,
  input: {
    readonly orgId: string;
    readonly envelope: MailOutboundEnvelope;
    readonly senderAuthenticated: boolean;
  },
): Promise<LocalMailboxes> {
  const routing = new MailRoutingStore(sql);
  const local = new Set<string>();
  const actors = new Map<string, string>();
  const { envelope } = input;
  for (const recipient of [...envelope.to, ...envelope.cc, ...envelope.bcc]) {
    const resolution = await routing.resolveInboundAddress(
      recipient.address,
      input.senderAuthenticated,
    );
    const sameTenant = resolution.recipients.filter((entry) => entry.orgId === input.orgId);
    if (sameTenant.length === 0) continue;
    // Routing rules must keep using the SMTP ingress rule engine.
    if (resolution.rules.length !== 0) continue;
    local.add(recipient.address.toLowerCase());
    for (const entry of sameTenant) actors.set(entry.actorId, entry.address);
  }
  return { local, actors };
}

/**
 * Delivers an already stored message to local mailboxes and runs each
 * recipient's inbound filters. Runs in the caller's tenant transaction.
 */
export async function deliverLocalMessage(
  tx: postgres.TransactionSql,
  sql: postgres.Sql,
  input: {
    readonly orgId: string;
    readonly threadId: string;
    readonly messageId: string;
    readonly envelope: MailOutboundEnvelope;
    readonly mailboxes: LocalMailboxes;
  },
): Promise<void> {
  const { envelope, mailboxes } = input;
  if (mailboxes.actors.size === 0) return;
  const message = {
    orgId: input.orgId,
    mailboxActorIds: [...mailboxes.actors.keys()],
    from: envelope.from,
    to: envelope.to,
    cc: envelope.cc,
    subject: envelope.subject,
    bodyText: envelope.text,
    bodyHtml: envelope.html,
    attachments: envelope.attachments,
    messageId: envelope.messageId,
    references: envelope.references,
    // Same header map as SMTP ingest so loop guards and categories apply.
    metadata: {
      direction: "inbound",
      headers: localHeaderMap(envelope),
      ...(envelope.replyTo === undefined ? {} : { replyTo: [envelope.replyTo] }),
    },
  };
  const delivered = await deliverInboundMessage(tx, {
    threadId: input.threadId,
    messageId: input.messageId,
    input: message,
  });
  for (const actorId of delivered) {
    await evaluateInboundMail(new PostgresMailStore(sql), {
      message,
      stored: { threadId: input.threadId, messageId: input.messageId },
      recipientActorId: actorId,
      recipientAddress: mailboxes.actors.get(actorId) ?? "",
    });
  }
}

/** Dispatch local mail after the undo window, through the existing mailbox ledger. */
export class LocalMailTransport implements OutboundMailTransport {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly outbound: ClaimedOutboundMail,
    private readonly remote: () => Promise<OutboundMailTransport>,
  ) {}

  async send(envelope: MailOutboundEnvelope, handoff: { readonly idempotencyKey: string }) {
    const senderAuthenticated = this.outbound.deliveryMetadata.senderAuthenticated === true;
    const mailboxes = await withTenantPostgresContext(
      this.sql,
      {
        orgId: this.outbound.orgId,
        ...(senderAuthenticated ? { actorId: this.outbound.actorId } : {}),
      },
      async (tx) => {
        await this.assertLease(tx);
        return resolveLocalMailboxes(this.sql, {
          orgId: this.outbound.orgId,
          envelope,
          senderAuthenticated,
        });
      },
    );
    const { local, actors } = mailboxes;
    if (envelope.localOnly && remoteDeliveryEnvelope(envelope, local) !== null) {
      throw new MailDeliveryError(
        "An internal recipient no longer resolves to a local mailbox; review the recipients and send again.",
        false,
      );
    }
    if (actors.size > 0) {
      await withTenantPostgresContext(this.sql, { orgId: this.outbound.orgId }, async (tx) => {
        await this.assertLease(tx);
        await deliverLocalMessage(tx, this.sql, {
          orgId: this.outbound.orgId,
          threadId: this.outbound.threadId,
          messageId: this.outbound.messageId,
          envelope,
          mailboxes,
        });
      });
    }
    const remote = remoteDeliveryEnvelope(envelope, local);
    if (remote !== null) {
      return (await this.remote()).send(remote, handoff);
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
