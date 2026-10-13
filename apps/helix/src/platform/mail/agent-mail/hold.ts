import type { JsonObject } from "@helix/sdk-types";
import type { MailQuarantineStore } from "../quarantine.js";
import type { MailInboundRecipient } from "../types.js";
import {
  AGENT_MAIL_HOLD_SIGNATURE_PREFIX,
  agentMailHoldReasons,
  type AgentMailPolicy,
} from "./policy.js";

/** Looks up the policy of each recipient that is an agent or service account. */
export interface AgentMailGate {
  policiesFor(
    orgId: string,
    actorIds: readonly string[],
  ): Promise<ReadonlyMap<string, AgentMailPolicy>>;
}

export interface HoldAgentMailInput {
  readonly gate: AgentMailGate | undefined;
  readonly quarantineStore: MailQuarantineStore | undefined;
  readonly orgId: string;
  readonly recipients: readonly MailInboundRecipient[];
  readonly raw: Buffer;
  readonly fromAddress: string;
  readonly subject: string;
  readonly text: string;
  readonly dmarc: string;
  readonly authentication: JsonObject;
  readonly envelopeFrom?: string | undefined;
  readonly remoteAddress?: string | undefined;
  readonly helo?: string | undefined;
  readonly providerDeliveryId?: string | undefined;
}

/**
 * Keep a message from outside away from every agent recipient whose policy
 * does not admit it. Those copies go to the quarantine, where an administrator
 * delivers or deletes them; the other recipients still receive the message.
 *
 * Returns the recipients to deliver to and, when anything was held, the
 * quarantine record. With nowhere to hold mail, delivery is deferred rather
 * than letting the message through.
 */
export async function holdAgentMail(input: HoldAgentMailInput): Promise<{
  readonly deliver: readonly MailInboundRecipient[];
  readonly quarantineId: string | null;
}> {
  if (input.gate === undefined) return { deliver: input.recipients, quarantineId: null };
  const policies = await input.gate.policiesFor(
    input.orgId,
    input.recipients.map((recipient) => recipient.actorId),
  );
  const deliver: MailInboundRecipient[] = [];
  // Recipients held for the same reasons share one quarantine record.
  const held = new Map<string, MailInboundRecipient[]>();
  for (const recipient of input.recipients) {
    const policy = policies.get(recipient.actorId);
    const reasons = policy === undefined ? [] : agentMailHoldReasons({ ...input, policy });
    if (reasons.length === 0) {
      deliver.push(recipient);
      continue;
    }
    const key = reasons.join(",");
    held.set(key, [...(held.get(key) ?? []), recipient]);
  }
  if (held.size === 0) return { deliver, quarantineId: null };
  if (input.quarantineStore === undefined) {
    throw Object.assign(new Error("Agent mail hold is unavailable; delivery deferred."), {
      responseCode: 451,
    });
  }
  let quarantineId: string | null = null;
  for (const [reasons, recipients] of held) {
    const quarantine = await input.quarantineStore.quarantine({
      orgId: input.orgId,
      recipientAddresses: recipients.map((recipient) => recipient.address),
      raw: input.raw,
      signature: `${AGENT_MAIL_HOLD_SIGNATURE_PREFIX}${reasons}`,
      authentication: input.authentication,
      scanEvidence: { agentMail: { from: input.fromAddress, reasons: reasons.split(",") } },
      ...(input.envelopeFrom === undefined ? {} : { envelopeFrom: input.envelopeFrom }),
      ...(input.remoteAddress === undefined ? {} : { remoteAddress: input.remoteAddress }),
      ...(input.helo === undefined ? {} : { helo: input.helo }),
      ...(input.providerDeliveryId === undefined
        ? {}
        : { providerDeliveryId: input.providerDeliveryId }),
    });
    quarantineId = quarantine.id;
  }
  return { deliver, quarantineId };
}
