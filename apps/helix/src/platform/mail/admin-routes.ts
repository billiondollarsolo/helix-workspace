import type { Actor, JsonObject } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod3";
import {
  OUTBOUND_MAIL_SECRET_REFERENCES,
  WEBHOOK_MAIL_SECRET_REFERENCES,
} from "./secret-policy.js";
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
} from "../admin/console-shared.js";
import {
  MailAdminConflictError,
  type MailDkimKeyRecord,
  type MailDkimKeyStore,
  type MailDmarcReportRecord,
  type MailDmarcReportStore,
  type MailRoutingRuleStore,
  type OutboundProviderStore,
  type SendingDomainStore,
} from "./admin-store.js";
import { OUTBOUND_MAIL_PROVIDER_KINDS, type OutboundProviderConfig } from "./providers.js";
import { parseDmarcAggregateReport, DmarcReportParseError } from "./dmarc.js";
import { getSpamdScannerConfig } from "./spam.js";
import { getMailSpamAiConfig } from "./spam-ai.js";

/**
 * Mail delivery admin routes.
 *
 * Org admins manage the outbound delivery provider, sending domains, DKIM
 * signing keys, DMARC deliverability reports, and inbound routing rules. Every
 * route is scope-gated through the shared admin-console helpers
 * (`admin.console.read` / `admin.console.write`, with `admin.*` and the
 * `mail.admin` scope honoured) and every mutation is audited.
 *
 * Secrets (provider API keys, SMTP passwords) are referenced by an env-var
 * name (`secretRef`) and are never accepted or returned inline.
 */

const mailAdminScope = "mail.admin";

/** Mail-admin read access — admin-console read, `admin.*`, or `mail.admin`. */
function canReadMailDeliveryAdmin(actor: Actor): boolean {
  return canReadAdminConsole(actor) || (actor.scopes ?? []).includes(mailAdminScope);
}

/** Mail-admin write access — admin-console write, `admin.*`, or `mail.admin`. */
function canWriteMailDeliveryAdmin(actor: Actor): boolean {
  return canWriteAdminConsole(actor) || (actor.scopes ?? []).includes(mailAdminScope);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const idParams = z.object({ id: z.string().uuid() });
const domainKeyParams = z.object({ id: z.string().uuid(), keyId: z.string().uuid() });

const providerKindSchema = z.enum(OUTBOUND_MAIL_PROVIDER_KINDS);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const outboundSecretRefSchema = z.enum(OUTBOUND_MAIL_SECRET_REFERENCES).nullable();
const webhookSecretRefSchema = z.enum(WEBHOOK_MAIL_SECRET_REFERENCES).nullable();

const createProviderBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: providerKindSchema,
    enabled: z.boolean().default(true),
    isDefault: z.boolean().default(false),
    config: jsonObjectSchema.default({}),
    secretRef: outboundSecretRefSchema.default(null),
    webhookSecretRef: webhookSecretRefSchema.default(null),
  })
  .strict();

const updateProviderBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    config: jsonObjectSchema.optional(),
    secretRef: outboundSecretRefSchema.optional(),
    webhookSecretRef: webhookSecretRefSchema.optional(),
  })
  .strict();

const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/iu, "Domain must contain only letters, digits, dots, and hyphens.");

const createSendingDomainBody = z
  .object({
    domain: domainSchema,
    isDefault: z.boolean().default(false),
    providerId: z.string().uuid().nullable().default(null),
  })
  .strict();

/* `selector` is optional: choosing one requires knowing every selector the
   domain already uses (they are unique per domain forever, retired keys
   included), which from a browser is a list-then-generate pair that races other
   admins and spends two of the tenant's five requests per second. Omitted, the
   server picks the same dated selector rotation uses. The field stays available
   for callers that must publish a specific DNS label. */
const generateDkimBody = z
  .object({
    selector: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9._-]+$/iu, "Selector must be a DNS label.")
      .optional(),
    keyBits: z.union([z.literal(1024), z.literal(2048), z.literal(4096)]).default(2048),
  })
  .strict();

/* Rotation picks its own selector (see the route), so key size is the only knob
   — and the body may be omitted entirely, which is how the console calls it. */
const rotateDkimBody = z
  .object({
    keyBits: z.union([z.literal(1024), z.literal(2048), z.literal(4096)]).default(2048),
  })
  .strict();

