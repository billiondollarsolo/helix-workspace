import { timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import {
  hashReceivingDomainVerificationToken,
  type MailReceivingDomainRecord,
} from "./receiving-domains-store.js";

const TXT_PREFIX = "helix-domain-verification=";

export interface ReceivingDomainOwnershipVerifier {
  verify(record: MailReceivingDomainRecord): Promise<boolean>;
}

export type TxtLookup = (name: string) => Promise<readonly (readonly string[])[]>;

/**
 * Verify the one-time challenge via `_helix-verification.<domain>` TXT.
 *
 * Only a SHA-256 digest is persisted. TXT candidates are hashed locally and
 * compared in constant time, so neither the database nor logs need the token.
 */
export class DnsTxtReceivingDomainOwnershipVerifier implements ReceivingDomainOwnershipVerifier {
  constructor(private readonly lookupTxt: TxtLookup = dns.resolveTxt) {}

  async verify(record: MailReceivingDomainRecord): Promise<boolean> {
    let answers: readonly (readonly string[])[];
    try {
      answers = await this.lookupTxt(`_helix-verification.${record.domain}`);
    } catch (error) {
      if (isAbsentDnsAnswer(error)) {
        return false;
      }
      throw error;
    }

    const expected = Buffer.from(record.verificationTokenHash, "hex");
    return answers.some((chunks) => {
      const value = chunks.join("");
      if (!value.startsWith(TXT_PREFIX)) {
        return false;
      }
      const token = value.slice(TXT_PREFIX.length);
      if (token.length === 0 || token.length > 256) {
        return false;
      }
      const actual = Buffer.from(hashReceivingDomainVerificationToken(token), "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
  }
}

function isAbsentDnsAnswer(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return code === "ENODATA" || code === "ENOTFOUND";
}
