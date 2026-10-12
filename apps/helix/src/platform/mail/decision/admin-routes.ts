import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminConsoleReadScope,
  adminConsoleWriteScope,
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  invalidRequest,
  notFound,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "../../admin/console-shared.js";
import type { OrgRecord, UpdateTenantConfigInput } from "../../tenancy/orgs.js";
import { hasControlCharacter } from "../../util/strings.js";
import { toJsonObject } from "../../util/json.js";
import { canReadMailAdminStatus } from "../admin-config.js";
import { getMailSpamAiConfig } from "../spam-ai.js";
import {
  DECISION_MODEL_FLAG,
  decisionModelEndpoint,
  decisionProviderLabel,
  defaultDecisionModel,
  mailDecisionModelConfigSchema,
  resolveDecisionModelConfig,
  type DecisionModelProviderId,
  type ResolvedDecisionModelConfig,
} from "./config.js";
import { DecisionModelError } from "./protocol.js";
import {
  createDecisionModelProvider,
  probeDecisionModel,
  type DecisionModelProvider,
} from "./providers.js";
import type { DecisionModelReport } from "./report.js";
import type { PostgresMailDecisionStore } from "./store.js";

/**
 * Admin → Mail → Spam filtering: SpamAssassin status plus the decision-model
 * settings, connection test, and report. Settings are written through the
 * tenant config (versioned); the API key is write-only and sealed per org.
 */

export interface MailDecisionAdminRoutesOptions {
  readonly store: Pick<
    PostgresMailDecisionStore,
    | "credentialStatus"
    | "readCredential"
    | "saveCredential"
    | "clearCredential"
    | "countAutoSpamSince"
  >;
  readonly orgs: {
    findById(id: string): Promise<OrgRecord | null>;
    updateTenantConfig(input: UpdateTenantConfigInput): Promise<OrgRecord | null>;
  };
  readonly buildReport: (input: {
    readonly orgId: string;
    readonly days: number;
    readonly now: Date;
    readonly config: ResolvedDecisionModelConfig;
  }) => Promise<DecisionModelReport>;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly auditSink: AdminConsoleAuditSink;
  readonly spamd?: { readonly threshold: number; ping(): Promise<boolean> } | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly createProvider?:
    | ((config: ResolvedDecisionModelConfig, credential: string) => DecisionModelProvider)
    | undefined;
  readonly now?: (() => Date) | undefined;
}

const permission = "mail.admin";

const credentialSchema = z
  .string()
  .trim()
  .min(8, "The API key looks too short.")
  .max(4096)
  .refine((value) => !hasControlCharacter(value) && !/\s/u.test(value), {
    message: "The API key must not contain spaces or control characters.",
  });

const putBody = z
  .object({
    settings: z.record(z.unknown()),
    apiKey: credentialSchema.optional(),
    clearApiKey: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !(value.apiKey !== undefined && value.clearApiKey === true), {
    message: "Send either apiKey or clearApiKey, not both.",
  });

const testBody = z
  .object({
    settings: z.record(z.unknown()).optional(),
    apiKey: credentialSchema.optional(),
  })
  .strict()
  .default({});

const reportQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });

