import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type postgres from "postgres";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { parse as parseDomain } from "tldts";
import { z } from "zod";
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
export type DomainStatus = "pending" | "verified" | "quarantined" | "released";
export type DomainIdentityMode = "secondary" | "alias";

export interface DomainRecord {
  readonly id: string;
  readonly orgId: string;
  readonly domain: string;
  readonly isPrimary: boolean;
  readonly status: DomainStatus;
  readonly verifiedAt: string | null;
  readonly identityEnabled: boolean;
  readonly mailEnabled: boolean;
  readonly aliasesEnabled: boolean;
  readonly customHostEnabled: boolean;
  readonly federationEnabled: boolean;
  readonly providerId: string | null;
  readonly identityMode: DomainIdentityMode;
  readonly aliasTargetDomainId: string | null;
  readonly verificationHost: string;
  readonly verificationValue: string;
  readonly verificationExpiresAt: string;
  readonly verificationAttempts: number;
  readonly verificationLastAttemptAt: string | null;
  readonly quarantinedAt: string | null;
  readonly releasedAt: string | null;
  readonly claimableAfter: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
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
}

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

export interface CreateDomainInput {
  readonly orgId: string;
  readonly domain: string;
  readonly createdBy: string;
  readonly verificationHost: string;
  readonly verificationValue: string;
  readonly verificationExpiresAt: string;
}

export interface RotateDomainChallengeInput {
  readonly orgId: string;
  readonly id: string;
  readonly verificationValue: string;
  readonly verificationExpiresAt: string;
}

export interface RecordDomainVerificationInput {
  readonly orgId: string;
  readonly id: string;
  readonly verified: boolean;
  readonly actorId: string;
}

export interface SetDomainCapabilitiesInput {
  readonly orgId: string;
  readonly id: string;
  readonly actorId: string;
  readonly identityEnabled: boolean;
  readonly mailEnabled: boolean;
  readonly aliasesEnabled: boolean;
  readonly customHostEnabled: boolean;
  readonly federationEnabled: boolean;
  readonly providerId: string | null;
  readonly identityMode: DomainIdentityMode;
  readonly aliasTargetDomainId: string | null;
}

export interface DomainPrimaryTransitionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly fromDomainId: string | null;
  readonly toDomainId: string | null;
  readonly changedBy: string | null;
  readonly changedAt: string;
  readonly rollbackUntil: string;
  readonly rolledBackAt: string | null;
  readonly rolledBackBy: string | null;
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
  findVerifiedDomain(domain: string): Promise<DomainRecord | null>;
  createDomain(input: CreateDomainInput): Promise<DomainRecord>;
  rotateDomainChallenge(input: RotateDomainChallengeInput): Promise<DomainRecord | null>;
  recordDomainVerification(input: RecordDomainVerificationInput): Promise<DomainRecord | null>;
  setDomainCapabilities(input: SetDomainCapabilitiesInput): Promise<DomainRecord | null>;
  setPrimaryDomain(orgId: string, id: string, actorId: string): Promise<DomainRecord | null>;
  listPrimaryTransitions(orgId: string): Promise<readonly DomainPrimaryTransitionRecord[]>;
  rollbackPrimaryDomain(
    orgId: string,
    transitionId: string,
    actorId: string,
  ): Promise<DomainRecord | null>;
  quarantineDomain(orgId: string, id: string, actorId: string): Promise<DomainRecord | null>;
  releaseDomain(orgId: string, id: string): Promise<DomainRecord | null>;

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
  }): Promise<readonly string[]>;
}

/** Compare an observed DNS value against the expectation. */
export function evaluateDnsRecord(
  recordType: DnsRecordType,
  expectedValue: string,
  observedValues: readonly string[],
): VerificationStatus {
  const expected = normalizeDnsValue(recordType, expectedValue);
  return observedValues.some((value) => normalizeDnsValue(recordType, value) === expected)
    ? "verified"
    : "failed";
}

function normalizeDnsValue(recordType: DnsRecordType, value: string): string {
  const trimmed = value.trim().replace(/^"(.*)"$/u, "$1");
  if (recordType === "MX") {
    const match = /^(\d+)\s+(.+)$/u.exec(trimmed);
    const exchange = match?.[2];
    return match === null
      ? trimmed
      : `${String(Number(match[1]))} ${exchange === undefined ? "" : exchange.replace(/\.$/u, "").toLowerCase()}`;
  }
  if (recordType === "CNAME") {
    return trimmed.replace(/\.$/u, "").toLowerCase();
  }
  return recordType === "SPF" ? trimmed.replace(/\s+/gu, " ") : trimmed;
}

