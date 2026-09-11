/* The domain identity a mail capability hangs off.
 *
 * `admin_domains` records that an org owns a domain; `mail_sending_domains`
 * and `mail_receiving_domains` record what that domain is used for. Migration
 * 0086 made the link mandatory, so every path that creates a capability has to
 * resolve its parent first — and create one if the operator reached the mail
 * console without registering the domain there.
 *
 * Registering the parent here is deliberately NOT a claim of ownership: the row
 * lands `pending`. Only a satisfied DNS challenge moves it, so adding a sending
 * domain cannot manufacture the proof that gates everything else.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import type postgres from "postgres";

/**
 * The single stored form of a domain: lower-case ASCII, punycode for IDNs.
 *
 * Punycode is not cosmetic. DNS queries carry A-labels, so a challenge issued
 * for `bücher.example` has to be published at `_helix-verification.
 * xn--bcher-kva.example` or it can never resolve. Migration 0087's canonical
 * constraint enforces the same thing at the column (`domain ~ '^[a-z0-9.-]+$'`),
 * so a unicode label would be rejected on write.
 *
 * `URL` does the IDNA conversion, which is why this is not a `toLowerCase()`.
 */
function canonicalDomain(domain: string): string {
  const trimmed = domain.trim().toLowerCase();
  try {
    const { hostname } = new URL(`http://${trimmed}`);
    return hostname;
  } catch {
    /* Not parseable as a host. Returning it unchanged keeps this a pure
       normaliser — rejecting invalid domains is the caller's validation, and
       the column constraint is the backstop. */
    return trimmed;
  }
}

export interface EnsureAdminDomainInput {
  readonly orgId: string;
  readonly domain: string;
  readonly createdBy?: string | null;
}

/**
 * Return the id of the org's `admin_domains` row for `domain`, creating a
 * pending one if it does not exist.
 *
 * The insert is `on conflict do nothing` against the globally exclusive active claim
 * rather than a read-then-write, so two capabilities being added concurrently
 * cannot produce a duplicate or a lost race.
 */
export async function ensureAdminDomain(
  sql: postgres.Sql | postgres.TransactionSql,
  input: EnsureAdminDomainInput,
): Promise<string> {
  const domain = canonicalDomain(input.domain);
  const challenge = createDomainOwnershipChallenge(domain);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const inserted = await sql<readonly { id: string }[]>`
    insert into admin_domains (
      org_id, domain, status, created_by, verification_host, verification_value,
      verification_expires_at
    )
    values (
      ${input.orgId}, ${domain}, 'pending', ${input.createdBy ?? null},
      ${challenge.dnsName}, ${challenge.dnsValue}, ${expiresAt}
    )
    on conflict do nothing
    returning id
  `;
  if (inserted[0] !== undefined) {
    return inserted[0].id;
  }

  /* A conflict can belong to another tenant; reuse only this organization's
     current claim. A released historical row cannot serve as the parent. */
  const existing = await sql<readonly { id: string }[]>`
    select id from admin_domains
    where org_id = ${input.orgId} and lower(domain) = ${domain} and status <> 'released'
    limit 1
  `;
  const found = existing[0];
  if (found === undefined) {
    throw new Error(`Could not resolve a domain identity for ${domain}.`);
  }
  return found.id;
}

/* --------------------------------------------------------------------- */
/* Proof of ownership                                                     */
/* --------------------------------------------------------------------- */

/* A TXT challenge on the domain itself, so it is proved once rather than once
   per capability. The canonical domain row stores the publishable TXT value;
   capability verifiers compare its token digest. */

const TXT_PREFIX = "helix-domain-verification=";

export interface DomainOwnershipChallenge {
  readonly token: string;
  readonly tokenHash: string;
  readonly dnsName: string;
  readonly dnsValue: string;
}

export function createDomainOwnershipChallenge(domain: string): DomainOwnershipChallenge {
  const canonical = canonicalDomain(domain);
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashOwnershipToken(token),
    dnsName: `_helix-verification.${canonical}`,
    dnsValue: `${TXT_PREFIX}${token}`,
  };
}

function hashOwnershipToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The parent-side ownership operations a capability needs. Narrow on purpose:
 *  the mail routes should not depend on the whole domains store. */
export interface DomainOwnershipStore {
  /* Returns the updated domain, or null when it does not exist. Typed
     `unknown` because callers here only care that the write happened. */
  setOwnershipChallenge(orgId: string, id: string, tokenHash: string): Promise<unknown>;
  getOwnershipTokenHash(orgId: string, id: string): Promise<string | null>;
}

export type TxtLookup = (name: string) => Promise<readonly (readonly string[])[]>;

export interface DomainOwnershipVerifier {
  /** True when a TXT record satisfying `tokenHash` is published for `domain`. */
  verify(input: { domain: string; tokenHash: string }): Promise<boolean>;
}

export class DnsTxtDomainOwnershipVerifier implements DomainOwnershipVerifier {
  constructor(private readonly lookupTxt: TxtLookup = dns.resolveTxt) {}

  async verify(input: { domain: string; tokenHash: string }): Promise<boolean> {
    let answers: readonly (readonly string[])[];
    try {
      answers = await this.lookupTxt(`_helix-verification.${canonicalDomain(input.domain)}`);
    } catch (error) {
      /* No record is "not proved yet"; anything else means we could not look,
         which must surface as a fault rather than a failed verification. */
      if (isAbsentDnsAnswer(error)) {
        return false;
      }
      throw error;
    }

    const expected = Buffer.from(input.tokenHash, "hex");
    return answers.some((chunks) => {
      // A TXT value over 255 bytes arrives chunked; the record is their join.
      const value = chunks.join("");
      if (!value.startsWith(TXT_PREFIX)) {
        return false;
      }
      const token = value.slice(TXT_PREFIX.length);
      if (token.length === 0 || token.length > 256) {
        return false;
      }
      const actual = Buffer.from(hashOwnershipToken(token), "hex");
      // Length check first: timingSafeEqual throws on a mismatch.
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

/** Address assignment metadata; exposes no mailbox contents or DNS verification material. */
export async function eligibleMailAddressDomains(
  sql: postgres.Sql,
  orgId: string,
): Promise<{ domain: string; primary: boolean; aliases: boolean }[]> {
  const rows = await sql<{ domain: string; primary: boolean; aliases: boolean }[]>`
    select domain, identity_enabled and identity_mode = 'secondary' as primary, aliases_enabled as aliases
    from admin_domains where org_id = ${orgId} and status = 'verified' and mail_enabled
      and (identity_enabled or aliases_enabled) order by domain
  `;
  return [...rows];
}
