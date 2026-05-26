import { Readable } from "node:stream";
import type { Actor, EventBus, TraceContext } from "@helix/sdk-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminWildcardScope,
  auditAdminAction,
  cursorQuerySchema,
  decodeCursor,
  invalidRequest,
  invalidCursor,
  limitQuerySchema,
  notFound,
  paginate,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import type { TenantHourlyQuotaExceeded, TenantHourlyQuotaLimiter } from "../limits/index.js";
import { emitTenantQuotaExceededEvent } from "../limits/quota-events.js";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
import {
  buildTenantExportArchive,
  buildTenantExportSelfFetchManifest,
  materializeTenantExportArchiveArtifact,
  presignTenantExportJobArtifact,
  streamTenantExportArchive,
  type TenantExportJobRecord,
  type TenantExportJobStatus,
  type TenantExportJobStore,
  type TenantExportManifestPlanner,
} from "./export.js";
import type { OrgRecord, OrgStore } from "./orgs.js";

export const adminTenantsExportScope = "admin.tenants.export";

export interface RegisterTenantExportRoutesOptions {
  readonly orgs: Pick<OrgStore, "findBySlug">;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly exportPlanner: TenantExportManifestPlanner;
  readonly exportJobs?: TenantExportJobStore | undefined;
  readonly storageResolver?: TenantStorageResolver | undefined;
  readonly auditSink?: AdminConsoleAuditSink | undefined;
  readonly exportJobLimiter?: TenantHourlyQuotaLimiter | undefined;
  readonly exportJobLimit?: (input: {
    readonly org: OrgRecord;
    readonly actor: Actor;
  }) => Promise<number | null | undefined> | number | null | undefined;
  readonly events?: Pick<EventBus, "publish"> | undefined;
  readonly onEventError?: (error: unknown) => void;
}

const tenantParams = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u),
});

const exportJobParams = tenantParams.extend({
  jobId: z.string().uuid(),
});

const manifestQuery = z.object({
  objectByteDelivery: z.enum(["metadata", "self-fetch"]).default("metadata"),
  presignedUrlExpiresSeconds: z
    .preprocess((value) => {
      if (typeof value !== "string" || value.trim().length === 0) {
        return undefined;
      }
      return Number(value);
    }, z.number().int().min(1).max(604_800))
    .optional(),
});

const exportQuery = z.object({
  includeObjectBytes: z
    .preprocess((value) => value === "true" || value === true, z.boolean())
    .default(false),
  objectByteDelivery: z.enum(["archive", "self-fetch"]).default("archive"),
  presignedUrlExpiresSeconds: z
    .preprocess((value) => {
      if (typeof value !== "string" || value.trim().length === 0) {
        return undefined;
      }
      return Number(value);
    }, z.number().int().min(1).max(604_800))
    .optional(),
});

const exportArtifactBody = z
  .object({
    includeObjectBytes: z.boolean().default(true),
    presignedUrlExpiresSeconds: z.number().int().min(1).max(604_800).optional(),
  })
  .default({});

const exportJobListQuery = z.object({
  limit: limitQuerySchema,
  cursor: cursorQuerySchema,
  status: z.enum(["queued", "running", "succeeded", "failed"]).optional(),
});