const ingestDmarcBody = z
  .object({
    report: z.string().min(1).max(5_000_000),
  })
  .strict();

const dmarcQuery = z.object({
  domain: z.string().trim().min(1).max(253).optional(),
});

const routingActionKindSchema = z.enum(["forward", "alias", "drop", "tag", "mailbox"]);
const routingMatchSchema = z
  .object({
    recipientPattern: z.string().trim().min(1).max(320).optional(),
    senderPattern: z.string().trim().min(1).max(320).optional(),
    subjectContains: z.string().trim().min(1).max(998).optional(),
    headerName: z.string().trim().min(1).max(128).optional(),
    headerContains: z.string().trim().min(1).max(998).optional(),
  })
  .strict();
const routingActionSchema = z
  .object({
    forwardTo: z.string().email().optional(),
    aliasActorId: z.string().uuid().optional(),
    tag: z.string().trim().min(1).max(128).optional(),
    mailbox: z.string().trim().min(1).max(320).optional(),
    stopProcessing: z.boolean().optional(),
  })
  .strict();

const createRoutingRuleBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    isEnabled: z.boolean().default(true),
    priority: z.number().int().min(0).max(100_000).default(100),
    match: routingMatchSchema.default({}),
    actionKind: routingActionKindSchema,
    action: routingActionSchema.default({}),
  })
  .strict()
  .refine((value) => routingActionIsConsistent(value.actionKind, value.action), {
    message: "Routing action payload does not match the action kind.",
    path: ["action"],
  });

const updateRoutingRuleBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    isEnabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(100_000).optional(),
    match: routingMatchSchema.optional(),
    actionKind: routingActionKindSchema.optional(),
    action: routingActionSchema.optional(),
  })
  .strict();

/** Strip `undefined`-valued keys so a zod object satisfies the `JsonObject` index. */
function compactJson(value: Record<string, unknown>): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as JsonObject;
}