export function registerMailDecisionAdminRoutes(
  app: FastifyInstance,
  options: MailDecisionAdminRoutesOptions,
): void {
  const now = options.now ?? (() => new Date());
  const canRead = (actor: Actor) =>
    canReadAdminConsole(actor, permission, resource(actor)) || canReadMailAdminStatus(actor);
  const canWrite = (actor: Actor) => canWriteAdminConsole(actor, permission, resource(actor));
  const loadConfig = async (orgId: string) => {
    const org = await options.orgs.findById(orgId);
    return org === null ? null : resolveDecisionModelConfig(org.featureFlags[DECISION_MODEL_FLAG]);
  };
  const view = async (orgId: string, config: ResolvedDecisionModelConfig) =>
    decisionModelView(config, await options.store.credentialStatus(orgId));

  app.get("/api/admin/mail/spam", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canRead(actor)) return sendForbidden(reply, adminConsoleReadScope);
    const config = await loadConfig(actor.orgId);
    if (config === null) return reply.code(404).send(notFound("Organization not found."));
    const beta = getMailSpamAiConfig(options.env ?? process.env);
    const spamd = options.spamd;
    const credential = await options.store.credentialStatus(actor.orgId);
    return {
      enabled: spamd !== undefined,
      threshold: spamd?.threshold ?? 5,
      rejectThreshold: null,
      daemonStatus: spamd === undefined ? "stopped" : (await spamd.ping()) ? "running" : "stopped",
      rulesetVersion: null,
      taggedLast24h: await options.store.countAutoSpamSince(
        actor.orgId,
        new Date(now().getTime() - 24 * 60 * 60 * 1000),
      ),
      betaSecondPass: { enabled: beta.enabled, model: beta.enabled ? beta.model : null },
      decisionModel: {
        mode: config.mode,
        provider: config.provider,
        model: config.model,
        credentialConfigured: credential?.provider === config.provider,
      },
    };
  });

  app.get("/api/admin/mail/decision-model", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canRead(actor)) return sendForbidden(reply, adminConsoleReadScope);
    const config = await loadConfig(actor.orgId);
    if (config === null) return reply.code(404).send(notFound("Organization not found."));
    return { decisionModel: await view(actor.orgId, config) };
  });

  app.put("/api/admin/mail/decision-model", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWrite(actor)) return sendForbidden(reply, adminConsoleWriteScope);
    const body = putBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid decision model update.", body.error.issues));
    }
    const settings = mailDecisionModelConfigSchema.safeParse(body.data.settings);
    if (!settings.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid decision model settings.", settings.error.issues));
    }
    const previous = await loadConfig(actor.orgId);
    if (previous === null) return reply.code(404).send(notFound("Organization not found."));
    const config = resolveDecisionModelConfig(settings.data);
    const stored = await options.store.credentialStatus(actor.orgId);
    const credentialReady =
      body.data.apiKey !== undefined ||
      (body.data.clearApiKey !== true && stored?.provider === config.provider);
    if (config.mode !== "off" && !credentialReady) {
      return reply
        .code(400)
        .send(
          invalidRequest(
            `Add the ${credentialName(config.provider)} before turning on ${config.mode} mode.`,
          ),
        );
    }
    let credentialChange: "set" | "cleared" | "unchanged" = "unchanged";
    if (body.data.apiKey !== undefined) {
      await options.store.saveCredential({
        orgId: actor.orgId,
        provider: config.provider,
        credential: body.data.apiKey,
        actorId: actor.id,
      });
      credentialChange = "set";
    } else if (body.data.clearApiKey === true) {
      credentialChange = (await options.store.clearCredential(actor.orgId))
        ? "cleared"
        : "unchanged";
    }
    const org = await options.orgs.updateTenantConfig({
      orgId: actor.orgId,
      featureFlags: { [DECISION_MODEL_FLAG]: toJsonObject(settings.data) },
      changedByActorId: actor.id,
      reason: "admin mail decision model update",
    });
    if (org === null) return reply.code(404).send(notFound("Organization not found."));
    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.decision_model.updated",
      objectType: "mail_decision_model",
      objectId: actor.orgId,
      metadata: {
        mode: config.mode,
        previousMode: previous.mode,
        provider: config.provider,
        model: config.model,
        credential: credentialChange,
      },
    });
    return { decisionModel: await view(actor.orgId, config) };
  });

  app.post("/api/admin/mail/decision-model/test", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWrite(actor)) return sendForbidden(reply, adminConsoleWriteScope);
    const body = testBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid connection test.", body.error.issues));
    }
    const saved = await loadConfig(actor.orgId);
    if (saved === null) return reply.code(404).send(notFound("Organization not found."));
    let config = saved;
    if (body.data.settings !== undefined) {
      const draft = mailDecisionModelConfigSchema.safeParse(body.data.settings);
      if (!draft.success) {
        return reply
          .code(400)
          .send(invalidRequest("Invalid decision model settings.", draft.error.issues));
      }
      config = resolveDecisionModelConfig(draft.data);
    }
    if (config.provider === "cloudflare" && config.cloudflareAccountId === undefined) {
      return reply
        .code(400)
        .send(invalidRequest("Enter the Cloudflare account id before testing the connection."));
    }
    const credential =
      body.data.apiKey ?? (await options.store.readCredential(actor.orgId, config.provider));
    if (credential === null) {
      return reply
        .code(400)
        .send(invalidRequest(`Add the ${credentialName(config.provider)} to test the connection.`));
    }
    const provider = (options.createProvider ?? createDecisionModelProvider)(config, credential);
    const audit = (metadata: Record<string, unknown>) =>
      auditAdminAction(options.auditSink, {
        orgId: actor.orgId,
        actorId: actor.id,
        verb: "mail.decision_model.tested",
        objectType: "mail_decision_model",
        objectId: actor.orgId,
        metadata: { provider: config.provider, model: config.model, ...metadata },
      });
    try {
      const result = await probeDecisionModel(provider);
      await audit({ ok: true, latencyMs: result.latencyMs });
      return { test: { ...result, provider: config.provider } };
    } catch (error) {
      const failure =
        error instanceof DecisionModelError
          ? error
          : new DecisionModelError("provider_unavailable", "The connection test failed.");
      await audit({ ok: false, code: failure.code });
      return providerFailure(reply, failure);
    }
  });

  app.get("/api/admin/mail/decision-model/report", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canRead(actor)) return sendForbidden(reply, adminConsoleReadScope);
    const query = reportQuery.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send(invalidRequest("days must be a whole number from 1 to 90.", query.error.issues));
    }
    const config = await loadConfig(actor.orgId);
    if (config === null) return reply.code(404).send(notFound("Organization not found."));
    return {
      report: await options.buildReport({
        orgId: actor.orgId,
        days: query.data.days,
        now: now(),
        config,
      }),
      decisionModel: { mode: config.mode, provider: config.provider, model: config.model },
    };
  });
}

