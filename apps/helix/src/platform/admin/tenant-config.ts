import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor, EventBus, JsonObject } from "@helix/sdk-types";
import { z } from "zod3";
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
import {
  assertLiveMigrationStorageStates,
  defaultTenantStoragePrefix,
  testTenantStorageConnection,
  type TenantStorageResolver,
  type TenantStorageMigrationJobRecord,
  type TenantStorageMigrationJobStore,
  type TenantStorageMigrationStorageState,
} from "../storage/index.js";
import type { OrgRecord, UpdateTenantConfigInput } from "../tenancy/orgs.js";
import { buildEffectiveTenantConfig, type PlanRecord, type PlanStore } from "../tenancy/plans.js";

export interface TenantConfigAdminStore {
  findById(id: string): Promise<OrgRecord | null>;
  updateTenantConfig(input: UpdateTenantConfigInput): Promise<OrgRecord | null>;
}

export interface TenantConfigAdminView {
  readonly orgId: string;
  readonly byo: JsonObject;
  readonly features: JsonObject;
  readonly quotas: JsonObject;
  readonly branding: JsonObject;
  readonly plan: {
    readonly id: string;
    readonly displayName: string;
    readonly featureFlagsDefault: JsonObject;
    readonly quotasDefault: JsonObject;
  } | null;
  readonly effective: {
    readonly byo: JsonObject;
    readonly features: JsonObject;
    readonly quotas: JsonObject;
    readonly branding: JsonObject;
  };
}

export interface RegisterTenantConfigAdminRoutesOptions {
  readonly store: TenantConfigAdminStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly auditSink?: AdminConsoleAuditSink | undefined;
  readonly storageResolver?: TenantStorageResolver | undefined;
  readonly storageMigrationJobs?:
    | Pick<TenantStorageMigrationJobStore, "create" | "findByIdForOrg">
    | undefined;
  readonly plans?: Pick<PlanStore, "findById"> | undefined;
  readonly featureFlagEvents?: Pick<EventBus, "publish"> | undefined;
  readonly onFeatureFlagEventError?: ((error: unknown) => void) | undefined;
}

const dlpModeSchema = z.enum(["off", "warn", "block"]);
const watermarkModeSchema = z.enum(["off", "visible", "invisible", "both"]);
const supportTierSchema = z.enum([
  "community",
  "email-48h",
  "priority-24h",
  "premium-4h",
  "premium-1h-named",
]);

const featureFlagsSchema = z
  .object({
    editors_native_document: z.boolean().optional(),
    editors_native_spreadsheet: z.boolean().optional(),
    editors_native_presentation: z.boolean().optional(),
    editors_native_pdf: z.boolean().optional(),
    editors_ai_rag: z.boolean().optional(),
    ai_smart_compose: z.boolean().optional(),
    dlp_enforcement: dlpModeSchema.optional(),
    watermark: watermarkModeSchema.optional(),
    b2b_sharing: z.boolean().optional(),
    mail_outbound: z.boolean().optional(),
    sso_saml: z.boolean().optional(),
    scim_provisioning: z.boolean().optional(),
    custom_domain: z.boolean().optional(),
    byo_storage: z.boolean().optional(),
    byo_database: z.boolean().optional(),
    byo_kms: z.boolean().optional(),
    byo_ai_provider: z.boolean().optional(),
    white_label: z.boolean().optional(),
    multi_region_dr: z.boolean().optional(),
    dedicated_csm: z.boolean().optional(),
    marketplace_install_paid: z.boolean().optional(),
    support_tier: supportTierSchema.optional(),
  })
  .strict();

const quotaValueSchema = z.number().int().min(0).nullable();
const quotasSchema = z
  .object({
    storage_bytes_limit: quotaValueSchema.optional(),
    ai_tokens_monthly_limit: quotaValueSchema.optional(),
    ai_image_gen_monthly_limit: quotaValueSchema.optional(),
    actors_limit: quotaValueSchema.optional(),
    outbound_webhooks_limit: quotaValueSchema.optional(),
    api_rps_limit: quotaValueSchema.optional(),
    collab_concurrent_editors_per_doc: quotaValueSchema.optional(),
    export_jobs_per_hour: quotaValueSchema.optional(),
  })
  .strict();