/** A `forward` action requires `forwardTo`, an `alias` action requires `aliasActorId`, etc. */
function routingActionIsConsistent(
  kind: z.infer<typeof routingActionKindSchema>,
  action: z.infer<typeof routingActionSchema>,
): boolean {
  switch (kind) {
    case "forward":
      return action.forwardTo !== undefined;
    case "alias":
      return action.aliasActorId !== undefined;
    case "tag":
      return action.tag !== undefined;
    case "mailbox":
      return action.mailbox !== undefined;
    case "drop":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Project a provider config for the API — never exposes the secret value. */
function serializeProvider(provider: OutboundProviderConfig): Record<string, unknown> {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    enabled: provider.enabled,
    isDefault: provider.isDefault,
    config: provider.config,
    // Only the env-var *name* is surfaced; the secret value never leaves the host.
    secretRef: provider.secretRef,
    hasSecret: provider.secretRef !== null,
    webhookSecretRef: provider.webhookSecretRef ?? null,
    hasWebhookSecret: provider.webhookSecretRef !== null && provider.webhookSecretRef !== undefined,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

/**
 * Project a DKIM key for the API. The private key is redacted — only its
 * presence is reported. The public key and the DNS record (which the admin
 * must publish) are returned in full.
 */
function serializeDkimKey(key: MailDkimKeyRecord): Record<string, unknown> {
  return {
    id: key.id,
    domainId: key.domainId,
    selector: key.selector,
    status: key.status,
    algorithm: key.algorithm,
    keyBits: key.keyBits,
    publicKeyPem: key.publicKeyPem,
    dnsRecord: key.dnsRecord,
    dnsHost: `${key.selector}._domainkey`,
    privateKeyStored: key.privateKeyPem.length > 0,
    signingMode: "legacy_local_key_not_used",
    usedForOutboundSigning: false,
    rotatedAt: key.rotatedAt,
    retiredAt: key.retiredAt,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  };
}

/**
 * Choose the selector for a server-generated DKIM key (generation and rotation
 * both land here when the caller names none).
 *
 * Dated so an admin reading a DNS zone can tell at a glance which selector is
 * the current one, and suffixed on collision because a selector is unique per
 * domain for as long as the key exists — including keys already retired, whose
 * rows are kept. Returns `null` past the suffix ceiling: a domain minting a
 * hundred keys in one day is a stuck automation, and serving it is worse than
 * refusing.
 */
function nextDkimSelector(taken: readonly string[], now: Date): string | null {
  const base = `helix${now.toISOString().slice(0, 10).replaceAll("-", "")}`;
  if (!taken.includes(base)) {
    return base;
  }
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;
    if (!taken.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Fold DMARC aggregate reports into the deliverability header the console shows
 * above them.
 *
 * Returns `null` when there is nothing to state: with no reports — or reports
 * covering no messages — a pass rate would be a number describing no
 * measurement, and the console renders no header rather than a reassuring 100%.
 *
 * Only the DMARC pass rate is reported. Per-mechanism SPF/DKIM rates live in the
 * per-record rows (`mail_dmarc_report_records`), which no store method
 * aggregates; the report rows this route reads carry pass/fail as evaluated by
 * DMARC alignment and cannot be split back apart.
 */
export function summarizeDmarcReports(reports: readonly MailDmarcReportRecord[]): {
  readonly dmarcPassRate: number;
  readonly messagesEvaluated: number;
  readonly windowDays: number;
  readonly reportCount: number;
} | null {
  let messagesEvaluated = 0;
  let passMessages = 0;
  let windowStart = Number.POSITIVE_INFINITY;
  let windowEnd = Number.NEGATIVE_INFINITY;
  for (const report of reports) {
    messagesEvaluated += report.totalMessages;
    passMessages += report.passMessages;
    /* Each bound is parsed on its own and dropped if it is not a date. Folding
       `Date.parse` straight into the running min/max let one report row with an
       unreadable range turn the aggregate NaN, and the guard below then answered
       `null` for the whole org — discarding a message count and pass rate that
       were perfectly real. */
    const begin = Date.parse(report.dateRangeBegin);
    if (Number.isFinite(begin)) {
      windowStart = Math.min(windowStart, begin);
    }
    const end = Date.parse(report.dateRangeEnd);
    if (Number.isFinite(end)) {
      windowEnd = Math.max(windowEnd, end);
    }
  }
  /* No readable bound anywhere is the one case still worth refusing: the window
     the rates describe would be unstated, and an invented one is a lie. */
  if (messagesEvaluated === 0 || !Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
    return null;
  }
  const dayMs = 86_400_000;
  return {
    dmarcPassRate: passMessages / messagesEvaluated,
    messagesEvaluated,
    // A single report covering part of a day is still a one-day window.
    windowDays: Math.max(1, Math.ceil((windowEnd - windowStart) / dayMs)),
    reportCount: reports.length,
  };
}

/** Project a DMARC aggregate report for the console's per-reporter table. */
function serializeDmarcReport(report: MailDmarcReportRecord): Record<string, unknown> {
  return {
    id: report.id,
    // The "reporter" is the receiving org that sent us the aggregate report.
    reporter: report.orgName,
    reportId: report.reportId,
    domain: report.domain,
    rangeStart: report.dateRangeBegin,
    rangeEnd: report.dateRangeEnd,
    total: report.totalMessages,
    passCount: report.passMessages,
    failCount: report.failMessages,
    policyP: report.policyP,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface RegisterMailDeliveryAdminRoutesOptions {
  readonly providerStore: OutboundProviderStore;
  readonly domainStore: SendingDomainStore;
  readonly dkimStore: MailDkimKeyStore;
  readonly dmarcStore: MailDmarcReportStore;
  readonly routingStore: MailRoutingRuleStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly auditSink?: AdminConsoleAuditSink | undefined;
}

/**
 * Register the mail delivery admin routes:
 *
 *   GET    /api/admin/mail/providers
 *   POST   /api/admin/mail/providers
 *   PATCH  /api/admin/mail/providers/:id
 *   DELETE /api/admin/mail/providers/:id
 *   GET    /api/admin/mail/sending-domains
 *   POST   /api/admin/mail/sending-domains
 *   POST   /api/admin/mail/sending-domains/:id/verify
 *   DELETE /api/admin/mail/sending-domains/:id
 *   GET    /api/admin/mail/sending-domains/:id/dkim
 *   POST   /api/admin/mail/sending-domains/:id/dkim
 *   POST   /api/admin/mail/sending-domains/:id/dkim/rotate
 *   POST   /api/admin/mail/sending-domains/:id/dkim/:keyId/retire
 *   GET    /api/admin/mail/dmarc
 *   GET    /api/admin/mail/dmarc/reports
 *   GET    /api/admin/mail/dmarc/summary
 *   POST   /api/admin/mail/dmarc/reports
 *   GET    /api/admin/mail/routing-rules
 *   POST   /api/admin/mail/routing-rules
 *   PATCH  /api/admin/mail/routing-rules/:id
 *   DELETE /api/admin/mail/routing-rules/:id
 *   GET    /api/admin/mail/spam
 */
export async function registerMailDeliveryAdminRoutes(
  app: FastifyInstance,
  options: RegisterMailDeliveryAdminRoutesOptions,
): Promise<void> {
  const {
    providerStore,
    domainStore,
    dkimStore,
    dmarcStore,
    routingStore,
    actorFromRequest,
    auditSink,
  } = options;

  // ---- Outbound providers -------------------------------------------------

  app.get("/api/admin/mail/providers", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return { providers: (await providerStore.listProviders(actor.orgId)).map(serializeProvider) };
  });

  app.post("/api/admin/mail/providers", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = createProviderBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid provider.", body.error.issues));
    }
    let provider: OutboundProviderConfig;
    try {
      provider = await providerStore.createProvider({
        orgId: actor.orgId,
        name: body.data.name,
        kind: body.data.kind,
        enabled: body.data.enabled,
        isDefault: body.data.isDefault,
        config: compactJson(body.data.config),
        secretRef: body.data.secretRef,
        webhookSecretRef: body.data.webhookSecretRef,
        createdBy: actor.id,
      });
    } catch (error) {
      if (error instanceof MailAdminConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.provider.created",
      objectType: "mail_outbound_provider",
      objectId: provider.id,
      metadata: { name: provider.name, kind: provider.kind, isDefault: provider.isDefault },
    });
    return reply.code(201).send({ provider: serializeProvider(provider) });
  });

  app.patch("/api/admin/mail/providers/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid provider id."));
    }
    const body = updateProviderBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid provider patch.", body.error.issues));
    }
    const provider = await providerStore.updateProvider({
      orgId: actor.orgId,
      id: params.data.id,
      ...(body.data.name === undefined ? {} : { name: body.data.name }),
      ...(body.data.enabled === undefined ? {} : { enabled: body.data.enabled }),
      ...(body.data.isDefault === undefined ? {} : { isDefault: body.data.isDefault }),
      ...(body.data.config === undefined ? {} : { config: compactJson(body.data.config) }),
      ...(body.data.secretRef === undefined ? {} : { secretRef: body.data.secretRef }),
      ...(body.data.webhookSecretRef === undefined
        ? {}
        : { webhookSecretRef: body.data.webhookSecretRef }),
    });
    if (provider === null) {
      return reply.code(404).send(notFound("Provider not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.provider.updated",
      objectType: "mail_outbound_provider",
      objectId: provider.id,
      metadata: { name: provider.name, isDefault: provider.isDefault, enabled: provider.enabled },
    });
    return { provider: serializeProvider(provider) };
  });

  app.delete("/api/admin/mail/providers/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid provider id."));
    }
    const deleted = await providerStore.deleteProvider(actor.orgId, params.data.id);
    if (!deleted) {
      return reply.code(404).send(notFound("Provider not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.provider.deleted",
      objectType: "mail_outbound_provider",
      objectId: params.data.id,
    });
    return { status: "deleted" };
  });

  // ---- Sending domains ----------------------------------------------------

  app.get("/api/admin/mail/sending-domains", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return { domains: await domainStore.listDomainsForConsole(actor.orgId) };
  });

  app.post("/api/admin/mail/sending-domains", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = createSendingDomainBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid sending domain.", body.error.issues));
    }
    if (body.data.providerId !== null) {
      const provider = await providerStore.getProvider(actor.orgId, body.data.providerId);
      if (provider === null) {
        return reply.code(400).send(invalidRequest("Unknown provider for sending domain."));
      }
    }
    let domain;
    try {
      domain = await domainStore.createDomain({
        orgId: actor.orgId,
        domain: body.data.domain.toLowerCase(),
        isDefault: body.data.isDefault,
        providerId: body.data.providerId,
        createdBy: actor.id,
      });
    } catch (error) {
      if (error instanceof MailAdminConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.sending_domain.created",
      objectType: "mail_sending_domain",
      objectId: domain.id,
      metadata: { domain: domain.domain, isDefault: domain.isDefault },
    });
    return reply.code(201).send({ domain });
  });

  /* Re-reads the DNS records observed against this domain's identity. Takes no
     body: it used to accept `{ verified: boolean }` and write that straight to
     `verified_at`, which outbound routing reads when choosing a dedicated
     transport — so the client decided its own verification. */
  app.post("/api/admin/mail/sending-domains/:id/verify", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    const result = await domainStore.refreshDomainVerification(actor.orgId, params.data.id);
    if (result === null) {
      return reply.code(404).send(notFound("Sending domain not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.sending_domain.verification_checked",
      objectType: "mail_sending_domain",
      objectId: result.domain.id,
      metadata: {
        domain: result.domain.domain,
        spf: result.spf,
        dkim: result.dkim,
        verified: result.verified,
      },
    });
    return { domain: result.domain, spf: result.spf, dkim: result.dkim, verified: result.verified };
  });

  app.delete("/api/admin/mail/sending-domains/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    const deleted = await domainStore.deleteDomain(actor.orgId, params.data.id);
    if (!deleted) {
      return reply.code(404).send(notFound("Sending domain not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.sending_domain.deleted",
      objectType: "mail_sending_domain",
      objectId: params.data.id,
    });
    return { status: "deleted" };
  });

  // ---- DKIM keys ----------------------------------------------------------

  app.get("/api/admin/mail/sending-domains/:id/dkim", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    const domain = await domainStore.getDomain(actor.orgId, params.data.id);
    if (domain === null) {
      return reply.code(404).send(notFound("Sending domain not found."));
    }
    const keys = await dkimStore.listKeys(actor.orgId, params.data.id);
    return { keys: keys.map(serializeDkimKey) };
  });

  app.post("/api/admin/mail/sending-domains/:id/dkim", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    const body = generateDkimBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid DKIM request.", body.error.issues));
    }
    const domain = await domainStore.getDomain(actor.orgId, params.data.id);
    if (domain === null) {
      return reply.code(404).send(notFound("Sending domain not found."));
    }
    /* Only read the existing keys when the caller named no selector — the list
       is what makes a server-chosen selector unique per domain. */
    const selector =
      body.data.selector ??
      nextDkimSelector(
        (await dkimStore.listKeys(actor.orgId, params.data.id)).map(
          (existing) => existing.selector,
        ),
        new Date(),
      );
    if (selector === null) {
      return reply
        .code(409)
        .send(conflict("This domain has already been issued too many keys today."));
    }
    let key: MailDkimKeyRecord;
    try {
      key = await dkimStore.generateKey({
        orgId: actor.orgId,
        domainId: params.data.id,
        selector,
        domain: domain.domain,
        keyBits: body.data.keyBits,
        createdBy: actor.id,
      });
    } catch (error) {
      if (error instanceof MailAdminConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.dkim_key.generated",
      objectType: "mail_dkim_key",
      objectId: key.id,
      metadata: { domain: domain.domain, selector: key.selector, keyBits: key.keyBits },
    });
    return reply.code(201).send({ key: serializeDkimKey(key) });
  });

  /* Rotation is a server route rather than a client-side composition of the two
     primitives it is built from.

     A rotation is "generate a fresh key, which demotes the current active key to
     `retiring` so it stays published in DNS until in-flight mail drains". It
     stays a distinct route from generation because it is a distinct audit verb —
     `mail.dkim_key.rotated` against a named predecessor, which an operator
     reading the log needs to tell a rotation from a first key.

     Retiring the demoted key is deliberately NOT part of this: pulling the old
     selector before mail signed with it has been delivered breaks DKIM on
     messages already in flight. Retirement stays the separate, explicit
     `/dkim/:keyId/retire` step. */
  app.post("/api/admin/mail/sending-domains/:id/dkim/rotate", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    const body = rotateDkimBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid DKIM rotation.", body.error.issues));
    }
    const domain = await domainStore.getDomain(actor.orgId, params.data.id);
    if (domain === null) {
      return reply.code(404).send(notFound("Sending domain not found."));
    }
    const existing = await dkimStore.listKeys(actor.orgId, params.data.id);
    const selector = nextDkimSelector(
      existing.map((key) => key.selector),
      new Date(),
    );
    if (selector === null) {
      return reply
        .code(409)
        .send(conflict("This domain has already been rotated too many times today."));
    }
    const previousActive = existing.find((key) => key.status === "active") ?? null;
    let key: MailDkimKeyRecord;
    try {
      key = await dkimStore.generateKey({
        orgId: actor.orgId,
        domainId: params.data.id,
        selector,
        domain: domain.domain,
        keyBits: body.data.keyBits,
        createdBy: actor.id,
      });
    } catch (error) {
      if (error instanceof MailAdminConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.dkim_key.rotated",
      objectType: "mail_dkim_key",
      objectId: key.id,
      metadata: {
        domain: domain.domain,
        selector: key.selector,
        keyBits: key.keyBits,
        previousSelector: previousActive?.selector ?? null,
      },
    });
    /* The full key list rides along so the console can repaint the domain's DKIM
       state without a follow-up GET it would otherwise have to spend. */
    return reply.code(201).send({
      key: serializeDkimKey(key),
      keys: (await dkimStore.listKeys(actor.orgId, params.data.id)).map(serializeDkimKey),
    });
  });

  app.post("/api/admin/mail/sending-domains/:id/dkim/:keyId/retire", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = domainKeyParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid DKIM key identifiers."));
    }
    const key = await dkimStore.retireKey(actor.orgId, params.data.keyId);
    if (key === null) {
      return reply.code(404).send(notFound("DKIM key not found or already retired."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.dkim_key.retired",
      objectType: "mail_dkim_key",
      objectId: key.id,
      metadata: { selector: key.selector },
    });
    return { key: serializeDkimKey(key) };
  });

  // ---- DMARC reports ------------------------------------------------------

  /* The console's Deliverability tab is one screen: a header of rates over a
     per-reporter table, both read from the same reports. `/dmarc/summary` cannot
     serve it — that route summarizes a single domain, and the tab spans every
     sending domain in the org — and pairing `/dmarc/summary` with
     `/dmarc/reports` would spend two of the tenant's five requests per second on
     one tab. This aggregate is the tab's single read; the per-domain routes
     below stay for callers that want one domain or the raw list. */
  app.get("/api/admin/mail/dmarc", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const query = dmarcQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(invalidRequest("Invalid DMARC query."));
    }
    const reports = await dmarcStore.listReports(actor.orgId, query.data.domain);
    return {
      summary: summarizeDmarcReports(reports),
      reports: reports.map(serializeDmarcReport),
    };
  });

  app.get("/api/admin/mail/dmarc/reports", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const query = dmarcQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(invalidRequest("Invalid DMARC query."));
    }
    return {
      reports: await dmarcStore.listReports(actor.orgId, query.data.domain),
    };
  });

  app.get("/api/admin/mail/dmarc/summary", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const query = dmarcQuery.safeParse(request.query);
    if (!query.success || query.data.domain === undefined) {
      return reply.code(400).send(invalidRequest("A domain query parameter is required."));
    }
    return { summary: await dmarcStore.getSummary(actor.orgId, query.data.domain) };
  });

  app.post("/api/admin/mail/dmarc/reports", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = ingestDmarcBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid DMARC report payload."));
    }
    let parsed;
    try {
      parsed = parseDmarcAggregateReport(actor.orgId, body.data.report);
    } catch (error) {
      if (error instanceof DmarcReportParseError) {
        return reply.code(400).send(invalidRequest(error.message));
      }
      throw error;
    }
    const report = await dmarcStore.ingestReport(parsed);
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.dmarc_report.ingested",
      objectType: "mail_dmarc_report",
      objectId: report.id,
      metadata: {
        domain: report.domain,
        reportId: report.reportId,
        totalMessages: report.totalMessages,
      },
    });
    return reply.code(201).send({ report });
  });

  // ---- Inbound routing rules ---------------------------------------------

  app.get("/api/admin/mail/routing-rules", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return { rules: await routingStore.listRules(actor.orgId) };
  });

  app.post("/api/admin/mail/routing-rules", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = createRoutingRuleBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid routing rule.", body.error.issues));
    }
    let rule;
    try {
      rule = await routingStore.createRule({
        orgId: actor.orgId,
        name: body.data.name,
        isEnabled: body.data.isEnabled,
        priority: body.data.priority,
        match: compactJson(body.data.match),
        actionKind: body.data.actionKind,
        action: compactJson(body.data.action),
        createdBy: actor.id,
      });
    } catch (error) {
      if (error instanceof MailAdminConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      throw error;
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.routing_rule.created",
      objectType: "mail_inbound_routing_rule",
      objectId: rule.id,
      metadata: { name: rule.name, actionKind: rule.actionKind },
    });
    return reply.code(201).send({ rule });
  });

  app.patch("/api/admin/mail/routing-rules/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid routing rule id."));
    }
    const body = updateRoutingRuleBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid routing rule patch.", body.error.issues));
    }
    const rule = await routingStore.updateRule({
      orgId: actor.orgId,
      id: params.data.id,
      ...(body.data.name === undefined ? {} : { name: body.data.name }),
      ...(body.data.isEnabled === undefined ? {} : { isEnabled: body.data.isEnabled }),
      ...(body.data.priority === undefined ? {} : { priority: body.data.priority }),
      ...(body.data.match === undefined ? {} : { match: compactJson(body.data.match) }),
      ...(body.data.actionKind === undefined ? {} : { actionKind: body.data.actionKind }),
      ...(body.data.action === undefined ? {} : { action: compactJson(body.data.action) }),
    });
    if (rule === null) {
      return reply.code(404).send(notFound("Routing rule not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.routing_rule.updated",
      objectType: "mail_inbound_routing_rule",
      objectId: rule.id,
      metadata: { name: rule.name, isEnabled: rule.isEnabled },
    });
    return { rule };
  });

  app.delete("/api/admin/mail/routing-rules/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid routing rule id."));
    }
    const deleted = await routingStore.deleteRule(actor.orgId, params.data.id);
    if (!deleted) {
      return reply.code(404).send(notFound("Routing rule not found."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.routing_rule.deleted",
      objectType: "mail_inbound_routing_rule",
      objectId: params.data.id,
    });
    return { status: "deleted" };
  });

  // ---- Spam filtering (read-only; env + Admin AI overlay) -----------------

  app.get("/api/admin/mail/spam", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return buildMailSpamAdminSettings(process.env);
  });
}