export async function registerTenantExportRoutes(
  app: FastifyInstance,
  options: RegisterTenantExportRoutesOptions,
): Promise<void> {
  app.get("/api/admin/tenants/:slug/export/manifest", async (request, reply) => {
    const loaded = await loadTenantForExport({ request, reply, options });
    if (loaded === undefined) {
      return reply;
    }
    const query = manifestQuery.safeParse(request.query ?? {});
    if (!query.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant export manifest query.", query.error.issues));
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
      return sendQuotaExceeded(reply, quotaDecision);
    }

    const manifest = await options.exportPlanner(loaded.org);
    const delivery =
      query.data.objectByteDelivery === "self-fetch"
        ? await safeBuildExportDelivery(reply, () =>
            buildTenantExportSelfFetchManifest(manifest, {
              presignedUrlExpiresSeconds: query.data.presignedUrlExpiresSeconds,
              storageResolver: options.storageResolver,
            }),
          )
        : undefined;
    if (delivery === "unavailable") {
      return reply;
    }
    await auditAdminAction(options.auditSink, {
      orgId: loaded.org.id,
      actorId: loaded.actor.id,
      verb: "tenant.export.planned",
      objectType: "tenant",
      objectId: loaded.org.id,
      metadata: {
        ...exportAuditMetadata({ org: loaded.org, manifest, request }),
        objectByteDelivery: query.data.objectByteDelivery,
      },
    });
    return delivery === undefined ? { manifest } : { manifest, delivery };
  });

  app.get("/api/admin/tenants/:slug/export", async (request, reply) => {
    const loaded = await loadTenantForExport({ request, reply, options });
    if (loaded === undefined) {
      return reply;
    }
    const query = exportQuery.safeParse(request.query ?? {});
    if (!query.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant export query.", query.error.issues));
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
      return sendQuotaExceeded(reply, quotaDecision);
    }

    const manifest = await options.exportPlanner(loaded.org);
    if (
      request.headers.range === undefined &&
      query.data.includeObjectBytes &&
      query.data.objectByteDelivery === "archive"
    ) {
      const archive = await safeBuildExportDelivery(reply, () =>
        streamTenantExportArchive(manifest, {
          includeObjectBytes: true,
          objectByteDelivery: "archive",
          storageResolver: options.storageResolver,
        }),
      );
      if (archive === "unavailable") {
        return reply;
      }
      await auditAdminAction(options.auditSink, {
        orgId: loaded.org.id,
        actorId: loaded.actor.id,
        verb: "tenant.exported",
        objectType: "tenant",
        objectId: loaded.org.id,
        metadata: {
          ...exportAuditMetadata({ org: loaded.org, manifest, request }),
          filename: archive.filename,
          byteSize: archive.byteSize,
          bytesIncluded: true,
          objectByteDelivery: "archive",
          streaming: true,
        },
      });
      return reply
        .header("accept-ranges", "bytes")
        .header("content-disposition", `attachment; filename="${archive.filename}"`)
        .header("content-length", String(archive.byteSize))
        .type(archive.contentType)
        .send(Readable.from(archive.body));
    }

    const archive = await safeBuildExportDelivery(reply, () =>
      buildTenantExportArchive(manifest, {
        includeObjectBytes: query.data.includeObjectBytes,
        objectByteDelivery: query.data.objectByteDelivery,
        presignedUrlExpiresSeconds: query.data.presignedUrlExpiresSeconds,
        storageResolver: options.storageResolver,
      }),
    );
    if (archive === "unavailable") {
      return reply;
    }
    const range = parseByteRange(request.headers.range, archive.byteSize);
    const archiveByteSize = String(archive.byteSize);
    if (range?.satisfiable === false) {
      return reply
        .code(416)
        .header("accept-ranges", "bytes")
        .header("content-range", `bytes */${archiveByteSize}`)
        .send({
          error: "Requested tenant export byte range is not satisfiable.",
          code: "range_not_satisfiable",
        });
    }
    await auditAdminAction(options.auditSink, {
      orgId: loaded.org.id,
      actorId: loaded.actor.id,
      verb: "tenant.exported",
      objectType: "tenant",
      objectId: loaded.org.id,
      metadata: {
        ...exportAuditMetadata({ org: loaded.org, manifest, request }),
        filename: archive.filename,
        byteSize: archive.byteSize,
        bytesIncluded: query.data.includeObjectBytes && query.data.objectByteDelivery === "archive",
        objectByteDelivery: query.data.objectByteDelivery,
        ...(range?.satisfiable === true
          ? { range: { start: range.start, end: range.end, size: archive.byteSize } }
          : {}),
      },
    });
    if (range?.satisfiable === true) {
      const bytes = archive.bytes.subarray(range.start, range.end + 1);
      return reply
        .code(206)
        .header("accept-ranges", "bytes")
        .header("content-disposition", `attachment; filename="${archive.filename}"`)
        .header("content-length", String(bytes.byteLength))
        .header(
          "content-range",
          `bytes ${String(range.start)}-${String(range.end)}/${archiveByteSize}`,
        )
        .type(archive.contentType)
        .send(bytes);
    }

    return reply
      .header("accept-ranges", "bytes")
      .header("content-disposition", `attachment; filename="${archive.filename}"`)
      .header("content-length", String(archive.byteSize))
      .type(archive.contentType)
      .send(archive.bytes);
  });

  app.post("/api/admin/tenants/:slug/export/jobs", async (request, reply) => {
    const loaded = await loadTenantForExport({ request, reply, options });
    if (loaded === undefined) {
      return reply;
    }
    if (options.exportJobs === undefined) {
      return reply.code(503).send(invalidRequest("Tenant export jobs are not configured.", []));
    }
    const body = exportArtifactBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant export job request.", body.error.issues));
    }
    const quotaDecision = await consumeTenantExportQuota({
      limiter: options.exportJobLimiter,
      limit: options.exportJobLimit,
      org: loaded.org,
      actor: loaded.actor,
      events: options.events,
      onEventError: options.onEventError,
      trace: (request as { readonly trace?: TraceContext }).trace,
      surface: "tenant.export.job",
    });
    if (quotaDecision !== undefined) {
      return sendQuotaExceeded(reply, quotaDecision);
    }

    const job = await options.exportJobs.create({
      orgId: loaded.org.id,
      includeObjectBytes: body.data.includeObjectBytes,
      presignedUrlExpiresSeconds: body.data.presignedUrlExpiresSeconds,
      requestedByActorId: loaded.actor.id,
    });
    await auditAdminAction(options.auditSink, {
      orgId: loaded.org.id,
      actorId: loaded.actor.id,
      verb: "tenant.export.job.queued",
      objectType: "tenant_export_job",
      objectId: job.id,
      metadata: {
        slug: loaded.org.slug,
        includeObjectBytes: job.includeObjectBytes,
        presignedUrlExpiresSeconds: job.presignedUrlExpiresSeconds,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      },
    });
    return reply.code(202).send({ exportJob: tenantExportJobView(job) });
  });

  app.get("/api/admin/tenants/:slug/export/jobs", async (request, reply) => {
    const loaded = await loadTenantForExport({ request, reply, options });
    if (loaded === undefined) {
      return reply;
    }
    if (options.exportJobs === undefined) {
      return reply.code(503).send(invalidRequest("Tenant export jobs are not configured.", []));
    }
    const query = exportJobListQuery.safeParse(request.query ?? {});
    if (!query.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant export job list request.", query.error.issues));
    }
    const cursor = query.data.cursor === undefined ? undefined : decodeCursor(query.data.cursor);
    if (cursor === null) {
      return reply.code(400).send(invalidCursor());
    }
    const limit = query.data.limit;
    const jobs = await options.exportJobs.listForOrg({
      orgId: loaded.org.id,
      limit: limit + 1,
      ...(cursor === undefined ? {} : { cursor }),
      ...(query.data.status === undefined ? {} : { status: query.data.status }),
    });
    const page = paginate(
      jobs.map((job) => tenantExportJobView(job)),
      limit,
    );
    return { exportJobs: page.items, nextCursor: page.nextCursor };
  });

  app.get("/api/admin/tenants/:slug/export/jobs/:jobId", async (request, reply) => {
    const loaded = await loadTenantForExport({ request, reply, options });
    if (loaded === undefined) {
      return reply;
    }
    if (options.exportJobs === undefined) {
      return reply.code(503).send(invalidRequest("Tenant export jobs are not configured.", []));
    }
    const params = exportJobParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant export job id.", params.error.issues));
    }
    const job = await options.exportJobs.findByIdForOrg({
      id: params.data.jobId,
      orgId: loaded.org.id,
    });
    if (job === null) {
      return reply.code(404).send(notFound("Tenant export job not found."));
    }
    const artifact = await safeBuildExportDelivery(reply, () =>
      presignTenantExportJobArtifact(job, { storageResolver: options.storageResolver }),
    );
    if (artifact === "unavailable") {
      return reply;
    }
    return { exportJob: tenantExportJobView(job, artifact) };
  });

  app.post("/api/admin/tenants/:slug/export/artifact", async (request, reply) => {
    const loaded = await loadTenantForExport({ request, reply, options });
    if (loaded === undefined) {
      return reply;
    }
    const body = exportArtifactBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .send(invalidRequest("Invalid tenant export artifact request.", body.error.issues));
    }
    const quotaDecision = await consumeTenantExportQuota({
      limiter: options.exportJobLimiter,
      limit: options.exportJobLimit,
      org: loaded.org,
      actor: loaded.actor,
      events: options.events,
      onEventError: options.onEventError,
      trace: (request as { readonly trace?: TraceContext }).trace,
      surface: "tenant.export.artifact",
    });
    if (quotaDecision !== undefined) {
      return sendQuotaExceeded(reply, quotaDecision);
    }

    const manifest = await options.exportPlanner(loaded.org);
    const artifact = await safeBuildExportDelivery(reply, () =>
      materializeTenantExportArchiveArtifact(manifest, {
        includeObjectBytes: body.data.includeObjectBytes,
        objectByteDelivery: "archive",
        presignedUrlExpiresSeconds: body.data.presignedUrlExpiresSeconds,
        storageResolver: options.storageResolver,
      }),
    );
    if (artifact === "unavailable") {
      return reply;
    }
    await auditAdminAction(options.auditSink, {
      orgId: loaded.org.id,
      actorId: loaded.actor.id,
      verb: "tenant.export.artifact.created",
      objectType: "tenant",
      objectId: loaded.org.id,
      metadata: {
        ...exportAuditMetadata({ org: loaded.org, manifest, request }),
        filename: artifact.filename,
        byteSize: artifact.byteSize,
        storageKey: artifact.storageKey,
        bytesIncluded: body.data.includeObjectBytes,
        objectByteDelivery: "archive",
        presignedUrlExpiresSeconds: artifact.expiresSeconds,
      },
    });
    return reply.code(201).send({ manifest, artifact });
  });
}

