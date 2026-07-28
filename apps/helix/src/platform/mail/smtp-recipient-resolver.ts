import type { MailStore } from "./store.js";
import type {
  ReceivingDomainStore,
  ReceivingMailboxResolution,
} from "./receiving-domains-store.js";
import { normalizeMailboxAddress } from "./address-normalization.js";

export type SmtpResolvedRecipient = ReceivingMailboxResolution;

export interface SmtpRecipientResolver {
  resolveRecipient(address: string): Promise<SmtpResolvedRecipient | null>;
}

/** Resolve public SMTP recipients through the globally unique M1 domain model. */
export class ReceivingDomainSmtpRecipientResolver implements SmtpRecipientResolver {
  constructor(private readonly store: ReceivingDomainStore) {}

  async resolveRecipient(address: string): Promise<SmtpResolvedRecipient | null> {
    return this.store.resolveMailbox(address);
  }
}

/**
 * Explicit legacy fallback for Personal, single-tenant deployments only.
 *
 * It accepts known actor/alias mailboxes in one configured organization. It is
 * never a catch-all and is intentionally impossible to construct for SaaS.
 */
export class PersonalSmtpRecipientResolver implements SmtpRecipientResolver {
  readonly #orgId: string;
  readonly #store: Pick<MailStore, "findActorByAddress">;

  constructor(input: {
    readonly deploymentMode: "single-tenant" | "multi-tenant-saas";
    readonly securityTier: string;
    readonly orgId: string;
    readonly store: Pick<MailStore, "findActorByAddress">;
  }) {
    if (input.deploymentMode !== "single-tenant" || input.securityTier !== "personal") {
      throw new Error(
        "Personal SMTP fallback is forbidden outside Personal single-tenant deployments.",
      );
    }
    if (input.orgId.length === 0) {
      throw new Error("Personal SMTP fallback requires an explicit organization id.");
    }
    this.#orgId = input.orgId;
    this.#store = input.store;
  }

  async resolveRecipient(address: string): Promise<SmtpResolvedRecipient | null> {
    const normalized = normalizeMailboxAddress(address);
    const actor = await this.#store.findActorByAddress(this.#orgId, normalized.address);
    if (actor === null) {
      return null;
    }
    return {
      orgId: this.#orgId,
      receivingDomainId: "personal-fallback",
      domain: normalized.domain,
      normalizedAddress: normalized.address,
      actorId: actor.actorId,
      match: "primary",
    };
  }
}

export function createSmtpRecipientResolver(input: {
  readonly receivingDomains?: ReceivingDomainStore | undefined;
  readonly personalFallback?:
    | {
        readonly deploymentMode: "single-tenant" | "multi-tenant-saas";
        readonly securityTier: string;
        readonly orgId: string;
        readonly store: Pick<MailStore, "findActorByAddress">;
      }
    | undefined;
}): SmtpRecipientResolver {
  if (input.receivingDomains !== undefined) {
    return new ReceivingDomainSmtpRecipientResolver(input.receivingDomains);
  }
  if (input.personalFallback !== undefined) {
    return new PersonalSmtpRecipientResolver(input.personalFallback);
  }
  throw new Error(
    "SMTP recipient routing requires the receiving-domain database or an explicit Personal fallback.",
  );
}
