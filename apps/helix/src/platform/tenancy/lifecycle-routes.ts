import type { Actor, EventBus, MeteringClient, TraceContext } from "@helix/sdk-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminWildcardScope,
  auditAdminAction,
  conflict,
  invalidRequest,
  notFound,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import type { TenantHourlyQuotaExceeded, TenantHourlyQuotaLimiter } from "../limits/index.js";
import { emitTenantQuotaExceededEvent } from "../limits/quota-events.js";
import { buildTenantExportArchive, type TenantExportManifestPlanner } from "./export.js";
import type { OrgRecord, OrgStore, TenantLifecycleAction } from "./orgs.js";

export const adminTenantsReadScope = "admin.tenants.read";
export const adminTenantsExportScope = "admin.tenants.export";
export const adminTenantsWriteScope = "admin.tenants.write";
export const adminTenantsDeleteScope = "admin.tenants.delete";

export interface TenantLifecycleStore extends Pick<OrgStore, "findBySlug"> {
  applyTenantLifecycleAction(input: {
    readonly slug: string;
    readonly action: TenantLifecycleAction;
  }): Promise<OrgRecord | null>;
}

export interface RegisterTenantLifecycleRoutesOptions {
  readonly orgs: TenantLifecycleStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly exportPlanner: TenantExportManifestPlanner;
  readonly auditSink?: AdminConsoleAuditSink | undefined;
  readonly exportJobLimiter?: TenantHourlyQuotaLimiter | undefined;
  readonly exportJobLimit?: (input: {
    readonly org: OrgRecord;
    readonly actor: Actor;
  }) => Promise<number | null | undefined> | number | null | undefined;
  readonly events?: Pick<EventBus, "publish"> | undefined;
  readonly onEventError?: (error: unknown) => void;
  readonly metering?: MeteringClient | undefined;
  readonly onMeteringError?: (error: unknown) => void;
}

const tenantParams = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
});