async function loadTenantForExport(input: {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly options: RegisterTenantExportRoutesOptions;
}): Promise<{ readonly actor: Actor; readonly org: OrgRecord } | undefined> {
  const actor = await input.options.actorFromRequest(input.request);
  if (!hasExportScope(actor)) {
    sendExportForbidden(input.reply);
    return undefined;
  }
  const params = tenantParams.safeParse(input.request.params);
  if (!params.success) {
    input.reply.code(400).send(invalidRequest("Invalid tenant export slug.", params.error.issues));
    return undefined;
  }
  const org = await input.options.orgs.findBySlug(params.data.slug);
  if (org === null) {
    input.reply.code(404).send(notFound("Tenant not found."));
    return undefined;
  }
  if (org.id !== actor.orgId) {
    sendExportForbidden(input.reply);
    return undefined;
  }
  return { actor, org };
}

async function consumeTenantExportQuota(input: {
  readonly limiter?: TenantHourlyQuotaLimiter | undefined;
  readonly limit?: RegisterTenantExportRoutesOptions["exportJobLimit"];
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
    metadata: { slug: input.org.slug },
  });
  return decision;
}

function sendQuotaExceeded(reply: FastifyReply, decision: TenantHourlyQuotaExceeded): FastifyReply {
  reply.header("retry-after", String(decision.retryAfterSeconds));
  return reply.code(429).send({
    error: "Tenant export job quota exceeded.",
    code: "quota_exceeded",
    quota: decision.quota,
    limit: decision.limit,
    used: decision.used,
    retryAfterSeconds: decision.retryAfterSeconds,
    resetsAt: decision.resetsAt,
  });
}