const brandingSchema = z
  .object({
    logo_url: z.string().trim().url().max(2000).optional(),
    accent_color_hex: z
      .string()
      .trim()
      .regex(/^#[0-9A-Fa-f]{6}$/u)
      .optional(),
    display_name_override: z.string().trim().min(1).max(120).optional(),
    email_from_name: z.string().trim().min(1).max(120).optional(),
    email_from_domain: z.string().trim().min(1).max(253).optional(),
    custom_domain: z.string().trim().min(1).max(253).optional(),
  })
  .strict();

const byoStorageSchema = z
  .object({
    kind: z.enum(["helix-default", "byo"]),
    provider: z.enum(["aws-s3", "r2", "s3-compatible"]).optional(),
    endpoint: z.string().trim().url().max(2000).optional(),
    region: z.string().trim().min(1).max(100).optional(),
    bucket: z.string().trim().min(1).max(255).optional(),
    prefix: z
      .string()
      .trim()
      .max(1024)
      .refine((value) => !unsafeStoragePrefix(value), {
        message:
          "Storage prefix must not contain path traversal, repeated separators, or control characters.",
      })
      .optional(),
    credentials_vault_path: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .regex(/^tenants\/[A-Za-z0-9_-]+\/byo-storage\/[A-Za-z0-9_.-]+$/u, {
        message:
          "BYO storage credentials_vault_path must be scoped under tenants/{tenant}/byo-storage/.",
      })
      .optional(),
    force_path_style: z.boolean().optional(),
    encryption: z
      .object({
        sse_kms_key_arn: z.string().trim().min(1).max(2048).optional(),
      })
      .strict()
      .optional(),
    lifecycle: z
      .object({
        object_lock: z.enum(["off", "governance", "compliance"]).optional(),
        retention_days: z.number().int().positive().max(36500).nullable().optional(),
      })
      .strict()
      .optional(),
    health: z
      .object({
        status: z.enum(["unknown", "healthy", "degraded"]).optional(),
        checked_at: z.string().datetime().optional(),
        message: z.string().trim().min(1).max(500).optional(),
      })
      .strict()
      .optional(),
    status: z.string().trim().min(1).max(100).optional(),
    version: z.number().int().positive().max(100).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "byo") {
      for (const key of ["provider", "bucket", "credentials_vault_path"] as const) {
        if (value[key] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required for BYO storage.`,
          });
        }
      }
      if (value.provider !== "aws-s3" && value.endpoint === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endpoint"],
          message: "endpoint is required for this BYO storage provider.",
        });
      }
    }
  });

const byoConfigSchema = z
  .object({
    storage: byoStorageSchema.optional(),
  })
  .strict();

const tenantConfigUpdateBody = z
  .object({
    byo: byoConfigSchema.optional(),
    features: featureFlagsSchema.optional(),
    quotas: quotasSchema.optional(),
    branding: brandingSchema.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.byo !== undefined ||
      value.features !== undefined ||
      value.quotas !== undefined ||
      value.branding !== undefined,
    { message: "At least one tenant config section must be provided." },
  );

const storageMigrationRequestBody = z
  .object({
    target: z.enum(["byo", "helix-default"]).default("byo"),
    dryRun: z.boolean().default(false),
    sourceStorage: byoStorageSchema.optional(),
    targetStorage: byoStorageSchema.optional(),
  })
  .strict()
  .default({});

const storageMigrationParams = z.object({
  id: z.string().uuid(),
});

const storageMigrationCutoverBody = z
  .object({
    confirm: z.literal("CUTOVER"),
  })
  .strict();

export async function registerTenantConfigAdminRoutes(
  app: FastifyInstance,
  options: RegisterTenantConfigAdminRoutesOptions,
): Promise<void> {
  app.get("/api/admin/tenant-config", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const org = await options.store.findById(actor.orgId);
    if (org === null) {
      return reply.code(404).send(notFound("Tenant config not found."));
    }
    return { tenantConfig: await tenantConfigView(org, options.plans) };
  });

  app.patch("/api/admin/tenant-config", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = tenantConfigUpdateBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant config update.", body.error.issues));
    }
    if (body.data.byo?.storage?.kind === "byo") {
      const current = await options.store.findById(actor.orgId);
      if (current === null) {
        return reply.code(404).send(notFound("Tenant config not found."));
      }
      if (current.featureFlags.byo_storage !== true && body.data.features?.byo_storage !== true) {
        return reply
          .code(400)
          .send(invalidRequest("BYO storage is not enabled for this tenant.", []));
      }
    }

    const org = await options.store.updateTenantConfig({
      orgId: actor.orgId,
      ...(body.data.byo === undefined ? {} : { byoConfig: toJsonObject(body.data.byo) }),
      ...(body.data.features === undefined
        ? {}
        : { featureFlags: toJsonObject(body.data.features) }),
      ...(body.data.quotas === undefined ? {} : { quotas: toJsonObject(body.data.quotas) }),
      ...(body.data.branding === undefined ? {} : { branding: toJsonObject(body.data.branding) }),
      changedByActorId: actor.id,
      reason: body.data.reason ?? "admin tenant config update",
    });
    if (org === null) {
      return reply.code(404).send(notFound("Tenant config not found."));
    }

    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.tenant_config.updated",
      objectType: "tenant_config",
      objectId: actor.orgId,
      metadata: {
        sections: tenantConfigSections(body.data),
      },
    });
    if (body.data.features !== undefined) {
      void options.featureFlagEvents
        ?.publish(`flags.changed.${actor.orgId}`, {
          orgId: actor.orgId,
          changedByActorId: actor.id,
          reason: body.data.reason ?? "admin tenant config update",
          keys: Object.keys(body.data.features).sort(),
        })
        .catch((error: unknown) => {
          options.onFeatureFlagEventError?.(error);
        });
    }

    return { tenantConfig: await tenantConfigView(org, options.plans) };
  });

  app.post("/api/admin/tenant-config/byo-storage/test", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const org = await options.store.findById(actor.orgId);
    if (org === null) {
      return reply.code(404).send(notFound("Tenant config not found."));
    }

    const health = await testTenantStorageConnection({
      orgId: actor.orgId,
      storageResolver: options.storageResolver,
    });
    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.tenant_config.byo_storage_tested",
      objectType: "tenant_config",
      objectId: actor.orgId,
      metadata: {
        status: health.status,
        managedBy: health.managedBy ?? null,
      },
    });
    return { health };
  });

  app.post("/api/admin/tenant-config/byo-storage/migrations", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    if (options.storageMigrationJobs === undefined) {
      return reply
        .code(503)
        .send(invalidRequest("Tenant storage migration jobs are not configured.", []));
    }
    const body = storageMigrationRequestBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant storage migration request.", body.error.issues));
    }

    const org = await options.store.findById(actor.orgId);
    if (org === null) {
      return reply.code(404).send(notFound("Tenant config not found."));
    }
    const sourceStorage = tenantStorageMigrationState(
      body.data.sourceStorage,
      currentTenantStorageMigrationState(org).managedBy,
    );
    const targetStorage = tenantStorageMigrationState(body.data.targetStorage, body.data.target);

    if (!body.data.dryRun) {
      try {
        assertLiveMigrationStorageStates({
          target: body.data.target,
          sourceStorage,
          targetStorage,
        });
      } catch (error) {
        const message =
          error instanceof Error && error.message.length > 0
            ? error.message
            : "Invalid live tenant storage migration snapshots.";
        return reply.code(409).send(conflict(message));
      }
    }
    const job = await options.storageMigrationJobs.create({
      orgId: actor.orgId,
      target: body.data.target,
      dryRun: body.data.dryRun,
      requestedByActorId: actor.id,
      sourceStorage,
      targetStorage,
    });

    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.tenant_config.byo_storage_migration_requested",
      objectType: "tenant_storage_migration_job",
      objectId: job.id,
      metadata: {
        target: job.target,
        dryRun: job.dryRun,
      },
    });
    return reply.code(202).send({ migration: tenantStorageMigrationJobView(job) });
  });

  app.get("/api/admin/tenant-config/byo-storage/migrations/:id", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    if (options.storageMigrationJobs === undefined) {
      return reply
        .code(503)
        .send(invalidRequest("Tenant storage migration jobs are not configured.", []));
    }
    const params = storageMigrationParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant storage migration id.", params.error.issues));
    }
    const job = await options.storageMigrationJobs.findByIdForOrg({
      id: params.data.id,
      orgId: actor.orgId,
    });
    if (job === null) {
      return reply.code(404).send(notFound("Tenant storage migration job not found."));
    }
    return { migration: tenantStorageMigrationJobView(job) };
  });

  app.post(
    "/api/admin/tenant-config/byo-storage/migrations/:id/cutover",
    async (request, reply) => {
      const actor = await options.actorFromRequest(request);
      if (!canWriteAdminConsole(actor)) {
        return sendForbidden(reply, adminConsoleWriteScope);
      }
      if (options.storageMigrationJobs === undefined) {
        return reply
          .code(503)
          .send(invalidRequest("Tenant storage migration jobs are not configured.", []));
      }
      const params = storageMigrationParams.safeParse(request.params);
      if (!params.success) {
        return reply
          .code(400)
          .send(invalidRequest("Invalid tenant storage migration id.", params.error.issues));
      }
      const body = storageMigrationCutoverBody.safeParse(request.body ?? {});
      if (!body.success) {
        return reply
          .code(400)
          .send(
            invalidRequest("Invalid tenant storage migration cutover request.", body.error.issues),
          );
      }
      const job = await options.storageMigrationJobs.findByIdForOrg({
        id: params.data.id,
        orgId: actor.orgId,
      });
      if (job === null) {
        return reply.code(404).send(notFound("Tenant storage migration job not found."));
      }
      const org = await options.store.findById(actor.orgId);
      if (org === null) {
        return reply.code(404).send(notFound("Tenant config not found."));
      }

      let storageConfig: JsonObject;
      try {
        storageConfig = cutoverStorageConfig(job);
        assertCurrentStorageMatchesCutoverJob(org, job, storageConfig);
      } catch (error) {
        const message =
          error instanceof Error && error.message.length > 0
            ? error.message
            : "Tenant storage migration is not ready for cutover.";
        return reply.code(409).send(conflict(message));
      }

      const featureFlags =
        job.target === "byo" && org.featureFlags.byo_storage !== true
          ? { ...org.featureFlags, byo_storage: true }
          : undefined;
      const updatedOrg = await options.store.updateTenantConfig({
        orgId: actor.orgId,
        byoConfig: {
          ...org.byoConfig,
          storage: storageConfig,
        },
        ...(featureFlags === undefined ? {} : { featureFlags }),
        changedByActorId: actor.id,
        reason: `tenant storage migration cutover: ${job.id}`,
      });
      if (updatedOrg === null) {
        return reply.code(404).send(notFound("Tenant config not found."));
      }

      await auditAdminAction(options.auditSink, {
        orgId: actor.orgId,
        actorId: actor.id,
        verb: "admin.tenant_config.byo_storage_migration_cutover",
        objectType: "tenant_storage_migration_job",
        objectId: job.id,
        metadata: {
          target: job.target,
          dryRun: job.dryRun,
          status: job.status,
        },
      });
      if (featureFlags !== undefined) {
        void options.featureFlagEvents
          ?.publish(`flags.changed.${actor.orgId}`, {
            orgId: actor.orgId,
            changedByActorId: actor.id,
            reason: `tenant storage migration cutover: ${job.id}`,
            keys: ["byo_storage"],
          })
          .catch((error: unknown) => {
            options.onFeatureFlagEventError?.(error);
          });
      }

      return {
        migration: tenantStorageMigrationJobView(job),
        tenantConfig: await tenantConfigView(updatedOrg, options.plans),
      };
    },
  );
}

async function tenantConfigView(
  org: OrgRecord,
  plans: Pick<PlanStore, "findById"> | undefined,
): Promise<TenantConfigAdminView> {
  const plan = plans === undefined ? null : await plans.findById(org.planId);
  const effective = buildEffectiveTenantConfig({ org, plan });
  return {
    orgId: org.id,
    byo: org.byoConfig,
    features: org.featureFlags,
    quotas: org.quotas,
    branding: org.branding,
    plan: planView(plan),
    effective: {
      byo: effective.byo,
      features: effective.features as JsonObject,
      quotas: effective.quotas as JsonObject,
      branding: effective.branding as JsonObject,
    },
  };
}

function planView(plan: PlanRecord | null): TenantConfigAdminView["plan"] {
  if (plan === null) {
    return null;
  }
  return {
    id: plan.id,
    displayName: plan.displayName,
    featureFlagsDefault: plan.featureFlagsDefault,
    quotasDefault: plan.quotasDefault,
  };
}

function tenantStorageMigrationJobView(
  job: TenantStorageMigrationJobRecord,
): Record<string, unknown> {
  return {
    id: job.id,
    orgId: job.orgId,
    target: job.target,
    status: job.status,
    dryRun: job.dryRun,
    sourceStorage: job.sourceStorage,
    targetStorage: job.targetStorage,
    plannedCount: job.plannedCount,
    copiedCount: job.copiedCount,
    verifiedCount: job.verifiedCount,
    failures: job.failures,
    lastError: job.lastError,
    attemptCount: job.attemptCount,
    requestedByActorId: job.requestedByActorId,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function tenantConfigSections(input: z.infer<typeof tenantConfigUpdateBody>): readonly string[] {
  return [
    ...(input.byo === undefined ? [] : ["byo"]),
    ...(input.features === undefined ? [] : ["features"]),
    ...(input.quotas === undefined ? [] : ["quotas"]),
    ...(input.branding === undefined ? [] : ["branding"]),
  ];
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function tenantStorageMigrationState(
  storage: z.infer<typeof byoStorageSchema> | undefined,
  fallback: "byo" | "helix-default",
): TenantStorageMigrationStorageState {
  if (storage === undefined) {
    return { managedBy: fallback, storage: null };
  }
  return {
    managedBy: storage.kind === "byo" ? "byo" : "helix-default",
    storage: toJsonObject(storage),
  };
}

function currentTenantStorageMigrationState(org: OrgRecord): TenantStorageMigrationStorageState {
  const storage = (org.byoConfig as { readonly storage?: unknown }).storage;
  const parsed = byoStorageSchema.safeParse(storage);
  if (!parsed.success) {
    return { managedBy: "helix-default", storage: null };
  }
  return tenantStorageMigrationState(parsed.data, "helix-default");
}

function cutoverStorageConfig(job: TenantStorageMigrationJobRecord): JsonObject {
  if (job.dryRun) {
    throw new Error("Dry-run tenant storage migrations cannot be cut over.");
  }
  if (job.status !== "succeeded") {
    throw new Error("Only succeeded tenant storage migrations can be cut over.");
  }
  if (job.completedAt === null) {
    throw new Error("Tenant storage migration must be completed before cutover.");
  }
  if (job.lastError !== null || job.failures.length > 0) {
    throw new Error("Tenant storage migration has unresolved errors.");
  }
  if (job.plannedCount !== job.copiedCount || job.plannedCount !== job.verifiedCount) {
    throw new Error("Tenant storage migration object counts are not fully verified.");
  }
  assertLiveMigrationStorageStates({
    target: job.target,
    sourceStorage: job.sourceStorage,
    targetStorage: job.targetStorage,
  });
  if (job.targetStorage === null) {
    throw new Error("Tenant storage migration is missing a target storage snapshot.");
  }
  if (job.target === "byo") {
    const parsed = byoStorageSchema.safeParse(job.targetStorage.storage);
    if (!parsed.success || parsed.data.kind !== "byo") {
      throw new Error("Tenant storage migration cutover requires a staged BYO target config.");
    }
    return toJsonObject(parsed.data);
  }
  if (job.targetStorage.storage === null) {
    return { kind: "helix-default", prefix: defaultTenantStoragePrefix(job.orgId) };
  }
  const parsed = byoStorageSchema.safeParse(job.targetStorage.storage);
  if (!parsed.success || parsed.data.kind !== "helix-default") {
    throw new Error(
      "Tenant storage migration cutover requires a staged Helix default target config.",
    );
  }
  return toJsonObject(parsed.data);
}

function assertCurrentStorageMatchesCutoverJob(
  org: OrgRecord,
  job: TenantStorageMigrationJobRecord,
  targetStorageConfig: JsonObject,
): void {
  const current = currentTenantStorageMigrationState(org);
  const target = tenantStorageMigrationState(
    byoStorageSchema.parse(targetStorageConfig),
    job.target,
  );
  if (storageStatesEqual(current, target)) {
    return;
  }
  if (!storageStatesEqual(current, job.sourceStorage)) {
    throw new Error("Tenant storage config changed after the migration job was created.");
  }
}

function storageStatesEqual(
  left: TenantStorageMigrationStorageState | null,
  right: TenantStorageMigrationStorageState | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unsafeStoragePrefix(value: string): boolean {
  const trimmed = value.trim().replace(/^\/+/u, "");
  return (
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    trimmed.includes("//") ||
    hasControlCharacter(trimmed)
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}
