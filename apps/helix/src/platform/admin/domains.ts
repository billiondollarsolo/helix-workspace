import type postgres from "postgres";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod3";
import { createDomainOwnershipChallenge, type DomainOwnershipVerifier } from "./domain-identity.js";
import {
  adminConsoleReadScope,
  adminConsoleWriteScope,
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  conflict,
  invalidRequest,
  notFound,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "./console-shared.js";

/**
 * Admin Console — Domain & DNS.
 *
 * Org domains and the DNS records (MX / SPF / DKIM / DMARC / TXT / CNAME / A)
 * that back mail deliverability and ownership verification. The Domain section
 * of the Admin Console lists the primary domain plus its DNS records with a
 * per-record verification status.
 *
 * DNS verification status is supplied by an injected `dnsResolver` (or read
 * from an out-of-band ops process); this module does not perform live DNS
 * lookups itself so it stays deterministic and offline-testable.
 */

export type DnsRecordType = "MX" | "SPF" | "DKIM" | "DMARC" | "TXT" | "CNAME" | "A";
export type VerificationStatus = "verified" | "pending" | "failed";

export interface DomainRecord {
  readonly id: string;
  readonly orgId: string;
  readonly domain: string;
  readonly isPrimary: boolean;
  readonly verificationStatus: VerificationStatus;
  readonly verifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a domain is currently used for. Both sides are nullable: a registered
 *  domain with neither capability switched on is a normal, expressible state. */
export interface DomainCapabilities {
  readonly adminDomainId: string;
  readonly sending: {
    readonly id: string;
    readonly isDefault: boolean;
    readonly verifiedAt: string | null;
    readonly dkimKeyCount: number;
  } | null;
  readonly receiving: {
    readonly id: string;
    readonly status: "pending" | "verified" | "active" | "disabled";
  } | null;
}

export interface DnsRecordRecord {
  readonly id: string;
  readonly orgId: string;
  readonly domainId: string;
  readonly recordType: DnsRecordType;
  readonly host: string;
  readonly expectedValue: string;
  readonly observedValue: string | null;
  readonly status: VerificationStatus;
  readonly lastCheckedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DomainWithRecords {
  readonly domain: DomainRecord;
  readonly dnsRecords: readonly DnsRecordRecord[];
  /** What the domain is used for; null means the capability is not set up. */
  readonly sending: DomainCapabilities["sending"];
  readonly receiving: DomainCapabilities["receiving"];
}

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

export interface CreateDomainInput {
  readonly orgId: string;
  readonly domain: string;
  readonly isPrimary: boolean;
  readonly createdBy: string;
}

export interface UpsertDnsRecordInput {
  readonly orgId: string;
  readonly domainId: string;
  readonly recordType: DnsRecordType;
  readonly host: string;
  readonly expectedValue: string;
}

export interface SetDnsRecordVerificationInput {
  readonly orgId: string;
  readonly id: string;
  readonly status: VerificationStatus;
  readonly observedValue: string | null;
}

export interface DomainsStore {
  listDomains(orgId: string): Promise<readonly DomainRecord[]>;
  getDomain(orgId: string, id: string): Promise<DomainRecord | null>;
  createDomain(input: CreateDomainInput): Promise<DomainRecord>;
  /** Mark `id` primary and clear the flag from all sibling domains. */
  setPrimaryDomain(orgId: string, id: string): Promise<DomainRecord | null>;
  deleteDomain(orgId: string, id: string): Promise<boolean>;
  /* Store a fresh ownership challenge digest and return the domain. Only the
     digest is kept — the token is shown to the operator once and cannot be
     re-read, so re-issuing is the recovery path for a lost one. */
  setOwnershipChallenge(orgId: string, id: string, tokenHash: string): Promise<DomainRecord | null>;
  /** The digest to check a published TXT record against, or null if unchallenged. */
  getOwnershipTokenHash(orgId: string, id: string): Promise<string | null>;
  /** Record the outcome of an ownership check. */
  setOwnershipVerified(orgId: string, id: string, verified: boolean): Promise<DomainRecord | null>;

  /* What each of the org's domains is used for. One query rather than per-row
     so the console's list does not fan out across two more tables. */
  listCapabilities(orgId: string): Promise<readonly DomainCapabilities[]>;

  listDnsRecords(orgId: string, domainId: string): Promise<readonly DnsRecordRecord[]>;
  upsertDnsRecord(input: UpsertDnsRecordInput): Promise<DnsRecordRecord>;
  setDnsRecordVerification(input: SetDnsRecordVerificationInput): Promise<DnsRecordRecord | null>;
}

/** Thrown by stores when a uniqueness rule is violated. */
export class DomainsConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainsConflictError";
  }
}

/**
 * Live DNS lookup hook. Implementations resolve the actual record value;
 * `null` means the record was not found. Verification compares this against
 * the stored `expectedValue`. Optional — when absent the verify route reports
 * `503` so the UI can fall back to the stored status.
 */
export interface DnsResolver {
  lookup(input: {
    readonly recordType: DnsRecordType;
    readonly host: string;
    /**
     * The value being looked for, supplied so the resolver can pick the right
     * answer out of a set — a host legitimately carries several TXT records
     * (SPF beside a verification token, say), and returning an arbitrary one
     * would report a spurious mismatch.
     *
     * Selection only. The resolver never decides the outcome: the route hands
     * whatever comes back to `evaluateDnsRecord`, so a resolver cannot turn a
     * missing record into a pass by echoing the expectation.
     */
    readonly expectedValue?: string;
  }): Promise<string | null>;
}

/**
 * The DNS records Helix needs published for a domain it will send and receive
 * mail for.
 *
 * Seeded on domain creation so an operator is not left with an empty panel and
 * a blank three-field form, having to know that Helix wants an MX at the apex,
 * an SPF include, and a DMARC policy at `_dmarc`.
 *
 * `mailHostname` is required rather than guessed. Helix does not otherwise know
 * its own public mail hostname — `MAIL_SMTP_RECEIVER_HOST` is a bind address
 * and `HELIX_PUBLIC_URL` is the console — and an MX pointing at the wrong host
 * silently blackholes mail, which is worse than no MX at all. Without it we
 * seed nothing and the console explains what is missing.
 *
 * DKIM is deliberately absent: its value is a public key that does not exist
 * until a keypair is generated for the domain (Mail admin owns that, and
 * `dkimDnsRecord` composes the record from it). Seeding a DKIM row with a
 * placeholder would put a record on screen that can never verify.
 */
export function expectedDnsRecordsForDomain(input: {
  readonly domain: string;
  readonly mailHostname: string;
}): readonly Omit<UpsertDnsRecordInput, "orgId" | "domainId">[] {
  const { domain, mailHostname } = input;
  return [
    {
      recordType: "MX",
      host: domain,
      // Priority 10 is the conventional single-host value; an operator running
      // several relays edits this row rather than starting from nothing.
      expectedValue: `10 ${mailHostname}`,
    },
    {
      recordType: "SPF",
      host: domain,
      // `~all` (softfail) rather than `-all`: a hard fail on a domain that is
      // still being set up bounces legitimate mail.
      expectedValue: `v=spf1 mx a:${mailHostname} ~all`,
    },
    {
      recordType: "DMARC",
      host: `_dmarc.${domain}`,
      // `p=none` is the monitoring posture every DMARC rollout starts from;
      // tightening to quarantine/reject before reports are read breaks mail.
      expectedValue: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
    },
  ];
}

/** Compare an observed DNS value against the expectation. */
export function evaluateDnsRecord(
  expectedValue: string,
  observedValue: string | null,
): VerificationStatus {
  if (observedValue === null) {
    return "failed";
  }
  return normalizeDnsValue(observedValue) === normalizeDnsValue(expectedValue)
    ? "verified"
    : "failed";
}

function normalizeDnsValue(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/iu, "Domain must contain only letters, digits, dots, and hyphens.");
const recordTypeSchema = z.enum(["MX", "SPF", "DKIM", "DMARC", "TXT", "CNAME", "A"]);
const idParams = z.object({ id: z.string().uuid() });
const dnsRecordParams = z.object({ id: z.string().uuid(), recordId: z.string().uuid() });

const createDomainBody = z
  .object({
    domain: domainSchema,
    isPrimary: z.boolean().default(false),
  })
  .strict();

const upsertDnsRecordBody = z
  .object({
    recordType: recordTypeSchema,
    host: z.string().trim().min(1).max(253),
    expectedValue: z.string().trim().min(1).max(4000),
  })
  .strict();

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

export interface RegisterAdminDomainsRoutesOptions {
  readonly store: DomainsStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly auditSink?: AdminConsoleAuditSink | undefined;
  readonly dnsResolver?: DnsResolver | undefined;
  /**
   * Checks a published TXT record against a domain's ownership challenge. When
   * absent, the challenge can be issued but not verified, and the verify route
   * says so rather than reporting a failure it never actually tested.
   */
  readonly ownershipVerifier?: DomainOwnershipVerifier | undefined;
  /**
   * Public hostname this deployment receives mail on. When set, creating a
   * domain seeds the MX / SPF / DMARC records Helix needs published for it.
   * Absent, no records are seeded — see `expectedDnsRecordsForDomain`.
   */
  readonly mailHostname?: string | undefined;
}

/**
 * Register the Domain & DNS admin routes:
 *
 *   GET    /api/admin/domains                          — domains + DNS records
 *   POST   /api/admin/domains                          — register a domain
 *   POST   /api/admin/domains/:id/primary              — mark primary
 *   DELETE /api/admin/domains/:id                      — remove a domain
 *   GET    /api/admin/domains/:id/dns                  — DNS records for domain
 *   PUT    /api/admin/domains/:id/dns                  — upsert a DNS record
 *   POST   /api/admin/domains/:id/dns/:recordId/verify — re-check a record
 */
export async function registerAdminDomainsRoutes(
  app: FastifyInstance,
  options: RegisterAdminDomainsRoutesOptions,
): Promise<void> {
  const { store, actorFromRequest, auditSink, dnsResolver, mailHostname, ownershipVerifier } =
    options;

  app.get("/api/admin/domains", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const domains = await store.listDomains(actor.orgId);
    /* One capability query for the whole list, indexed by parent id, rather
       than two more round trips per domain. */
    const capabilities = new Map(
      (await store.listCapabilities(actor.orgId)).map((entry) => [entry.adminDomainId, entry]),
    );
    const withRecords: DomainWithRecords[] = [];
    for (const domain of domains) {
      const capability = capabilities.get(domain.id);
      withRecords.push({
        domain,
        dnsRecords: await store.listDnsRecords(actor.orgId, domain.id),
        sending: capability?.sending ?? null,
        receiving: capability?.receiving ?? null,
      });
    }
    return { domains: withRecords };
  });

  app.post("/api/admin/domains", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = createDomainBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid domain.", body.error.issues));
    }
    let domain: DomainRecord;
    try {
      domain = await store.createDomain({
        orgId: actor.orgId,
        domain: body.data.domain.toLowerCase(),
        isPrimary: body.data.isPrimary,
        createdBy: actor.id,
      });
    } catch (error) {
      if (error instanceof DomainsConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    /* Seed the records Helix needs published, so the panel opens with the work
       to do rather than an empty table. Best-effort: a store that rejects one
       must not undo a domain that was created successfully, and the operator
       can still add records by hand. */
    if (mailHostname !== undefined && mailHostname.length > 0) {
      for (const record of expectedDnsRecordsForDomain({
        domain: domain.domain,
        mailHostname,
      })) {
        try {
          await store.upsertDnsRecord({ orgId: actor.orgId, domainId: domain.id, ...record });
        } catch (error) {
          request.log.warn(
            { err: error, domain: domain.domain, recordType: record.recordType },
            "could not seed expected DNS record",
          );
        }
      }
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.domain.created",
      objectType: "admin_domain",
      objectId: domain.id,
      metadata: { domain: domain.domain, isPrimary: domain.isPrimary },
    });
    return reply.code(201).send({ domain });
  });

  app.post("/api/admin/domains/:id/primary", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    const domain = await store.setPrimaryDomain(actor.orgId, params.data.id);
    if (domain === null) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.domain.set_primary",
      objectType: "admin_domain",
      objectId: domain.id,
      metadata: { domain: domain.domain },
    });
    return { domain };
  });

  /* Proof of ownership, on the domain rather than on one thing you do with it.
     Proving control of example.com to receive mail proves it for sending too,
     so the challenge lives here and the capabilities read the result. */
  app.post("/api/admin/domains/:id/challenge", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    const current = await store.getDomain(actor.orgId, params.data.id);
    if (current === null) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    const challenge = createDomainOwnershipChallenge(current.domain);
    const domain = await store.setOwnershipChallenge(actor.orgId, current.id, challenge.tokenHash);
    if (domain === null) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.domain.challenge_issued",
      objectType: "admin_domain",
      objectId: domain.id,
      metadata: { domain: domain.domain },
    });
    /* The token is returned here and nowhere else: only its digest is stored,
       so re-issuing is the only way back if the operator loses it. */
    return reply.code(201).send({
      domain,
      verification: { dnsName: challenge.dnsName, dnsValue: challenge.dnsValue },
    });
  });

  app.post("/api/admin/domains/:id/verify-ownership", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    if (ownershipVerifier === undefined) {
      return reply.code(503).send({
        error: "Domain ownership verification is not configured on this deployment.",
        code: "service_unavailable",
      });
    }
    const current = await store.getDomain(actor.orgId, params.data.id);
    if (current === null) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    const tokenHash = await store.getOwnershipTokenHash(actor.orgId, current.id);
    if (tokenHash === null) {
      /* Nothing to check against. Reporting this as a failed verification
         would tell the operator their DNS is wrong when in fact no challenge
         has been issued. */
      return reply.code(409).send({
        error: "This domain has no ownership challenge. Issue one first.",
        code: "conflict",
      });
    }

    let owned: boolean;
    try {
      owned = await ownershipVerifier.verify({ domain: current.domain, tokenHash });
    } catch {
      // Could-not-look is not the same as not-published.
      return reply.code(503).send({
        error: "Domain ownership verification is temporarily unavailable.",
        code: "service_unavailable",
      });
    }

    const domain = await store.setOwnershipVerified(actor.orgId, current.id, owned);
    if (domain === null) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.domain.ownership_checked",
      objectType: "admin_domain",
      objectId: domain.id,
      metadata: { domain: domain.domain, verified: owned },
    });
    return { domain, verified: owned };
  });

  app.delete("/api/admin/domains/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    const deleted = await store.deleteDomain(actor.orgId, params.data.id);
    if (!deleted) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.domain.deleted",
      objectType: "admin_domain",
      objectId: params.data.id,
    });
    return { status: "deleted" };
  });

  app.get("/api/admin/domains/:id/dns", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    const domain = await store.getDomain(actor.orgId, params.data.id);
    if (domain === null) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    return { dnsRecords: await store.listDnsRecords(actor.orgId, params.data.id) };
  });

  app.put("/api/admin/domains/:id/dns", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    const body = upsertDnsRecordBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid DNS record.", body.error.issues));
    }
    const domain = await store.getDomain(actor.orgId, params.data.id);
    if (domain === null) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    const dnsRecord = await store.upsertDnsRecord({
      orgId: actor.orgId,
      domainId: params.data.id,
      recordType: body.data.recordType,
      host: body.data.host,
      expectedValue: body.data.expectedValue,
    });
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.dns_record.upserted",
      objectType: "admin_dns_record",
      objectId: dnsRecord.id,
      metadata: { recordType: dnsRecord.recordType, host: dnsRecord.host },
    });
    return { dnsRecord };
  });

  app.post("/api/admin/domains/:id/dns/:recordId/verify", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = dnsRecordParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid DNS record identifiers."));
    }
    if (dnsResolver === undefined) {
      return reply
        .code(503)
        .send(invalidRequest("DNS verification is not configured on this deployment."));
    }
    const records = await store.listDnsRecords(actor.orgId, params.data.id);
    const target = records.find((record) => record.id === params.data.recordId);
    if (target === undefined) {
      return reply.code(404).send(notFound("DNS record not found."));
    }
    const observedValue = await dnsResolver.lookup({
      recordType: target.recordType,
      host: target.host,
      expectedValue: target.expectedValue,
    });
    const status = evaluateDnsRecord(target.expectedValue, observedValue);
    const dnsRecord = await store.setDnsRecordVerification({
      orgId: actor.orgId,
      id: target.id,
      status,
      observedValue,
    });
    if (dnsRecord === null) {
      return reply.code(404).send(notFound("DNS record not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.dns_record.verified",
      objectType: "admin_dns_record",
      objectId: dnsRecord.id,
      metadata: { recordType: dnsRecord.recordType, status: dnsRecord.status },
    });
    return { dnsRecord };
  });
}

