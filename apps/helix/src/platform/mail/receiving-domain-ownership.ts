/* Ownership of a receiving domain, delegated to the domain itself.
 *
 * The TXT challenge used to live on `mail_receiving_domains`, which meant
 * proving you controlled example.com to receive mail proved nothing for
 * sending it. Migration 0087 moved the proof onto `admin_domains`; this adapter
 * keeps the receiving routes' interface while reading it from there.
 */

import {
  DnsTxtDomainOwnershipVerifier,
  type DomainOwnershipStore,
  type DomainOwnershipVerifier,
  type TxtLookup,
} from "../admin/domain-identity.js";
import type { MailReceivingDomainRecord } from "./receiving-domains-store.js";

export interface ReceivingDomainOwnershipVerifier {
  verify(record: MailReceivingDomainRecord): Promise<boolean>;
}

/** Resolves the ownership digest recorded against a domain identity. Accepts
 *  the full `DomainOwnershipStore` too, which is what the server passes. */
export type DomainOwnershipTokenSource = Pick<DomainOwnershipStore, "getOwnershipTokenHash">;

export class DnsTxtReceivingDomainOwnershipVerifier implements ReceivingDomainOwnershipVerifier {
  readonly #verifier: DomainOwnershipVerifier;

  constructor(
    private readonly tokens: DomainOwnershipTokenSource,
    verifier?: DomainOwnershipVerifier | TxtLookup,
  ) {
    if (typeof verifier === "function") {
      this.#verifier = new DnsTxtDomainOwnershipVerifier(verifier);
    } else {
      this.#verifier = verifier ?? new DnsTxtDomainOwnershipVerifier();
    }
  }

  async verify(record: MailReceivingDomainRecord): Promise<boolean> {
    const tokenHash = await this.tokens.getOwnershipTokenHash(record.orgId, record.adminDomainId);
    /* No challenge issued is not the same as a challenge that failed, but at
       this boundary both mean "ownership is not currently proven" — the route
       is what distinguishes them for the operator. */
    if (tokenHash === null) {
      return false;
    }
    return this.#verifier.verify({ domain: record.domain, tokenHash });
  }
}
