/* Live DNS lookups for admin domain verification.
 *
 * The admin console has always had a `DnsResolver` seam and a verify route that
 * returns 503 without one; nothing ever implemented it, so domain verification
 * could not be completed on any deployment. This is that implementation.
 *
 * Two things shape the design:
 *
 * 1. DNS answers are SETS. A host legitimately carries several TXT records —
 *    an SPF policy beside a provider verification token beside a DKIM key — so
 *    "the observed value" is a selection problem, not a read. Each record type
 *    below selects by its own RFC-defined marker where one exists, and falls
 *    back to matching the expectation so a caller comparing one value against a
 *    set does not get a spurious mismatch.
 * 2. A missing record is a normal answer, not a fault. `ENODATA`/`ENOTFOUND`
 *    mean "no such record", which is exactly what an unverified domain looks
 *    like, so they resolve to `null` rather than throwing. Every other failure
 *    (SERVFAIL, timeout, refused) propagates: reporting "not found" for a
 *    resolver that never answered would tell an operator their DNS is wrong
 *    when the truth is we could not look.
 */

import { promises as dns } from "node:dns";
import type { DnsRecordType, DnsResolver } from "./domains.js";

/** The `node:dns` surface this needs, narrowed so tests can substitute it. */
export interface DnsLookups {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveMx(hostname: string): Promise<{ priority: number; exchange: string }[]>;
  resolveCname(hostname: string): Promise<string[]>;
  resolve4(hostname: string): Promise<string[]>;
}

const defaultLookups: DnsLookups = {
  resolveTxt: (hostname) => dns.resolveTxt(hostname),
  resolveMx: (hostname) => dns.resolveMx(hostname),
  resolveCname: (hostname) => dns.resolveCname(hostname),
  resolve4: (hostname) => dns.resolve4(hostname),
};

/** RFC markers that identify a policy record among a host's other TXT records. */
const TXT_MARKER: Partial<Record<DnsRecordType, string>> = {
  SPF: "v=spf1",
  DKIM: "v=dkim1",
  DMARC: "v=dmarc1",
};

export class NodeDnsResolver implements DnsResolver {
  constructor(private readonly lookups: DnsLookups = defaultLookups) {}

  async lookup(input: {
    readonly recordType: DnsRecordType;
    readonly host: string;
    readonly expectedValue?: string;
  }): Promise<string | null> {
    const { recordType, host, expectedValue } = input;

    if (recordType === "MX") {
      const records = await this.absentAsNull(() => this.lookups.resolveMx(host));
      if (records === null || records.length === 0) {
        return null;
      }
      /* An MX answer is a prioritised set, and each entry is a candidate the
         expectation might name, so compare per entry rather than rendering the
         whole set into one string the operator could never match. */
      const rendered = records
        .map((record) => `${String(record.priority)} ${stripTrailingDot(record.exchange)}`)
        .sort((left, right) => left.localeCompare(right));
      return select(rendered, expectedValue);
    }

    if (recordType === "CNAME") {
      const records = await this.absentAsNull(() => this.lookups.resolveCname(host));
      return records === null || records.length === 0
        ? null
        : select(records.map(stripTrailingDot), expectedValue);
    }

    if (recordType === "A") {
      const records = await this.absentAsNull(() => this.lookups.resolve4(host));
      return records === null || records.length === 0 ? null : select(records, expectedValue);
    }

    // SPF, DKIM, DMARC and TXT all live in TXT records.
    const answers = await this.absentAsNull(() => this.lookups.resolveTxt(host));
    if (answers === null || answers.length === 0) {
      return null;
    }
    /* A long TXT value arrives split into 255-byte chunks; the record is their
       concatenation, so joining is reassembly, not formatting. */
    const values = answers.map((chunks) => chunks.join(""));

    const marker = TXT_MARKER[recordType];
    if (marker !== undefined) {
      const policy = values.find((value) => value.trim().toLowerCase().startsWith(marker));
      /* Returning null when the marker is absent is deliberate: a host with
         TXT records but no SPF record genuinely has no SPF record, and saying
         so beats handing back an unrelated token as though it were one. */
      return policy ?? null;
    }

    return select(values, expectedValue);
  }

  /** `null` for "no such record"; anything else is a real resolver failure. */
  private async absentAsNull<T>(run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      if (isAbsentDnsAnswer(error)) {
        return null;
      }
      throw error;
    }
  }
}

/** Prefer the answer the caller is asking about; otherwise the first. */
function select(values: readonly string[], expectedValue: string | undefined): string | null {
  const first = values[0];
  if (first === undefined) {
    return null;
  }
  if (expectedValue === undefined) {
    return first;
  }
  const wanted = normalize(expectedValue);
  return values.find((value) => normalize(value) === wanted) ?? first;
}

/* Mirrors `normalizeDnsValue` in domains.ts so selection agrees with the
   comparison the route runs afterwards. Kept local rather than exported from
   there: this one only decides which answer to show, and coupling the two
   would invite someone to make the resolver's opinion authoritative. */
function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function stripTrailingDot(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function isAbsentDnsAnswer(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return code === "ENODATA" || code === "ENOTFOUND";
}