// --------------------------------------------------------------------------
// Postgres store
// --------------------------------------------------------------------------

interface DomainRow {
  readonly id: string;
  readonly org_id: string;
  readonly domain: string;
  readonly is_primary: boolean;
  readonly verification_status: VerificationStatus;
  readonly verified_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface DnsRecordRow {
  readonly id: string;
  readonly org_id: string;
  readonly domain_id: string;
  readonly record_type: DnsRecordType;
  readonly host: string;
  readonly expected_value: string;
  readonly observed_value: string | null;
  readonly status: VerificationStatus;
  readonly last_checked_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresDomainsStore implements DomainsStore {
  constructor(private readonly sql: postgres.Sql) {}

  async listDomains(orgId: string): Promise<readonly DomainRecord[]> {
    const rows = (await this.sql`
      select id, org_id, domain, is_primary, verification_status, verified_at,
             created_at, updated_at
      from admin_domains
      where org_id = ${orgId}
      order by is_primary desc, domain asc
    `) as unknown as readonly DomainRow[];
    return rows.map(mapDomainRow);
  }

  async getDomain(orgId: string, id: string): Promise<DomainRecord | null> {
    const rows = (await this.sql`
      select id, org_id, domain, is_primary, verification_status, verified_at,
             created_at, updated_at
      from admin_domains
      where org_id = ${orgId} and id = ${id}
    `) as unknown as readonly DomainRow[];
    const row = rows[0];
    return row === undefined ? null : mapDomainRow(row);
  }

  async createDomain(input: CreateDomainInput): Promise<DomainRecord> {
    const rows = (await this.sql`
      insert into admin_domains (org_id, domain, is_primary, created_by)
      values (${input.orgId}, ${input.domain}, ${input.isPrimary}, ${input.createdBy})
      on conflict do nothing
      returning id, org_id, domain, is_primary, verification_status, verified_at,
                created_at, updated_at
    `) as unknown as readonly DomainRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new DomainsConflictError("This domain is already registered for the org.");
    }
    const created = mapDomainRow(row);
    if (created.isPrimary) {
      await this.sql`
        update admin_domains set is_primary = false, updated_at = now()
        where org_id = ${input.orgId} and id <> ${created.id}
      `;
    }
    return created;
  }

  async setOwnershipChallenge(
    orgId: string,
    id: string,
    tokenHash: string,
  ): Promise<DomainRecord | null> {
    const rows = (await this.sql`
      update admin_domains
      set verification_token_hash = ${tokenHash}, updated_at = now()
      where org_id = ${orgId} and id = ${id}
      returning id, org_id, domain, is_primary, verification_status, verified_at,
                created_at, updated_at
    `) as unknown as readonly DomainRow[];
    const row = rows[0];
    return row === undefined ? null : mapDomainRow(row);
  }

  async getOwnershipTokenHash(orgId: string, id: string): Promise<string | null> {
    const rows = (await this.sql`
      select verification_token_hash from admin_domains
      where org_id = ${orgId} and id = ${id}
    `) as unknown as readonly { readonly verification_token_hash: string | null }[];
    return rows[0]?.verification_token_hash ?? null;
  }

  /* `verified_at` keeps its first value on a re-check that still passes: it
     records when the domain was proved, not when someone last looked. */
  async setOwnershipVerified(
    orgId: string,
    id: string,
    verified: boolean,
  ): Promise<DomainRecord | null> {
    const rows = (await this.sql`
      update admin_domains
      set verification_status = ${verified ? "verified" : "failed"},
          verified_at = ${verified ? this.sql`coalesce(verified_at, now())` : null},
          updated_at = now()
      where org_id = ${orgId} and id = ${id}
      returning id, org_id, domain, is_primary, verification_status, verified_at,
                created_at, updated_at
    `) as unknown as readonly DomainRow[];
    const row = rows[0];
    return row === undefined ? null : mapDomainRow(row);
  }

  async setPrimaryDomain(orgId: string, id: string): Promise<DomainRecord | null> {
    const existing = await this.getDomain(orgId, id);
    if (existing === null) {
      return null;
    }
    await this.sql`
      update admin_domains set is_primary = false, updated_at = now()
      where org_id = ${orgId} and id <> ${id}
    `;
    const rows = (await this.sql`
      update admin_domains set is_primary = true, updated_at = now()
      where org_id = ${orgId} and id = ${id}
      returning id, org_id, domain, is_primary, verification_status, verified_at,
                created_at, updated_at
    `) as unknown as readonly DomainRow[];
    const row = rows[0];
    return row === undefined ? null : mapDomainRow(row);
  }

  async deleteDomain(orgId: string, id: string): Promise<boolean> {
    const rows = (await this.sql`
      delete from admin_domains where org_id = ${orgId} and id = ${id} returning id
    `) as unknown as readonly { readonly id: string }[];
    return rows.length > 0;
  }

  async listCapabilities(orgId: string): Promise<readonly DomainCapabilities[]> {
    const rows = (await this.sql`
      select
        p.id as admin_domain_id,
        s.id as sending_id,
        s.is_default as sending_is_default,
        s.verified_at as sending_verified_at,
        (select count(*)::int from mail_dkim_keys k where k.domain_id = s.id) as dkim_key_count,
        r.id as receiving_id,
        r.status as receiving_status
      from admin_domains p
      left join mail_sending_domains s on s.admin_domain_id = p.id
      left join mail_receiving_domains r on r.admin_domain_id = p.id
      where p.org_id = ${orgId}
    `) as unknown as readonly {
      readonly admin_domain_id: string;
      readonly sending_id: string | null;
      readonly sending_is_default: boolean | null;
      readonly sending_verified_at: Date | null;
      readonly dkim_key_count: number | null;
      readonly receiving_id: string | null;
      readonly receiving_status: "pending" | "verified" | "active" | "disabled";
    }[];
    return rows.map((row) => ({
      adminDomainId: row.admin_domain_id,
      sending:
        row.sending_id === null
          ? null
          : {
              id: row.sending_id,
              isDefault: row.sending_is_default ?? false,
              verifiedAt: row.sending_verified_at?.toISOString() ?? null,
              dkimKeyCount: row.dkim_key_count ?? 0,
            },
      receiving:
        row.receiving_id === null ? null : { id: row.receiving_id, status: row.receiving_status },
    }));
  }

  async listDnsRecords(orgId: string, domainId: string): Promise<readonly DnsRecordRecord[]> {
    const rows = (await this.sql`
      select id, org_id, domain_id, record_type, host, expected_value, observed_value,
             status, last_checked_at, created_at, updated_at
      from admin_dns_records
      where org_id = ${orgId} and domain_id = ${domainId}
      order by record_type asc, host asc
    `) as unknown as readonly DnsRecordRow[];
    return rows.map(mapDnsRecordRow);
  }

  async upsertDnsRecord(input: UpsertDnsRecordInput): Promise<DnsRecordRecord> {
    const existing = (await this.sql`
      select id from admin_dns_records
      where org_id = ${input.orgId} and domain_id = ${input.domainId}
        and record_type = ${input.recordType} and host = ${input.host}
    `) as unknown as readonly { readonly id: string }[];
    const existingId = existing[0]?.id ?? null;
    if (existingId !== null) {
      const rows = (await this.sql`
        update admin_dns_records
        set expected_value = ${input.expectedValue}, status = 'pending',
            observed_value = null, updated_at = now()
        where org_id = ${input.orgId} and id = ${existingId}
        returning id, org_id, domain_id, record_type, host, expected_value,
                  observed_value, status, last_checked_at, created_at, updated_at
      `) as unknown as readonly DnsRecordRow[];
      const row = rows[0];
      if (row === undefined) {
        throw new Error("Failed to update DNS record.");
      }
      return mapDnsRecordRow(row);
    }
    const rows = (await this.sql`
      insert into admin_dns_records
        (org_id, domain_id, record_type, host, expected_value, status)
      values
        (${input.orgId}, ${input.domainId}, ${input.recordType}, ${input.host},
         ${input.expectedValue}, 'pending')
      returning id, org_id, domain_id, record_type, host, expected_value,
                observed_value, status, last_checked_at, created_at, updated_at
    `) as unknown as readonly DnsRecordRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Failed to insert DNS record.");
    }
    return mapDnsRecordRow(row);
  }