const lifecycleActionBody = z
  .object({
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .default({});

export async function registerTenantLifecycleRoutes(
  app: FastifyInstance,
  options: RegisterTenantLifecycleRoutesOptions,
): Promise<void> {
  app.get("/api/admin/tenants/:slug/export", async (request, reply) => {
    const loaded = await loadTenantForAction({
      request,
      reply,
      options,
      requiredScope: adminTenantsExportScope,
    });
    if (loaded === undefined) {
      return reply;
    }

    const quotaDecision = await consumeTenantExportQuota({
      limiter: options.exportJobLimiter,
      limit: options.exportJobLimit,
      org: loaded.org,
      actor: loaded.actor,
      events: options.events,
      onEventError: options.onEventError,
      trace: (request as { readonly trace?: TraceContext }).trace,
      surface: "tenant.export.archive",
    });
    if (quotaDecision !== undefined) {
      reply.header("retry-after", String(quotaDecision.retryAfterSeconds));
      return reply.code(429).send({
        error: "Tenant export job quota exceeded.",
        code: "quota_exceeded",
        quota: quotaDecision.quota,
        limit: quotaDecision.limit,
        used: quotaDecision.used,
        retryAfterSeconds: quotaDecision.retryAfterSeconds,
        resetsAt: quotaDecision.resetsAt,
      });
    }

    const manifest = await options.exportPlanner(loaded.org);
    const archive = buildTenantExportArchive(manifest);
    emitTenantExportMetering({
      metering: options.metering,
      onMeteringError: options.onMeteringError,
      orgId: loaded.org.id,
      manifest,
      trace: (request as { readonly trace?: TraceContext }).trace,
      surface: "tenant.export.archive",
      format: "tar",
    });
    await auditAdminAction(options.auditSink, {
      orgId: loaded.org.id,
      actorId: loaded.actor.id,
      verb: "tenant.exported",
      objectType: "tenant",
      objectId: loaded.org.id,
      metadata: {
        slug: loaded.org.slug,
        filename: archive.filename,
        byteSize: archive.byteSize,
        objectCount: manifest.objectInventory.objectCount,
        totalKnownBytes: manifest.objectInventory.totalKnownBytes,
        tableCount: manifest.postgres.rowCounts.length,
        auditRowCount: manifest.auditLog.rowCount,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      },
    });

    return reply
      .header("content-disposition", `attachment; filename="${archive.filename}"`)
      .header("content-length", String(archive.byteSize))
      .type(archive.contentType)
      .send(archive.bytes);
  });

  app.get("/api/admin/tenants/:slug/export/manifest", async (request, reply) => {
    const loaded = await loadTenantForAction({
      request,
      reply,
      options,
      requiredScope: adminTenantsExportScope,
    });
    if (loaded === undefined) {
      return reply;
    }

    const quotaDecision = await consumeTenantExportQuota({
      limiter: options.exportJobLimiter,
      limit: options.exportJobLimit,
      org: loaded.org,
      actor: loaded.actor,
      events: options.events,
      onEventError: options.onEventError,
      trace: (request as { readonly trace?: TraceContext }).trace,
      surface: "tenant.export.manifest",
    });
    if (quotaDecision !== undefined) {
      reply.header("retry-after", String(quotaDecision.retryAfterSeconds));
      return reply.code(429).send({
        error: "Tenant export job quota exceeded.",
        code: "quota_exceeded",
        quota: quotaDecision.quota,
        limit: quotaDecision.limit,
        used: quotaDecision.used,
        retryAfterSeconds: quotaDecision.retryAfterSeconds,
        resetsAt: quotaDecision.resetsAt,
      });
    }

    const manifest = await options.exportPlanner(loaded.org);
    emitTenantExportMetering({
      metering: options.metering,
      onMeteringError: options.onMeteringError,
      orgId: loaded.org.id,
      manifest,
      trace: (request as { readonly trace?: TraceContext }).trace,
      surface: "tenant.export.manifest",
      format: "manifest",
    });
    await auditAdminAction(options.auditSink, {
      orgId: loaded.org.id,
      actorId: loaded.actor.id,
      verb: "tenant.export.planned",
      objectType: "tenant",
      objectId: loaded.org.id,
      metadata: {
        slug: loaded.org.slug,
        objectCount: manifest.objectInventory.objectCount,
        totalKnownBytes: manifest.objectInventory.totalKnownBytes,
        tableCount: manifest.postgres.rowCounts.length,
        auditRowCount: manifest.auditLog.rowCount,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      },
    });

    return { manifest };
  });

  app.post("/api/admin/tenants/:slug/suspend", async (request, reply) =>
    runLifecycleTransition({
      request,
      reply,
      options,
      action: "suspend",
      requiredScope: adminTenantsWriteScope,
      verb: "tenant.lifecycle.suspended",
    }),
  );

  app.post("/api/admin/tenants/:slug/unsuspend", async (request, reply) =>
    runLifecycleTransition({
      request,
      reply,
      options,
      action: "unsuspend",
      requiredScope: adminTenantsWriteScope,
      verb: "tenant.lifecycle.reactivated",
    }),
  );

  app.post("/api/admin/tenants/:slug/delete", async (request, reply) =>
    runLifecycleTransition({
      request,
      reply,
      options,
      action: "soft-delete",
      requiredScope: adminTenantsDeleteScope,
      verb: "tenant.lifecycle.soft_deleted",
    }),
  );

  app.post("/api/admin/tenants/:slug/restore", async (request, reply) =>
    runLifecycleTransition({
      request,
      reply,
      options,
      action: "restore",
      requiredScope: adminTenantsWriteScope,
      verb: "tenant.lifecycle.restored",
    }),
  );
}

async function runLifecycleTransition(input: {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly options: RegisterTenantLifecycleRoutesOptions;
  readonly action: TenantLifecycleAction;
  readonly requiredScope: string;
  readonly verb: string;
}): Promise<unknown> {
  const loaded = await loadTenantForAction(input);
  if (loaded === undefined) {
    return input.reply;
  }
  const body = lifecycleActionBody.safeParse(input.request.body ?? {});
  if (!body.success) {
    return input.reply
      .code(400)
      .send(invalidRequest("Invalid tenant lifecycle request.", body.error.issues));
  }

  const updated = await input.options.orgs.applyTenantLifecycleAction({
    slug: loaded.org.slug,
    action: input.action,
  });
  if (updated === null) {
    return input.reply
      .code(409)
      .send(conflict(`Tenant cannot transition from ${loaded.org.status} with ${input.action}.`));
  }

  await auditAdminAction(input.options.auditSink, {
    orgId: updated.id,
    actorId: loaded.actor.id,
    verb: input.verb,
    objectType: "tenant",
    objectId: updated.id,
    metadata: {
      slug: updated.slug,
      previousStatus: loaded.org.status,
      nextStatus: updated.status,
      reason: body.data.reason ?? null,
      ip: input.request.ip,
      userAgent: input.request.headers["user-agent"] ?? null,
    },
  });

  return { tenant: tenantLifecycleView(updated) };
}

async function loadTenantForAction(input: {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly options: RegisterTenantLifecycleRoutesOptions;
  readonly requiredScope: string;
}): Promise<{ readonly actor: Actor; readonly org: OrgRecord } | undefined> {
  const actor = await input.options.actorFromRequest(input.request);
  if (!hasScope(actor, input.requiredScope)) {
    sendTenantForbidden(input.reply, input.requiredScope);
    return undefined;
  }

  const params = tenantParams.safeParse(input.request.params);
  if (!params.success) {
    input.reply
      .code(400)
      .send(invalidRequest("Invalid tenant lifecycle slug.", params.error.issues));
    return undefined;
  }

  const org = await input.options.orgs.findBySlug(params.data.slug);
  if (org === null) {
    input.reply.code(404).send(notFound("Tenant not found."));
    return undefined;
  }
  if (org.id !== actor.orgId) {
    sendTenantForbidden(input.reply, input.requiredScope);
    return undefined;
  }
  return { actor, org };
}

async function consumeTenantExportQuota(input: {
  readonly limiter?: TenantHourlyQuotaLimiter | undefined;
  readonly limit?: RegisterTenantLifecycleRoutesOptions["exportJobLimit"];
  readonly org: OrgRecord;
  readonly actor: Actor;
  readonly events?: Pick<EventBus, "publish"> | undefined;
  readonly onEventError?: ((error: unknown) => void) | undefined;
  readonly trace?: TraceContext | undefined;
  readonly surface: string;
}): Promise<TenantHourlyQuotaExceeded | undefined> {
  if (input.limiter === undefined || input.limit === undefined) {
    return undefined;
  }
  const limit = await input.limit({ org: input.org, actor: input.actor });
  const decision = await input.limiter.consume({
    orgId: input.org.id,
    quota: "export_jobs_per_hour",
    limit: limit ?? null,
  });
  if (decision.allowed) {
    return undefined;
  }
  emitTenantQuotaExceededEvent({
    events: input.events,
    onError: input.onEventError,
    subject: "quota.export_jobs.exceeded",
    orgId: input.org.id,
    surface: input.surface,
    decision,
    trace: input.trace,
    metadata: {
      slug: input.org.slug,
    },
  });
  return decision;
}

function emitTenantExportMetering(input: {
  readonly metering?: MeteringClient | undefined;
  readonly onMeteringError?: ((error: unknown) => void) | undefined;
  readonly orgId: string;
  readonly manifest: Awaited<ReturnType<TenantExportManifestPlanner>>;
  readonly trace?: TraceContext | undefined;
  readonly surface: string;
  readonly format: "manifest" | "tar";
}): void {
  void input.metering
    ?.emit(
      input.orgId,
      {
        type: "export.completed",
        quantity: 1,
        metadata: {
          surface: input.surface,
          format: input.format,
          object_count: input.manifest.objectInventory.objectCount,
          total_known_bytes: input.manifest.objectInventory.totalKnownBytes,
          table_count: input.manifest.postgres.rowCounts.length,
          audit_row_count: input.manifest.auditLog.rowCount,
        },
      },
      input.trace,
    )
    .catch((error: unknown) => {
      input.onMeteringError?.(error);
    });
}

function hasScope(actor: Actor, requiredScope: string): boolean {
  const scopes = actor.scopes ?? [];
  return scopes.includes(adminWildcardScope) || scopes.includes(requiredScope);
}

function sendTenantForbidden(reply: FastifyReply, requiredScope: string): void {
  reply.code(403).send({
    error: "Tenant lifecycle permission denied.",
    code: "forbidden",
    requiredScope,
  });
}

function tenantLifecycleView(org: OrgRecord): Record<string, unknown> {
  return {
    id: org.id,
    slug: org.slug,
    displayName: org.displayName,
    status: org.status,
    tier: org.tier,
    planId: org.planId,
    region: org.region,
  };
}
