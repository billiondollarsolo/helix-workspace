import type { Actor, JsonObject } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
} from "../admin/console-shared.js";
import { DomainsConflictError, type DomainRecord, type DomainsStore } from "../admin/domains.js";
import {
  MailAdminConflictError,
  type MailDkimKeyRecord,
  type MailDkimKeyStore,
  type MailDmarcReportStore,
  type MailDmarcReportRecord,
  type MailRoutingRuleStore,
  type OutboundProviderStore,
} from "./admin-store.js";
import {
  OUTBOUND_MAIL_PROVIDER_KINDS,
  parseOutboundProviderPublicConfig,
  type OutboundProviderConfig,
} from "./providers.js";
import { parseDmarcAggregateReport, DmarcReportParseError } from "./dmarc.js";

/**
 * Mail delivery admin routes.
 *
 * Org admins manage the outbound delivery provider, mail domains, DKIM
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
  return canReadAdminConsole(actor, mailAdminScope, {
    type: "product",
    id: "mail",
    orgId: actor.orgId,
  });
}

/** Mail-admin write access — admin-console write, `admin.*`, or `mail.admin`. */
function canWriteMailDeliveryAdmin(actor: Actor): boolean {
  return canWriteAdminConsole(actor, mailAdminScope, {
    type: "product",
    id: "mail",
    orgId: actor.orgId,
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const idParams = z.object({ id: z.string().uuid() });
const domainKeyParams = z.object({ id: z.string().uuid(), keyId: z.string().uuid() });

const providerKindSchema = z.enum(OUTBOUND_MAIL_PROVIDER_KINDS);
const jsonObjectSchema = z.record(z.unknown());
const tenantSecretHandleSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/u);

const createProviderBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: providerKindSchema,
    enabled: z.boolean().default(true),
    isDefault: z.boolean().default(false),
    config: jsonObjectSchema.default({}),
    secretRef: tenantSecretHandleSchema.nullable().default(null),
    webhookSecretRef: tenantSecretHandleSchema.nullable().default(null),
  })
  .strict();

const updateProviderBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    config: jsonObjectSchema.optional(),
    secretRef: tenantSecretHandleSchema.nullable().optional(),
    webhookSecretRef: tenantSecretHandleSchema.nullable().optional(),
  })
  .strict();

const enableMailDomainBody = z
  .object({
    providerId: z.string().uuid().nullable().default(null),
  })
  .strict();

const generateDkimBody = z
  .object({
    selector: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9._-]+$/iu, "Selector must be a DNS label.")
      .optional(),
    keyBits: z.literal(2048).default(2048),
    kmsKeyId: z.string().trim().min(1).max(2_048).optional(),
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
const routingAddressPatternSchema = z
  .string()
  .trim()
  .max(320)
  .regex(/^(?:\*|[^@*\s]+)@[^@*\s]+$/u);
const routingMatchSchema = z
  .object({
    recipientPattern: routingAddressPatternSchema.optional(),
    senderPattern: routingAddressPatternSchema.optional(),
    subjectContains: z.string().trim().min(1).max(998).optional(),
    headerName: z
      .string()
      .trim()
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u)
      .optional(),
    headerContains: z.string().trim().min(1).max(998).optional(),
  })
  .strict()
  .refine((value) => (value.headerName === undefined) === (value.headerContains === undefined), {
    message: "headerName and headerContains must be provided together.",
  });
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
  const configured = Object.keys(action).filter((key) => key !== "stopProcessing");
  switch (kind) {
    case "forward":
      return configured.length === 1 && action.forwardTo !== undefined;
    case "alias":
      return configured.length === 1 && action.aliasActorId !== undefined;
    case "tag":
      return configured.length === 1 && action.tag !== undefined;
    case "mailbox":
      return configured.length === 1 && action.mailbox !== undefined;
    case "drop":
      return configured.length === 0;
    default:
      return false;
  }
}

function isRoutingValidationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "23514" || error.code === "22023")
  );
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
    webhookSecretRef: provider.webhookSecretRef,
    hasWebhookSecret: provider.webhookSecretRef !== null,
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
    privateKeyStored: key.privateKeyStored,
    activatedAt: key.activatedAt,
    verifiedAt: key.verifiedAt,
    rotatedAt: key.rotatedAt,
    retiredAt: key.retiredAt,
    createdAt: key.createdAt,
    updatedAt: key.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

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

export interface RegisterMailDeliveryAdminRoutesOptions {
  readonly providerStore: OutboundProviderStore;
  readonly domainStore: Pick<DomainsStore, "listDomains" | "getDomain" | "setDomainCapabilities">;
  readonly dkimStore: MailDkimKeyStore;
  readonly dmarcStore: MailDmarcReportStore;
  readonly routingStore: MailRoutingRuleStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly auditSink: AdminConsoleAuditSink;
  readonly verifyDkimDns: (input: {
    readonly host: string;
    readonly record: string;
  }) => Promise<boolean>;
}