  async setDnsRecordVerification(
    input: SetDnsRecordVerificationInput,
  ): Promise<DnsRecordRecord | null> {
    const rows = (await this.sql`
      update admin_dns_records
      set status = ${input.status}, observed_value = ${input.observedValue},
          last_checked_at = now(), updated_at = now()
      where org_id = ${input.orgId} and id = ${input.id}
      returning id, org_id, domain_id, record_type, host, expected_value,
                observed_value, status, last_checked_at, created_at, updated_at
    `) as unknown as readonly DnsRecordRow[];
    const row = rows[0];
    return row === undefined ? null : mapDnsRecordRow(row);
  }
}

function mapDomainRow(row: DomainRow): DomainRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    domain: row.domain,
    isPrimary: row.is_primary,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapDnsRecordRow(row: DnsRecordRow): DnsRecordRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    domainId: row.domain_id,
    recordType: row.record_type,
    host: row.host,
    expectedValue: row.expected_value,
    observedValue: row.observed_value,
    status: row.status,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// --------------------------------------------------------------------------
// In-memory store (tests / offline)
// --------------------------------------------------------------------------

interface MemDomain {
  id: string;
  orgId: string;
  domain: string;
  /** SHA-256 digest of the outstanding ownership challenge, if any. */
  verificationTokenHash?: string | null;
  isPrimary: boolean;
  verificationStatus: VerificationStatus;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MemDnsRecord {
  id: string;
  orgId: string;
  domainId: string;
  recordType: DnsRecordType;
  host: string;
  expectedValue: string;
  observedValue: string | null;
  status: VerificationStatus;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Deterministic in-memory {@link DomainsStore}. */
export class InMemoryDomainsStore implements DomainsStore {
  readonly #domains = new Map<string, MemDomain>();
  readonly #dnsRecords = new Map<string, MemDnsRecord>();
  #seq = 0;

  constructor(private readonly options: { readonly now?: () => Date } = {}) {}

  #now(): string {
    return (this.options.now ?? (() => new Date("2026-05-21T00:00:00.000Z")))().toISOString();
  }

  #id(): string {
    this.#seq += 1;
    return `00000000-0000-4000-b000-${this.#seq.toString(16).padStart(12, "0")}`;
  }