function decisionModelView(
  config: ResolvedDecisionModelConfig,
  credential: { readonly provider: DecisionModelProviderId; readonly updatedAt: Date } | null,
) {
  const configured = credential?.provider === config.provider;
  const label = decisionProviderLabel(config.provider);
  return {
    mode: config.mode,
    provider: config.provider,
    model: config.model,
    defaultModel: defaultDecisionModel(config.provider),
    baseUrl: config.baseUrl ?? null,
    cloudflareAccountId: config.cloudflareAccountId ?? null,
    spamThreshold: config.spamThreshold,
    phishingThreshold: config.phishingThreshold,
    categoryThreshold: config.categoryThreshold,
    applyCategories: config.applyCategories,
    dailyMessageCap: config.dailyMessageCap,
    inputPricePerMillionTokensUsd: config.inputPricePerMillionTokensUsd ?? null,
    credentialConfigured: configured,
    credentialUpdatedAt: configured ? credential.updatedAt.toISOString() : null,
    providerLabel: label,
    endpointHost: decisionModelEndpoint(config).hostname,
    notice: `Message content is sent to ${label} for classification. Mail labelled confidential or restricted is never sent.`,
  };
}

function providerFailure(reply: FastifyReply, error: DecisionModelError): FastifyReply {
  const status =
    error.code === "invalid_request" || error.code === "blocked_destination" ? 400 : 502;
  return reply.code(status).send({
    error: error.message,
    code: "provider_error",
    providerCode: error.code,
    ...(error.options.status === undefined ? {} : { providerStatus: error.options.status }),
  });
}

function credentialName(provider: DecisionModelProviderId): string {
  return provider === "cloudflare" ? "Cloudflare API token" : "TypeSafe API key";
}

function resource(actor: Actor) {
  return { type: "product" as const, id: "mail", orgId: actor.orgId };
}