interface TenantExportJobView {
  readonly id: string;
  readonly orgId: string;
  readonly status: TenantExportJobStatus;
  readonly includeObjectBytes: boolean;
  readonly presignedUrlExpiresSeconds: number;
  readonly requestedByActorId: string | null;
  readonly artifact: TenantExportJobArtifactView | null;
  readonly lastError: string | null;
  readonly attemptCount: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TenantExportJobArtifactView {
  readonly filename: string;
  readonly contentType: "application/x-tar";
  readonly byteSize: number;
  readonly storageKey: string;
  readonly downloadUrl?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly expiresSeconds?: number | undefined;
}

function tenantExportJobView(
  job: TenantExportJobRecord,
  artifact?: Awaited<ReturnType<typeof presignTenantExportJobArtifact>>,
): TenantExportJobView {
  const artifactView =
    artifact === undefined
      ? tenantExportJobStoredArtifactView(job)
      : {
          filename: artifact.filename,
          contentType: artifact.contentType,
          byteSize: artifact.byteSize,
          storageKey: artifact.storageKey,
          downloadUrl: artifact.downloadUrl,
          expiresAt: artifact.expiresAt,
          expiresSeconds: artifact.expiresSeconds,
        };
  return {
    id: job.id,
    orgId: job.orgId,
    status: job.status,
    includeObjectBytes: job.includeObjectBytes,
    presignedUrlExpiresSeconds: job.presignedUrlExpiresSeconds,
    requestedByActorId: job.requestedByActorId,
    artifact: artifactView,
    lastError: job.lastError,
    attemptCount: job.attemptCount,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function tenantExportJobStoredArtifactView(
  job: TenantExportJobRecord,
): TenantExportJobArtifactView | null {
  if (
    job.storageKey === null ||
    job.filename === null ||
    job.contentType === null ||
    job.byteSize === null
  ) {
    return null;
  }
  return {
    filename: job.filename,
    contentType: job.contentType,
    byteSize: job.byteSize,
    storageKey: job.storageKey,
  };
}

type ParsedByteRange =
  | { readonly satisfiable: true; readonly start: number; readonly end: number }
  | { readonly satisfiable: false };

function parseByteRange(
  header: string | string[] | undefined,
  size: number,
): ParsedByteRange | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) {
    return undefined;
  }
  if (size <= 0) {
    return { satisfiable: false };
  }
  const match = /^bytes=(?<start>\d*)-(?<end>\d*)$/u.exec(value.trim());
  if (match === null) {
    return { satisfiable: false };
  }
  const startText = match.groups?.["start"] ?? "";
  const endText = match.groups?.["end"] ?? "";
  if (startText.length === 0 && endText.length === 0) {
    return { satisfiable: false };
  }
  if (startText.length === 0) {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { satisfiable: false };
    }
    const start = Math.max(size - suffixLength, 0);
    return { satisfiable: true, start, end: size - 1 };
  }
  const start = Number.parseInt(startText, 10);
  const requestedEnd = endText.length === 0 ? size - 1 : Number.parseInt(endText, 10);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    requestedEnd < start ||
    start >= size
  ) {
    return { satisfiable: false };
  }
  return { satisfiable: true, start, end: Math.min(requestedEnd, size - 1) };
}