/**
 * Read-only spam posture for Admin › Mail › Spam filtering.
 * Spamd is env-gated; AI beta second-pass may also come from platform-config overlay.
 */
export function buildMailSpamAdminSettings(env: Readonly<Record<string, string | undefined>>): {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly rejectThreshold: number | null;
  readonly daemonStatus: "running" | "stopped" | "unknown";
  readonly rulesetVersion: string | null;
  readonly taggedLast24h: number | null;
  readonly spamd: {
    readonly enabled: boolean;
    readonly host: string | null;
    readonly port: number | null;
  };
  readonly aiBeta: {
    readonly enabled: boolean;
    readonly model: string;
    readonly baseUrl: string;
    readonly apiKeyConfigured: boolean;
  };
} {
  const spamd = getSpamdScannerConfig(env);
  const ai = getMailSpamAiConfig(env);
  const rejectRaw = env.MAIL_SPAMD_REJECT_THRESHOLD;
  const rejectParsed =
    rejectRaw === undefined || rejectRaw.trim().length === 0 ? null : Number.parseFloat(rejectRaw);
  const rejectThreshold =
    rejectParsed !== null && Number.isFinite(rejectParsed) ? rejectParsed : null;

  return {
    // UI "Filtering on" means spamd is configured — AI is a separate beta layer.
    enabled: spamd !== undefined,
    threshold: spamd?.threshold ?? 5,
    rejectThreshold,
    // Honest without a live probe: enabled → unknown, disabled → stopped.
    daemonStatus: spamd === undefined ? "stopped" : "unknown",
    rulesetVersion: env.MAIL_SPAMD_RULESET_VERSION?.trim() || null,
    taggedLast24h: null,
    spamd: {
      enabled: spamd !== undefined,
      host: spamd?.host ?? null,
      port: spamd?.port ?? null,
    },
    aiBeta: {
      enabled: ai.enabled,
      model: ai.model,
      baseUrl: ai.baseUrl,
      apiKeyConfigured: typeof ai.apiKey === "string" && ai.apiKey.trim().length > 0,
    },
  };
}