  async setOwnershipChallenge(
    orgId: string,
    id: string,
    tokenHash: string,
  ): Promise<DomainRecord | null> {
    const domain = this.#domains.get(id);
    if (domain === undefined || domain.orgId !== orgId) {
      return null;
    }
    domain.verificationTokenHash = tokenHash;
    domain.updatedAt = this.#now();
    return { ...domain };
  }

  async getOwnershipTokenHash(orgId: string, id: string): Promise<string | null> {
    const domain = this.#domains.get(id);
    if (domain === undefined || domain.orgId !== orgId) {
      return null;
    }
    return domain.verificationTokenHash ?? null;
  }

  async setOwnershipVerified(
    orgId: string,
    id: string,
    verified: boolean,
  ): Promise<DomainRecord | null> {
    const domain = this.#domains.get(id);
    if (domain === undefined || domain.orgId !== orgId) {
      return null;
    }
    domain.verificationStatus = verified ? "verified" : "failed";
    domain.verifiedAt = verified ? (domain.verifiedAt ?? this.#now()) : null;
    domain.updatedAt = this.#now();
    return { ...domain };
  }

  async listDomains(orgId: string): Promise<readonly DomainRecord[]> {
    return [...this.#domains.values()]
      .filter((domain) => domain.orgId === orgId)
      .map((domain) => ({ ...domain }))
      .sort((a, b) =>
        a.isPrimary === b.isPrimary ? a.domain.localeCompare(b.domain) : a.isPrimary ? -1 : 1,
      );
  }

  async getDomain(orgId: string, id: string): Promise<DomainRecord | null> {
    const domain = this.#domains.get(id);
    return domain === undefined || domain.orgId !== orgId ? null : { ...domain };
  }

  async createDomain(input: CreateDomainInput): Promise<DomainRecord> {
    const clash = [...this.#domains.values()].some(
      (domain) =>
        domain.orgId === input.orgId && domain.domain.toLowerCase() === input.domain.toLowerCase(),
    );
    if (clash) {
      throw new DomainsConflictError("This domain is already registered for the org.");
    }
    const now = this.#now();
    const domain: MemDomain = {
      id: this.#id(),
      orgId: input.orgId,
      domain: input.domain,
      isPrimary: input.isPrimary,
      verificationStatus: "pending",
      verifiedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    if (domain.isPrimary) {
      for (const other of this.#domains.values()) {
        if (other.orgId === input.orgId) {
          other.isPrimary = false;
        }
      }
    }
    this.#domains.set(domain.id, domain);
    return { ...domain };
  }

  async setPrimaryDomain(orgId: string, id: string): Promise<DomainRecord | null> {
    const domain = this.#domains.get(id);
    if (domain === undefined || domain.orgId !== orgId) {
      return null;
    }
    for (const other of this.#domains.values()) {
      if (other.orgId === orgId) {
        other.isPrimary = other.id === id;
        other.updatedAt = this.#now();
      }
    }
    return { ...domain };
  }

  async deleteDomain(orgId: string, id: string): Promise<boolean> {
    const domain = this.#domains.get(id);
    if (domain === undefined || domain.orgId !== orgId) {
      return false;
    }
    this.#domains.delete(id);
    for (const [recordId, record] of this.#dnsRecords) {
      if (record.domainId === id) {
        this.#dnsRecords.delete(recordId);
      }
    }
    return true;
  }

  /* This adapter has no mail tables; route tests that care about capabilities
     assert against the Postgres store or the mail routes directly. */
  async listCapabilities(): Promise<readonly DomainCapabilities[]> {
    return [];
  }

  async listDnsRecords(orgId: string, domainId: string): Promise<readonly DnsRecordRecord[]> {
    return [...this.#dnsRecords.values()]
      .filter((record) => record.orgId === orgId && record.domainId === domainId)
      .map((record) => ({ ...record }))
      .sort((a, b) =>
        a.recordType === b.recordType
          ? a.host.localeCompare(b.host)
          : a.recordType.localeCompare(b.recordType),
      );
  }

  async upsertDnsRecord(input: UpsertDnsRecordInput): Promise<DnsRecordRecord> {
    const now = this.#now();
    const existing = [...this.#dnsRecords.values()].find(
      (record) =>
        record.orgId === input.orgId &&
        record.domainId === input.domainId &&
        record.recordType === input.recordType &&
        record.host === input.host,
    );
    if (existing !== undefined) {
      existing.expectedValue = input.expectedValue;
      existing.status = "pending";
      existing.observedValue = null;
      existing.updatedAt = now;
      return { ...existing };
    }
    const record: MemDnsRecord = {
      id: this.#id(),
      orgId: input.orgId,
      domainId: input.domainId,
      recordType: input.recordType,
      host: input.host,
      expectedValue: input.expectedValue,
      observedValue: null,
      status: "pending",
      lastCheckedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#dnsRecords.set(record.id, record);
    return { ...record };
  }

  async setDnsRecordVerification(
    input: SetDnsRecordVerificationInput,
  ): Promise<DnsRecordRecord | null> {
    const record = this.#dnsRecords.get(input.id);
    if (record === undefined || record.orgId !== input.orgId) {
      return null;
    }
    record.status = input.status;
    record.observedValue = input.observedValue;
    record.lastCheckedAt = this.#now();
    record.updatedAt = this.#now();
    return { ...record };
  }
}