async function safeBuildExportDelivery<T>(
  reply: FastifyReply,
  build: () => Promise<T>,
): Promise<T | "unavailable"> {
  try {
    return await build();
  } catch (error) {
    if (isTenantExportDeliveryUnavailable(error)) {
      reply.code(503).send({
        error: error.message,
        code: "tenant_export_delivery_unavailable",
      });
      return "unavailable";
    }
    throw error;
  }
}

function isTenantExportDeliveryUnavailable(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.startsWith("Tenant storage resolver") ||
    error.message.startsWith("Tenant export storage does not support") ||
    error.message.startsWith("Tenant export object bytes are unavailable")
  );
}

function exportAuditMetadata(input: {
  readonly org: OrgRecord;
  readonly manifest: Awaited<ReturnType<TenantExportManifestPlanner>>;
  readonly request: FastifyRequest;
}): Record<string, unknown> {
  return {
    slug: input.org.slug,
    objectCount: input.manifest.objectInventory.objectCount,
    totalKnownBytes: input.manifest.objectInventory.totalKnownBytes,
    tableCount: input.manifest.postgres.rowCounts.length,
    auditRowCount: input.manifest.auditLog.rowCount,
    ip: input.request.ip,
    userAgent: input.request.headers["user-agent"] ?? null,
  };
}

function hasExportScope(actor: Actor): boolean {
  const scopes = actor.scopes ?? [];
  return scopes.includes(adminWildcardScope) || scopes.includes(adminTenantsExportScope);
}

function sendExportForbidden(reply: FastifyReply): void {
  reply.code(403).send({
    error: "Tenant export permission denied.",
    code: "forbidden",
    requiredScope: adminTenantsExportScope,
  });
}