export function normalizeDomain(value: string): string {
  const input = value.trim();
  if (input.endsWith(".") || !/^[\p{ASCII}]*$/u.test(input)) {
    throw new Error("Use an ASCII domain without a trailing dot.");
  }
  const domain = domainToASCII(input).toLowerCase();
  const labels = domain.split(".");
  const parsed = parseDomain(domain, { allowPrivateDomains: false, validateHostname: true });
  if (
    domain.length > 253 ||
    labels.length < 2 ||
    isIP(domain) !== 0 ||
    labels.some(
      (label) =>
        label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    ) ||
    labels.some((label) => label.startsWith("xn--")) ||
    parsed.domain === null ||
    !parsed.isIcann
  ) {
    throw new Error("Domain must be a non-IDN registrable ICANN hostname.");
  }
  return domain;
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

const domainSchema = z.string().trim().min(1).max(253);
const recordTypeSchema = z.enum(["MX", "SPF", "DKIM", "DMARC", "TXT", "CNAME", "A"]);
const idParams = z.object({ id: z.string().uuid() });
const dnsRecordParams = z.object({ id: z.string().uuid(), recordId: z.string().uuid() });

const challengeTtlMs = 72 * 60 * 60 * 1_000;
const verificationRetryMs = 30 * 1_000;

const createDomainBody = z
  .object({
    domain: domainSchema,
  })
  .strict();

const updateCapabilitiesBody = z
  .object({
    identityEnabled: z.boolean().optional(),
    mailEnabled: z.boolean().optional(),
    aliasesEnabled: z.boolean().optional(),
    customHostEnabled: z.boolean().optional(),
    federationEnabled: z.boolean().optional(),
    providerId: z.string().uuid().nullable().optional(),
    identityMode: z.enum(["secondary", "alias"]).optional(),
    aliasTargetDomainId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one capability must change.");

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
  readonly auditSink: AdminConsoleAuditSink;
  readonly dnsResolver?: DnsResolver | undefined;
  readonly now?: (() => Date) | undefined;
  readonly challengeToken?: (() => string) | undefined;
}

/**
 * Register the Domain & DNS admin routes:
 *
 *   GET    /api/admin/domains                          — domains + DNS records
 *   POST   /api/admin/domains                          — register a domain
 *   POST   /api/admin/domains/:id/verify               — verify ownership TXT
 *   POST   /api/admin/domains/:id/challenge            — rotate expired challenge
 *   PATCH  /api/admin/domains/:id/capabilities         — set verified capabilities/alias mode
 *   POST   /api/admin/domains/:id/primary              — mark primary
 *   POST   /api/admin/domains/:id/quarantine           — fail closed immediately
 *   GET    /api/admin/domains/primary-transitions      — primary change audit
 *   POST   /api/admin/domains/primary-transitions/:id/rollback — rollback latest change
 *   DELETE /api/admin/domains/:id                      — release a domain claim
 *   GET    /api/admin/domains/:id/dns                  — DNS records for domain
 *   PUT    /api/admin/domains/:id/dns                  — upsert a DNS record
 *   POST   /api/admin/domains/:id/dns/:recordId/verify — re-check a record
 */
export async function registerAdminDomainsRoutes(
  app: FastifyInstance,
  options: RegisterAdminDomainsRoutesOptions,
): Promise<void> {
  const {
    store,
    actorFromRequest,
    auditSink,
    dnsResolver,
    now = () => new Date(),
    challengeToken = () => randomBytes(32).toString("base64url"),
  } = options;

  app.get("/api/admin/domains", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor, "admin.domains")) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return { domains: await readDomainsWithRecords(store, actor.orgId) };
  });

  app.post("/api/admin/domains", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor, "admin.domains")) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = createDomainBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid domain.", body.error.issues));
    }
    let normalizedDomain: string;
    try {
      normalizedDomain = normalizeDomain(body.data.domain);
    } catch (error) {
      return reply
        .code(400)
        .send(invalidRequest(error instanceof Error ? error.message : "Invalid domain."));
    }
    const expiresAt = new Date(now().getTime() + challengeTtlMs).toISOString();
    let domain: DomainRecord;
    try {
      domain = await store.createDomain({
        orgId: actor.orgId,
        domain: normalizedDomain,
        createdBy: actor.id,
        verificationHost: `_helix-verification.${normalizedDomain}`,
        verificationValue: `helix-domain-verification=${challengeToken()}`,
        verificationExpiresAt: expiresAt,
      });
    } catch (error) {
      if (error instanceof DomainsConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.domain.created",
      objectType: "admin_domain",
      objectId: domain.id,
      metadata: { domain: domain.domain },
    });
    return reply.code(201).send({ domain });
  });

  app.post("/api/admin/domains/:id/verify", async (request, reply) => {
    const actor = await actorFromRequest(request);
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    if (
      !canWriteAdminConsole(actor, "admin.domains", {
        type: "domain",
        id: params.data.id,
        orgId: actor.orgId,
      })
    ) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    if (dnsResolver === undefined) {
      return reply
        .code(503)
        .send(invalidRequest("DNS verification is not configured on this deployment."));
    }
    const domain = await store.getDomain(actor.orgId, params.data.id);
    if (domain === null) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    const currentTime = now();
    if (new Date(domain.verificationExpiresAt) <= currentTime) {
      return reply.code(410).send(invalidRequest("Domain verification challenge has expired."));
    }
    if (
      domain.verificationLastAttemptAt !== null &&
      currentTime.getTime() - new Date(domain.verificationLastAttemptAt).getTime() <
        verificationRetryMs
    ) {
      return reply
        .code(429)
        .header("retry-after", String(verificationRetryMs / 1_000))
        .send(invalidRequest("Wait before retrying domain verification."));
    }

    let observedValues: readonly string[];
    try {
      observedValues = await dnsResolver.lookup({
        recordType: "TXT",
        host: domain.verificationHost,
      });
    } catch (error) {
      await auditAdminAction(auditSink, {
        orgId: actor.orgId,
        actorId: actor.id,
        verb: "admin.domain.verification_lookup_failed",
        objectType: "admin_domain",
        objectId: domain.id,
        metadata: { domain: domain.domain },
      });
      request.log.warn({ error, domainId: domain.id }, "Authoritative DNS lookup failed");
      return reply.code(503).send(invalidRequest("Authoritative DNS lookup failed."));
    }
    const verification = evaluateDnsRecord("TXT", domain.verificationValue, observedValues);
    const updated = await store.recordDomainVerification({
      orgId: actor.orgId,
      id: domain.id,
      verified: verification === "verified",
      actorId: actor.id,
    });
    if (updated === null) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.domain.verification_attempted",
      objectType: "admin_domain",
      objectId: domain.id,
      metadata: { domain: domain.domain, status: updated.status },
    });
    return { domain: updated };
  });

  app.post("/api/admin/domains/:id/challenge", async (request, reply) => {
    const actor = await actorFromRequest(request);
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    if (
      !canWriteAdminConsole(actor, "admin.domains", {
        type: "domain",
        id: params.data.id,
        orgId: actor.orgId,
      })
    ) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const existing = await store.getDomain(actor.orgId, params.data.id);
    if (existing === null) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    if (existing.status === "verified" || existing.status === "released") {
      return reply
        .code(409)
        .send(conflict("Verified or released domains cannot rotate a challenge."));
    }
    const domain = await store.rotateDomainChallenge({
      orgId: actor.orgId,
      id: existing.id,
      verificationValue: `helix-domain-verification=${challengeToken()}`,
      verificationExpiresAt: new Date(now().getTime() + challengeTtlMs).toISOString(),
    });
    if (domain === null) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.domain.challenge_rotated",
      objectType: "admin_domain",
      objectId: domain.id,
      metadata: { domain: domain.domain, expiresAt: domain.verificationExpiresAt },
    });
    return { domain };
  });

  app.post("/api/admin/domains/:id/primary", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor, "admin.domains")) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    const existing = await store.getDomain(actor.orgId, params.data.id);
    if (existing === null) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    if (existing.status !== "verified") {
      return reply.code(409).send(conflict("Only a verified domain can be primary."));
    }
    let domain: DomainRecord | null;
    try {
      domain = await store.setPrimaryDomain(actor.orgId, params.data.id, actor.id);
    } catch (error) {
      if (error instanceof DomainsConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
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

  app.delete("/api/admin/domains/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    if (
      !canWriteAdminConsole(actor, "admin.domains", {
        type: "domain",
        id: params.data.id,
        orgId: actor.orgId,
      })
    ) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const existing = await store.getDomain(actor.orgId, params.data.id);
    if (existing?.isPrimary === true) {
      return reply
        .code(409)
        .send(conflict("Choose another primary domain before releasing this one."));
    }
    let released: DomainRecord | null;
    try {
      released = await store.releaseDomain(actor.orgId, params.data.id);
    } catch (error) {
      if (error instanceof DomainsConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    if (released === null) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.domain.released",
      objectType: "admin_domain",
      objectId: params.data.id,
    });
    return { status: "released", domain: released };
  });

  app.patch("/api/admin/domains/:id/capabilities", async (request, reply) => {
    const actor = await actorFromRequest(request);
    const params = idParams.safeParse(request.params);
    const body = updateCapabilitiesBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(invalidRequest("Invalid domain capabilities."));
    }
    if (
      !canWriteAdminConsole(actor, "admin.domains", {
        type: "domain",
        id: params.data.id,
        orgId: actor.orgId,
      }) ||
      (body.data.aliasTargetDomainId !== undefined &&
        body.data.aliasTargetDomainId !== null &&
        !canWriteAdminConsole(actor, "admin.domains", {
          type: "domain",
          id: body.data.aliasTargetDomainId,
          orgId: actor.orgId,
        }))
    ) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const current = await store.getDomain(actor.orgId, params.data.id);
    if (current === null) return reply.code(404).send(notFound("Domain not found."));
    let domain: DomainRecord | null;
    try {
      domain = await store.setDomainCapabilities({
        orgId: actor.orgId,
        id: current.id,
        actorId: actor.id,
        identityEnabled: body.data.identityEnabled ?? current.identityEnabled,
        mailEnabled: body.data.mailEnabled ?? current.mailEnabled,
        aliasesEnabled: body.data.aliasesEnabled ?? current.aliasesEnabled,
        customHostEnabled: body.data.customHostEnabled ?? current.customHostEnabled,
        federationEnabled: body.data.federationEnabled ?? current.federationEnabled,
        providerId: body.data.providerId === undefined ? current.providerId : body.data.providerId,
        identityMode: body.data.identityMode ?? current.identityMode,
        aliasTargetDomainId:
          body.data.aliasTargetDomainId === undefined
            ? current.aliasTargetDomainId
            : body.data.aliasTargetDomainId,
      });
    } catch (error) {
      if (error instanceof DomainsConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    if (domain === null) return reply.code(404).send(notFound("Domain not found."));
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.domain.capabilities_updated",
      objectType: "admin_domain",
      objectId: domain.id,
      metadata: { domain: domain.domain },
    });
    return { domain };
  });

  app.post("/api/admin/domains/:id/quarantine", async (request, reply) => {
    const actor = await actorFromRequest(request);
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(invalidRequest("Invalid domain id."));
    if (
      !canWriteAdminConsole(actor, "admin.domains", {
        type: "domain",
        id: params.data.id,
        orgId: actor.orgId,
      })
    ) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const domain = await store.quarantineDomain(actor.orgId, params.data.id, actor.id);
    if (domain === null) return reply.code(404).send(notFound("Domain not found."));
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.domain.quarantined",
      objectType: "admin_domain",
      objectId: domain.id,
      metadata: { domain: domain.domain },
    });
    return { domain };
  });

  app.get("/api/admin/domains/primary-transitions", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor, "admin.domains"))
      return sendForbidden(reply, adminConsoleReadScope);
    return { transitions: await store.listPrimaryTransitions(actor.orgId) };
  });

  app.post("/api/admin/domains/primary-transitions/:id/rollback", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor, "admin.domains"))
      return sendForbidden(reply, adminConsoleWriteScope);
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(invalidRequest("Invalid transition id."));
    let domain: DomainRecord | null;
    try {
      domain = await store.rollbackPrimaryDomain(actor.orgId, params.data.id, actor.id);
    } catch (error) {
      if (error instanceof DomainsConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    if (domain === null) return reply.code(404).send(notFound("Transition not found."));
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.domain.primary_rolled_back",
      objectType: "admin_domain",
      objectId: domain.id,
    });
    return { domain };
  });

  app.get("/api/admin/domains/:id/dns", async (request, reply) => {
    const actor = await actorFromRequest(request);
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    if (
      !canReadAdminConsole(actor, "admin.domains", {
        type: "domain",
        id: params.data.id,
        orgId: actor.orgId,
      })
    ) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const domain = await store.getDomain(actor.orgId, params.data.id);
    if (domain === null) {
      return reply.code(404).send(notFound("Domain not found."));
    }
    return { dnsRecords: await store.listDnsRecords(actor.orgId, params.data.id) };
  });

  app.put("/api/admin/domains/:id/dns", async (request, reply) => {
    const actor = await actorFromRequest(request);
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    if (
      !canWriteAdminConsole(actor, "admin.domains", {
        type: "domain",
        id: params.data.id,
        orgId: actor.orgId,
      })
    ) {
      return sendForbidden(reply, adminConsoleWriteScope);
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
    const params = dnsRecordParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid DNS record identifiers."));
    }
    if (
      !canWriteAdminConsole(actor, "admin.domains", {
        type: "domain",
        id: params.data.id,
        orgId: actor.orgId,
      })
    ) {
      return sendForbidden(reply, adminConsoleWriteScope);
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
    let observedValues: readonly string[];
    try {
      observedValues = await dnsResolver.lookup({
        recordType: target.recordType,
        host: target.host,
      });
    } catch (error) {
      request.log.warn({ error, recordId: target.id }, "Authoritative DNS lookup failed");
      return reply.code(503).send(invalidRequest("Authoritative DNS lookup failed."));
    }
    const status = evaluateDnsRecord(target.recordType, target.expectedValue, observedValues);
    const observedValue = observedValues.length === 0 ? null : observedValues.join("\n");
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
  readonly status: DomainStatus;
  readonly verified_at: Date | null;
  readonly identity_enabled: boolean;
  readonly mail_enabled: boolean;
  readonly aliases_enabled: boolean;
  readonly custom_host_enabled: boolean;
  readonly federation_enabled: boolean;
  readonly provider_id: string | null;
  readonly identity_mode: DomainIdentityMode;
  readonly alias_target_domain_id: string | null;
  readonly verification_host: string;
  readonly verification_value: string;
  readonly verification_expires_at: Date;
  readonly verification_attempts: number;
  readonly verification_last_attempt_at: Date | null;
  readonly quarantined_at: Date | null;
  readonly released_at: Date | null;
  readonly claimable_after: Date | null;
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

interface PrimaryTransitionRow {
  readonly id: string;
  readonly org_id: string;
  readonly from_domain_id: string | null;
  readonly to_domain_id: string | null;
  readonly changed_by: string | null;
  readonly changed_at: Date;
  readonly rollback_until: Date;
  readonly rolled_back_at: Date | null;
  readonly rolled_back_by: string | null;
}

export class PostgresDomainsStore implements DomainsStore {
  constructor(private readonly sql: postgres.Sql) {}

  async listDomains(orgId: string): Promise<readonly DomainRecord[]> {
    const rows = await this.sql<DomainRow[]>`
      select * from admin_domains
      where org_id = ${orgId} and status <> 'released'
      order by is_primary desc, domain asc
    `;
    return rows.map(mapDomainRow);
  }

  async getDomain(orgId: string, id: string): Promise<DomainRecord | null> {
    const rows = await this.sql<DomainRow[]>`
      select * from admin_domains
      where org_id = ${orgId} and id = ${id}
    `;
    const row = rows[0];
    return row === undefined ? null : mapDomainRow(row);
  }

  async findVerifiedDomain(domain: string): Promise<DomainRecord | null> {
    const rows = await this.sql<DomainRow[]>`
      select * from helix_verified_tenant_domain(${domain})
    `;
    const row = rows[0];
    return row === undefined ? null : mapDomainRow(row);
  }

  async createDomain(input: CreateDomainInput): Promise<DomainRecord> {
    let rows: readonly DomainRow[];
    try {
      rows = await this.sql<DomainRow[]>`
        insert into admin_domains (
          org_id, domain, created_by, verification_host,
          verification_value, verification_expires_at
        )
        values (
          ${input.orgId}, ${input.domain}, ${input.createdBy},
          ${input.verificationHost}, ${input.verificationValue}, ${input.verificationExpiresAt}
        )
        on conflict do nothing
        returning *
      `;
    } catch (error) {
      throw domainConflictError(error);
    }
    const row = rows[0];
    if (row === undefined) {
      throw new DomainsConflictError("This domain is already claimed by a workspace.");
    }
    return mapDomainRow(row);
  }

  async rotateDomainChallenge(input: RotateDomainChallengeInput): Promise<DomainRecord | null> {
    const rows = await this.sql<DomainRow[]>`
      update admin_domains
      set verification_value = ${input.verificationValue},
          verification_expires_at = ${input.verificationExpiresAt},
          verification_attempts = 0, verification_last_attempt_at = null,
          status = 'pending', verified_at = null, quarantined_at = null,
          released_at = null, claimable_after = null, is_primary = false,
          identity_enabled = false, mail_enabled = false, aliases_enabled = false,
          custom_host_enabled = false, federation_enabled = false, provider_id = null,
          updated_at = now()
      where org_id = ${input.orgId} and id = ${input.id}
        and status in ('pending', 'quarantined')
      returning *
    `;
    return rows[0] === undefined ? null : mapDomainRow(rows[0]);
  }

  async recordDomainVerification(
    input: RecordDomainVerificationInput,
  ): Promise<DomainRecord | null> {
    const rows = await this.sql<DomainRow[]>`
      select (helix_record_domain_verification(
        ${input.orgId}, ${input.id}, ${input.verified}, ${input.actorId}
      )).*
    `;
    return rows[0] === undefined ? null : mapDomainRow(rows[0]);
  }

  async setDomainCapabilities(input: SetDomainCapabilitiesInput): Promise<DomainRecord | null> {
    return this.domainMutation(this.sql`
      select (helix_set_domain_capabilities(
        ${input.orgId}, ${input.id}, ${input.identityEnabled}, ${input.mailEnabled},
        ${input.aliasesEnabled}, ${input.customHostEnabled}, ${input.federationEnabled},
        ${input.providerId}, ${input.identityMode}, ${input.aliasTargetDomainId}, ${input.actorId}
      )).*
    `);
  }

  async setPrimaryDomain(orgId: string, id: string, actorId: string): Promise<DomainRecord | null> {
    return this.domainMutation(
      this.sql`select (helix_set_primary_domain(${orgId}, ${id}, ${actorId})).*`,
    );
  }

  async listPrimaryTransitions(orgId: string): Promise<readonly DomainPrimaryTransitionRecord[]> {
    const rows = await this.sql<PrimaryTransitionRow[]>`
      select * from admin_domain_primary_transitions
      where org_id = ${orgId}
      order by changed_at desc, id desc
    `;
    return rows.map(mapPrimaryTransitionRow);
  }

  async rollbackPrimaryDomain(
    orgId: string,
    transitionId: string,
    actorId: string,
  ): Promise<DomainRecord | null> {
    return this.domainMutation(
      this.sql`select (helix_rollback_primary_domain(${orgId}, ${transitionId}, ${actorId})).*`,
    );
  }

  async quarantineDomain(orgId: string, id: string, actorId: string): Promise<DomainRecord | null> {
    return this.domainMutation(
      this.sql`select (helix_quarantine_domain(${orgId}, ${id}, ${actorId})).*`,
    );
  }

  async releaseDomain(orgId: string, id: string): Promise<DomainRecord | null> {
    return this.domainMutation(this.sql`select (helix_release_domain(${orgId}, ${id})).*`);
  }

  private async domainMutation(query: PromiseLike<unknown>): Promise<DomainRecord | null> {
    try {
      const rows = (await query) as readonly (DomainRow | { readonly id: null })[];
      const row = rows[0];
      return row === undefined || row.id === null ? null : mapDomainRow(row);
    } catch (error) {
      throw domainConflictError(error);
    }
  }

  async listDnsRecords(orgId: string, domainId: string): Promise<readonly DnsRecordRecord[]> {
    const rows = await this.sql<DnsRecordRow[]>`
      select id, org_id, domain_id, record_type, host, expected_value, observed_value,
             status, last_checked_at, created_at, updated_at
      from admin_dns_records
      where org_id = ${orgId} and domain_id = ${domainId}
      order by record_type asc, host asc
    `;
    return rows.map(mapDnsRecordRow);
  }

  async upsertDnsRecord(input: UpsertDnsRecordInput): Promise<DnsRecordRecord> {
    const existing = await this.sql<{ readonly id: string }[]>`
      select id from admin_dns_records
      where org_id = ${input.orgId} and domain_id = ${input.domainId}
        and record_type = ${input.recordType} and host = ${input.host}
    `;
    const existingId = existing[0]?.id ?? null;
    if (existingId !== null) {
      const rows = await this.sql<DnsRecordRow[]>`
        update admin_dns_records
        set expected_value = ${input.expectedValue}, status = 'pending',
            observed_value = null, updated_at = now()
        where org_id = ${input.orgId} and id = ${existingId}
        returning id, org_id, domain_id, record_type, host, expected_value,
                  observed_value, status, last_checked_at, created_at, updated_at
      `;
      const row = rows[0];
      if (row === undefined) {
        throw new Error("Failed to update DNS record.");
      }
      return mapDnsRecordRow(row);
    }
    const rows = await this.sql<DnsRecordRow[]>`
      insert into admin_dns_records
        (org_id, domain_id, record_type, host, expected_value, status)
      values
        (${input.orgId}, ${input.domainId}, ${input.recordType}, ${input.host},
         ${input.expectedValue}, 'pending')
      returning id, org_id, domain_id, record_type, host, expected_value,
                observed_value, status, last_checked_at, created_at, updated_at
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Failed to insert DNS record.");
    }
    return mapDnsRecordRow(row);
  }

  async setDnsRecordVerification(
    input: SetDnsRecordVerificationInput,
  ): Promise<DnsRecordRecord | null> {
    const rows = await this.sql<DnsRecordRow[]>`
      update admin_dns_records
      set status = ${input.status}, observed_value = ${input.observedValue},
          last_checked_at = now(), updated_at = now()
      where org_id = ${input.orgId} and id = ${input.id}
      returning id, org_id, domain_id, record_type, host, expected_value,
                observed_value, status, last_checked_at, created_at, updated_at
    `;
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
    status: row.status,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    identityEnabled: row.identity_enabled,
    mailEnabled: row.mail_enabled,
    aliasesEnabled: row.aliases_enabled,
    customHostEnabled: row.custom_host_enabled,
    federationEnabled: row.federation_enabled,
    providerId: row.provider_id,
    identityMode: row.identity_mode,
    aliasTargetDomainId: row.alias_target_domain_id,
    verificationHost: row.verification_host,
    verificationValue: row.verification_value,
    verificationExpiresAt: row.verification_expires_at.toISOString(),
    verificationAttempts: row.verification_attempts,
    verificationLastAttemptAt: row.verification_last_attempt_at?.toISOString() ?? null,
    quarantinedAt: row.quarantined_at?.toISOString() ?? null,
    releasedAt: row.released_at?.toISOString() ?? null,
    claimableAfter: row.claimable_after?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapPrimaryTransitionRow(row: PrimaryTransitionRow): DomainPrimaryTransitionRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    fromDomainId: row.from_domain_id,
    toDomainId: row.to_domain_id,
    changedBy: row.changed_by,
    changedAt: row.changed_at.toISOString(),
    rollbackUntil: row.rollback_until.toISOString(),
    rolledBackAt: row.rolled_back_at?.toISOString() ?? null,
    rolledBackBy: row.rolled_back_by,
  };
}

function domainConflictError(error: unknown): DomainsConflictError {
  const message = error instanceof Error ? error.message : String(error);
  const labels: Readonly<Record<string, string>> = {
    domain_acquisition_cooldown: "This domain is still reserved to its previous workspace.",
    domain_primary_ineligible: "Only a verified secondary identity domain can be primary.",
    domain_primary_cooldown: "Wait one hour between primary-domain changes or use rollback.",
    domain_primary_dependency: "The target domain does not satisfy current workspace dependencies.",
    domain_primary_rollback_unavailable: "This primary-domain change can no longer be rolled back.",
    domain_primary_rollback_stale: "A newer primary-domain change superseded this rollback.",
    domain_primary_rollback_ineligible: "The previous primary is no longer eligible.",
    domain_release_primary: "Choose another primary domain before releasing this one.",
    domain_release_has_dependencies:
      "Move users, aliases, groups, or domain aliases before release.",
    domain_capabilities_require_verification: "Verify the domain before enabling capabilities.",
    domain_capability_combination_invalid: "The requested domain capabilities cannot be combined.",
    domain_identity_has_dependencies: "Move member identities before disabling this namespace.",
    domain_alias_target_has_dependencies: "Move domain aliases before disabling this namespace.",
    domain_address_has_dependencies:
      "Move aliases and group addresses before disabling mail aliases.",
    domain_federation_has_dependencies: "Keep one federation-capable domain while SSO is enabled.",
  };
  const label = Object.entries(labels).find(([key]) => message.includes(key))?.[1];
  return new DomainsConflictError(label ?? "The domain change conflicts with its current state.");
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
  isPrimary: boolean;
  status: DomainStatus;
  verifiedAt: string | null;
  identityEnabled: boolean;
  mailEnabled: boolean;
  aliasesEnabled: boolean;
  customHostEnabled: boolean;
  federationEnabled: boolean;
  providerId: string | null;
  identityMode: DomainIdentityMode;
  aliasTargetDomainId: string | null;
  verificationHost: string;
  verificationValue: string;
  verificationExpiresAt: string;
  verificationAttempts: number;
  verificationLastAttemptAt: string | null;
  quarantinedAt: string | null;
  releasedAt: string | null;
  claimableAfter: string | null;
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

function disabledDomainState(status: "pending" | "quarantined" | "released", at: string) {
  return {
    status,
    ...(status === "quarantined" ? {} : { verifiedAt: null }),
    isPrimary: false,
    identityEnabled: false,
    mailEnabled: false,
    aliasesEnabled: false,
    customHostEnabled: false,
    federationEnabled: false,
    providerId: null,
    quarantinedAt: status === "quarantined" ? at : null,
    releasedAt: status === "released" ? at : null,
    updatedAt: at,
  } as const;
}

/** Deterministic in-memory {@link DomainsStore}. */
export class InMemoryDomainsStore implements DomainsStore {
  readonly #domains = new Map<string, MemDomain>();
  readonly #dnsRecords = new Map<string, MemDnsRecord>();
  readonly #transitions = new Map<string, DomainPrimaryTransitionRecord>();
  #seq = 0;

  constructor(private readonly options: { readonly now?: () => Date } = {}) {}

  #now(): string {
    return (this.options.now ?? (() => new Date("2026-05-21T00:00:00.000Z")))().toISOString();
  }

  #id(): string {
    this.#seq += 1;
    return `00000000-0000-4000-b000-${this.#seq.toString(16).padStart(12, "0")}`;
  }

  async listDomains(orgId: string): Promise<readonly DomainRecord[]> {
    return [...this.#domains.values()]
      .filter((domain) => domain.orgId === orgId && domain.status !== "released")
      .map((domain) => ({ ...domain }))
      .sort((a, b) =>
        a.isPrimary === b.isPrimary ? a.domain.localeCompare(b.domain) : a.isPrimary ? -1 : 1,
      );
  }

  async getDomain(orgId: string, id: string): Promise<DomainRecord | null> {
    const domain = this.#domains.get(id);
    return domain === undefined || domain.orgId !== orgId ? null : { ...domain };
  }

  async findVerifiedDomain(domain: string): Promise<DomainRecord | null> {
    const found = [...this.#domains.values()].find(
      (candidate) =>
        candidate.domain === domain &&
        candidate.status === "verified" &&
        candidate.customHostEnabled,
    );
    return found === undefined ? null : { ...found };
  }

  async createDomain(input: CreateDomainInput): Promise<DomainRecord> {
    const domains = [...this.#domains.values()];
    const clash = domains.some(
      (domain) =>
        domain.status !== "released" && domain.domain.toLowerCase() === input.domain.toLowerCase(),
    );
    if (clash) {
      throw new DomainsConflictError("This domain is already claimed by a workspace.");
    }
    const now = this.#now();
    if (
      domains.some(
        (domain) =>
          domain.status === "released" &&
          domain.orgId !== input.orgId &&
          domain.domain.toLowerCase() === input.domain.toLowerCase() &&
          domain.claimableAfter !== null &&
          Date.parse(domain.claimableAfter) > Date.parse(now),
      )
    ) {
      throw new DomainsConflictError("This domain is still reserved to its previous workspace.");
    }
    const domain: MemDomain = {
      id: this.#id(),
      orgId: input.orgId,
      domain: input.domain,
      isPrimary: false,
      status: "pending",
      verifiedAt: null,
      identityEnabled: false,
      mailEnabled: false,
      aliasesEnabled: false,
      customHostEnabled: false,
      federationEnabled: false,
      providerId: null,
      identityMode: "secondary",
      aliasTargetDomainId: null,
      verificationHost: input.verificationHost,
      verificationValue: input.verificationValue,
      verificationExpiresAt: input.verificationExpiresAt,
      verificationAttempts: 0,
      verificationLastAttemptAt: null,
      quarantinedAt: null,
      releasedAt: null,
      claimableAfter: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#domains.set(domain.id, domain);
    return { ...domain };
  }

  async rotateDomainChallenge(input: RotateDomainChallengeInput): Promise<DomainRecord | null> {
    const domain = this.#domains.get(input.id);
    if (domain === undefined || domain.orgId !== input.orgId || domain.status === "released") {
      return null;
    }
    Object.assign(domain, {
      verificationValue: input.verificationValue,
      verificationExpiresAt: input.verificationExpiresAt,
      verificationAttempts: 0,
      verificationLastAttemptAt: null,
      status: "pending" as const,
      verifiedAt: null,
      isPrimary: false,
      identityEnabled: false,
      mailEnabled: false,
      aliasesEnabled: false,
      customHostEnabled: false,
      federationEnabled: false,
      providerId: null,
      quarantinedAt: null,
      releasedAt: null,
      claimableAfter: null,
      updatedAt: this.#now(),
    });
    return { ...domain };
  }

  async recordDomainVerification(
    input: RecordDomainVerificationInput,
  ): Promise<DomainRecord | null> {
    const domain = this.#domains.get(input.id);
    if (domain === undefined || domain.orgId !== input.orgId || domain.status === "released") {
      return null;
    }
    const timestamp = this.#now();
    if (input.verified) {
      if (domain.status !== "verified") {
        Object.assign(domain, {
          isPrimary: false,
          identityEnabled: false,
          mailEnabled: false,
          aliasesEnabled: false,
          customHostEnabled: false,
          federationEnabled: false,
          providerId: null,
          identityMode: "secondary" as const,
          aliasTargetDomainId: null,
        });
      }
      Object.assign(domain, {
        status: "verified" as const,
        verifiedAt: timestamp,
        quarantinedAt: null,
        releasedAt: null,
        claimableAfter: null,
      });
    } else if (domain.status === "verified") {
      const wasPrimary = domain.isPrimary;
      Object.assign(domain, disabledDomainState("quarantined", timestamp));
      if (wasPrimary) {
        const replacement = this.#eligibleDomains(input.orgId).find(
          (candidate) => candidate.id !== domain.id,
        );
        if (replacement !== undefined) replacement.isPrimary = true;
        this.#recordTransition(input.orgId, domain.id, replacement?.id ?? null, input.actorId, 0);
      }
    } else {
      Object.assign(domain, disabledDomainState("pending", timestamp));
    }
    domain.verificationAttempts += 1;
    domain.verificationLastAttemptAt = timestamp;
    domain.updatedAt = timestamp;
    return { ...domain };
  }

  async setDomainCapabilities(input: SetDomainCapabilitiesInput): Promise<DomainRecord | null> {
    const domain = this.#domains.get(input.id);
    if (domain === undefined || domain.orgId !== input.orgId) return null;
    if (domain.status !== "verified") {
      throw new DomainsConflictError("Verify the domain before enabling capabilities.");
    }
    if (domain.isPrimary && (!input.identityEnabled || input.identityMode !== "secondary")) {
      throw new DomainsConflictError("The primary must remain a secondary identity namespace.");
    }
    if (
      (input.identityMode === "secondary" && input.aliasTargetDomainId !== null) ||
      (input.customHostEnabled && !input.identityEnabled) ||
      (input.federationEnabled && !input.identityEnabled) ||
      (input.aliasesEnabled && !input.identityEnabled && !input.mailEnabled) ||
      (input.providerId !== null && !input.mailEnabled)
    ) {
      throw new DomainsConflictError("Domain capability combination is invalid.");
    }
    if (input.identityMode === "alias") {
      const target =
        input.aliasTargetDomainId === null
          ? undefined
          : this.#domains.get(input.aliasTargetDomainId);
      if (
        target === undefined ||
        target.orgId !== input.orgId ||
        target.status !== "verified" ||
        !target.identityEnabled ||
        target.identityMode !== "secondary" ||
        !input.aliasesEnabled
      ) {
        throw new DomainsConflictError("Alias target must be a verified identity domain.");
      }
    }
    const becomesPrimary =
      input.identityEnabled &&
      input.identityMode === "secondary" &&
      !domain.isPrimary &&
      ![...this.#domains.values()].some(
        (candidate) => candidate.orgId === input.orgId && candidate.isPrimary,
      );
    Object.assign(domain, {
      identityEnabled: input.identityEnabled,
      mailEnabled: input.mailEnabled,
      aliasesEnabled: input.aliasesEnabled,
      customHostEnabled: input.customHostEnabled,
      federationEnabled: input.federationEnabled,
      providerId: input.providerId,
      identityMode: input.identityMode,
      aliasTargetDomainId: input.aliasTargetDomainId,
      isPrimary: domain.isPrimary || becomesPrimary,
      updatedAt: this.#now(),
    });
    if (becomesPrimary) this.#recordTransition(input.orgId, null, domain.id, input.actorId);
    return { ...domain };
  }

  async setPrimaryDomain(orgId: string, id: string, actorId: string): Promise<DomainRecord | null> {
    const domain = this.#domains.get(id);
    if (domain === undefined || domain.orgId !== orgId) {
      return null;
    }
    if (
      domain.status !== "verified" ||
      !domain.identityEnabled ||
      domain.identityMode !== "secondary"
    ) {
      throw new DomainsConflictError("Only a verified secondary identity domain can be primary.");
    }
    const previous = [...this.#domains.values()].find(
      (candidate) => candidate.orgId === orgId && candidate.isPrimary,
    );
    if (previous?.id === id) return { ...domain };
    const latest = [...this.#transitions.values()]
      .filter((transition) => transition.orgId === orgId && transition.fromDomainId !== null)
      .sort((left, right) => right.changedAt.localeCompare(left.changedAt))[0];
    if (
      latest !== undefined &&
      Date.parse(this.#now()) - Date.parse(latest.changedAt) < 3_600_000
    ) {
      throw new DomainsConflictError(
        "Wait one hour between primary-domain changes or use rollback.",
      );
    }
    if (
      previous !== undefined &&
      ((previous.mailEnabled && !domain.mailEnabled) ||
        (previous.aliasesEnabled && !domain.aliasesEnabled) ||
        (previous.customHostEnabled && !domain.customHostEnabled) ||
        (previous.federationEnabled && !domain.federationEnabled))
    ) {
      throw new DomainsConflictError("The target domain does not satisfy current dependencies.");
    }
    for (const other of this.#domains.values()) {
      if (other.orgId === orgId) {
        other.isPrimary = other.id === id;
        other.updatedAt = this.#now();
      }
    }
    this.#recordTransition(orgId, previous?.id ?? null, id, actorId);
    return { ...domain };
  }

  async listPrimaryTransitions(orgId: string): Promise<readonly DomainPrimaryTransitionRecord[]> {
    return [...this.#transitions.values()]
      .filter((transition) => transition.orgId === orgId)
      .sort((left, right) => right.changedAt.localeCompare(left.changedAt));
  }

  async rollbackPrimaryDomain(
    orgId: string,
    transitionId: string,
    actorId: string,
  ): Promise<DomainRecord | null> {
    const transition = this.#transitions.get(transitionId);
    if (
      transition === undefined ||
      transition.orgId !== orgId ||
      transition.fromDomainId === null ||
      transition.rolledBackAt !== null ||
      Date.parse(transition.rollbackUntil) <= Date.parse(this.#now())
    ) {
      throw new DomainsConflictError("This primary-domain change can no longer be rolled back.");
    }
    const current =
      transition.toDomainId === null ? undefined : this.#domains.get(transition.toDomainId);
    const previous = this.#domains.get(transition.fromDomainId);
    if (
      current?.isPrimary !== true ||
      previous?.status !== "verified" ||
      !previous.identityEnabled
    ) {
      throw new DomainsConflictError("This primary-domain rollback is stale or ineligible.");
    }
    current.isPrimary = false;
    previous.isPrimary = true;
    this.#transitions.set(transition.id, {
      ...transition,
      rolledBackAt: this.#now(),
      rolledBackBy: actorId,
    });
    return { ...previous };
  }

  async quarantineDomain(orgId: string, id: string, actorId: string): Promise<DomainRecord | null> {
    const domain = this.#domains.get(id);
    if (domain === undefined || domain.orgId !== orgId || domain.status === "released") return null;
    const wasPrimary = domain.isPrimary;
    Object.assign(domain, disabledDomainState("quarantined", this.#now()));
    if (wasPrimary) {
      const replacement = this.#eligibleDomains(orgId).find((candidate) => candidate.id !== id);
      if (replacement !== undefined) replacement.isPrimary = true;
      this.#recordTransition(orgId, id, replacement?.id ?? null, actorId, 0);
    }
    return { ...domain };
  }

  async releaseDomain(orgId: string, id: string): Promise<DomainRecord | null> {
    const domain = this.#domains.get(id);
    if (domain === undefined || domain.orgId !== orgId) return null;
    if (domain.status === "released") return { ...domain };
    if (domain.isPrimary) throw new DomainsConflictError("Choose another primary domain first.");
    Object.assign(domain, disabledDomainState("released", this.#now()));
    domain.claimableAfter = new Date(Date.parse(this.#now()) + 7 * 86_400_000).toISOString();
    return { ...domain };
  }

  #eligibleDomains(orgId: string): MemDomain[] {
    return [...this.#domains.values()].filter(
      (domain) =>
        domain.orgId === orgId &&
        domain.status === "verified" &&
        domain.identityEnabled &&
        domain.identityMode === "secondary",
    );
  }

  #recordTransition(
    orgId: string,
    fromDomainId: string | null,
    toDomainId: string | null,
    actorId: string,
    rollbackHours = 24,
  ): void {
    const changedAt = this.#now();
    const transition: DomainPrimaryTransitionRecord = {
      id: this.#id(),
      orgId,
      fromDomainId,
      toDomainId,
      changedBy: actorId,
      changedAt,
      rollbackUntil: new Date(Date.parse(changedAt) + rollbackHours * 3_600_000).toISOString(),
      rolledBackAt: null,
      rolledBackBy: null,
    };
    this.#transitions.set(transition.id, transition);
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

export async function readDomainsWithRecords(
  store: DomainsStore,
  orgId: string,
): Promise<readonly DomainWithRecords[]> {
  const domains = await store.listDomains(orgId);
  return Promise.all(
    domains.map(async (domain) => ({
      domain,
      dnsRecords: await store.listDnsRecords(orgId, domain.id),
    })),
  );
}