/**
 * Register the mail delivery admin routes:
 *
 *   GET    /api/admin/mail/providers
 *   POST   /api/admin/mail/providers
 *   PATCH  /api/admin/mail/providers/:id
 *   DELETE /api/admin/mail/providers/:id
 *   GET    /api/admin/mail/domains
 *   POST   /api/admin/mail/domains/:id/enable
 *   DELETE /api/admin/mail/domains/:id
 *   GET    /api/admin/mail/domains/:id/dkim
 *   POST   /api/admin/mail/domains/:id/dkim
 *   POST   /api/admin/mail/domains/:id/dkim/:keyId/activate
 *   POST   /api/admin/mail/domains/:id/dkim/:keyId/retire
 *   GET    /api/admin/mail/dmarc/reports
 *   GET    /api/admin/mail/dmarc/summary
 *   POST   /api/admin/mail/dmarc/reports
 *   GET    /api/admin/mail/routing-rules
 *   POST   /api/admin/mail/routing-rules
 *   PATCH  /api/admin/mail/routing-rules/:id
 *   DELETE /api/admin/mail/routing-rules/:id
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
    verifyDkimDns,
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
      const config = parseOutboundProviderPublicConfig(body.data.kind, body.data.config);
      provider = await providerStore.createProvider({
        orgId: actor.orgId,
        name: body.data.name,
        kind: body.data.kind,
        enabled: body.data.enabled,
        isDefault: body.data.isDefault,
        config,
        secretRef: body.data.secretRef,
        webhookSecretRef: body.data.webhookSecretRef,
        createdBy: actor.id,
      });
    } catch (error) {
      if (error instanceof MailAdminConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      return reply
        .code(400)
        .send(invalidRequest(error instanceof Error ? error.message : "Invalid provider config."));
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
    const current = await providerStore.getProvider(actor.orgId, params.data.id);
    if (current === null) {
      return reply.code(404).send(notFound("Provider not found."));
    }
    let config: JsonObject | undefined;
    try {
      config =
        body.data.config === undefined
          ? undefined
          : parseOutboundProviderPublicConfig(current.kind, body.data.config);
    } catch (error) {
      return reply
        .code(400)
        .send(invalidRequest(error instanceof Error ? error.message : "Invalid provider config."));
    }
    const provider = await providerStore.updateProvider({
      orgId: actor.orgId,
      id: params.data.id,
      ...(body.data.name === undefined ? {} : { name: body.data.name }),
      ...(body.data.enabled === undefined ? {} : { enabled: body.data.enabled }),
      ...(body.data.isDefault === undefined ? {} : { isDefault: body.data.isDefault }),
      ...(config === undefined ? {} : { config }),
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

  // ---- Canonical domains with mail capability ----------------------------

  app.get("/api/admin/mail/domains", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const domains = (await domainStore.listDomains(actor.orgId)).filter(
      (domain) => domain.status === "verified" && domain.mailEnabled,
    );
    return {
      domains: await Promise.all(
        domains.map(async (domain) => ({
          ...domain,
          dkimKeys: (await dkimStore.listKeys(actor.orgId, domain.id)).map(serializeDkimKey),
        })),
      ),
    };
  });

  app.post("/api/admin/mail/domains/:id/enable", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    const body = enableMailDomainBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(invalidRequest("Invalid mail-domain configuration."));
    }
    if (body.data.providerId !== null) {
      const provider = await providerStore.getProvider(actor.orgId, body.data.providerId);
      if (provider === null) {
        return reply.code(400).send(invalidRequest("Unknown provider for mail domain."));
      }
    }
    const current = await domainStore.getDomain(actor.orgId, params.data.id);
    if (current === null) return reply.code(404).send(notFound("Domain not found."));
    let domain: DomainRecord | null;
    try {
      domain = await domainStore.setDomainCapabilities({
        orgId: actor.orgId,
        id: current.id,
        actorId: actor.id,
        identityEnabled: current.identityEnabled,
        mailEnabled: true,
        aliasesEnabled: current.aliasesEnabled,
        customHostEnabled: current.customHostEnabled,
        federationEnabled: current.federationEnabled,
        providerId: body.data.providerId,
        identityMode: current.identityMode,
        aliasTargetDomainId: current.aliasTargetDomainId,
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
      verb: "mail.domain.enabled",
      objectType: "admin_domain",
      objectId: domain.id,
      metadata: { domain: domain.domain },
    });
    return { domain };
  });

  app.delete("/api/admin/mail/domains/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    const current = await domainStore.getDomain(actor.orgId, params.data.id);
    if (current === null) return reply.code(404).send(notFound("Domain not found."));
    let domain: DomainRecord | null;
    try {
      domain = await domainStore.setDomainCapabilities({
        orgId: actor.orgId,
        id: current.id,
        actorId: actor.id,
        identityEnabled: current.identityEnabled,
        mailEnabled: false,
        aliasesEnabled: current.aliasesEnabled,
        customHostEnabled: current.customHostEnabled,
        federationEnabled: current.federationEnabled,
        providerId: null,
        identityMode: current.identityMode,
        aliasTargetDomainId: current.aliasTargetDomainId,
      });
    } catch (error) {
      if (error instanceof DomainsConflictError)
        return reply.code(409).send(conflict(error.message));
      throw error;
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.domain.disabled",
      objectType: "admin_domain",
      objectId: params.data.id,
    });
    return { status: "disabled", domain };
  });

  // ---- DKIM keys ----------------------------------------------------------

  app.get("/api/admin/mail/domains/:id/dkim", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    const domain = await domainStore.getDomain(actor.orgId, params.data.id);
    if (domain === null || !domain.mailEnabled || domain.status !== "verified") {
      return reply.code(404).send(notFound("Mail domain not found."));
    }
    const keys = await dkimStore.listKeys(actor.orgId, params.data.id);
    return { keys: keys.map(serializeDkimKey) };
  });

  app.post("/api/admin/mail/domains/:id/dkim", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid domain id."));
    }
    const body = generateDkimBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid DKIM request.", body.error.issues));
    }
    const domain = await domainStore.getDomain(actor.orgId, params.data.id);
    if (domain === null || !domain.mailEnabled || domain.status !== "verified") {
      return reply.code(404).send(notFound("Mail domain not found."));
    }
    const selector =
      body.data.selector ??
      nextDkimSelector(
        (await dkimStore.listKeys(actor.orgId, params.data.id)).map((key) => key.selector),
        new Date(),
      );
    if (selector === null)
      return reply.code(409).send(conflict("No unused DKIM selector is available today."));
    let key: MailDkimKeyRecord;
    try {
      key = await dkimStore.generateKey({
        orgId: actor.orgId,
        domainId: params.data.id,
        selector,
        domain: domain.domain,
        keyBits: body.data.keyBits,
        ...(body.data.kmsKeyId === undefined ? {} : { kmsKeyId: body.data.kmsKeyId }),
        createdBy: actor.id,
      });
    } catch (error) {
      if (error instanceof MailAdminConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      if (isRoutingValidationError(error)) {
        return reply.code(400).send(invalidRequest("Routing rule violates tenant mail policy."));
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

  app.post("/api/admin/mail/domains/:id/dkim/:keyId/activate", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteMailDeliveryAdmin(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = domainKeyParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid DKIM key identifiers."));
    }
    const domain = await domainStore.getDomain(actor.orgId, params.data.id);
    const pending = (await dkimStore.listKeys(actor.orgId, params.data.id)).find(
      (key) => key.id === params.data.keyId && key.status === "pending",
    );
    if (domain === null || pending === undefined || domain.status !== "verified") {
      return reply.code(404).send(notFound("Pending DKIM key not found."));
    }
    const host = `${pending.selector}._domainkey.${domain.domain}`;
    if (!(await verifyDkimDns({ host, record: pending.dnsRecord }))) {
      return reply.code(409).send(conflict(`Publish the DKIM TXT record at ${host} first.`));
    }
    const key = await dkimStore.activateKey(actor.orgId, pending.id);
    if (key === null) {
      return reply.code(409).send(conflict("DKIM key activation raced with another update."));
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.dkim_key.activated",
      objectType: "mail_dkim_key",
      objectId: key.id,
      metadata: { domain: domain.domain, selector: key.selector, verifiedHost: host },
    });
    return { key: serializeDkimKey(key) };
  });

  app.post("/api/admin/mail/domains/:id/dkim/:keyId/retire", async (request, reply) => {
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
    let rule;
    try {
      rule = await routingStore.updateRule({
        orgId: actor.orgId,
        id: params.data.id,
        ...(body.data.name === undefined ? {} : { name: body.data.name }),
        ...(body.data.isEnabled === undefined ? {} : { isEnabled: body.data.isEnabled }),
        ...(body.data.priority === undefined ? {} : { priority: body.data.priority }),
        ...(body.data.match === undefined ? {} : { match: compactJson(body.data.match) }),
        ...(body.data.actionKind === undefined ? {} : { actionKind: body.data.actionKind }),
        ...(body.data.action === undefined ? {} : { action: compactJson(body.data.action) }),
      });
    } catch (error) {
      if (isRoutingValidationError(error)) {
        return reply.code(400).send(invalidRequest("Routing rule violates tenant mail policy."));
      }
      throw error;
    }
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
}

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
