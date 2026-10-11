import type { Actor, JsonObject, StorageClient } from "@helix/sdk-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DlpGuard } from "../../dlp.js";
import type { TenantContext } from "../../tenancy/context.js";
import {
  detachedFromTenantPostgresContext,
  setTenantPostgresActorId,
} from "../../tenancy/postgres-roles.js";
import { createWebDavRateLimiter, type WebDavRateLimiter } from "../webdav-security.js";
import type { DriveS3AccessKeyRecord, DriveS3AccessKeyStore } from "./access-keys.js";
import { DRIVE_S3_BUCKETS, resolveDriveS3Bucket } from "./buckets.js";
import type { DriveS3Context, DriveS3Limits } from "./context.js";
import type { DriveS3Store } from "./drive-access.js";
import type { DriveS3FolderTransaction } from "./folder-transaction.js";
import { S3Error, s3ErrorXml, toS3Error } from "./errors.js";
import type { DriveS3MultipartStore } from "./multipart-store.js";
import { classifyDriveS3Operation, type DriveS3Operation } from "./operations.js";
import {
  authenticateDriveS3Request,
  authorizeDriveS3Scope,
  DRIVE_S3_ROUTE_PREFIX,
  parseDriveS3Target,
  type DriveS3Target,
} from "./request.js";

/** Audit sink; structurally compatible with the platform audit store. */
export interface DriveS3AuditSink {
  append(record: {
    readonly orgId: string;
    readonly actorId: string | null;
    readonly verb: string;
    readonly objectType: string;
    readonly objectId?: string;
    readonly trace?: { readonly traceId?: string };
    readonly metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface DriveS3GatewayOptions {
  readonly store: DriveS3Store;
  readonly accessKeys: DriveS3AccessKeyStore;
  readonly multipart: DriveS3MultipartStore;
  readonly resolveStorage: (orgId: string) => Promise<StorageClient | undefined>;
  readonly audit: DriveS3AuditSink;
  /** The org's `drive_s3_api` setting. */
  readonly isEnabled: (request: FastifyRequest, orgId: string) => boolean | Promise<boolean>;
  /** Org slug for tenant-qualified bucket aliases when the request has no tenant context. */
  readonly resolveOrgSlug?: (orgId: string) => Promise<string | undefined>;
  readonly dlp?: DlpGuard;
  /** Prefix the public URL carries in front of `/s3` (the API version, `/v1`). */
  readonly publicPrefix?: string;
  readonly region?: string;
  readonly limits?: Partial<DriveS3Limits>;
  readonly requireTls?: boolean;
  readonly rateLimiter?: WebDavRateLimiter;
  readonly now?: () => Date;
  /** Runs folder work in a fresh, committed tenant transaction (see folder-transaction.ts). */
  readonly inOwnTenantTransaction?: DriveS3FolderTransaction;
}

const DEFAULT_LIMITS: DriveS3Limits = {
  maxObjectBytes: 128 * 1024 * 1024,
  minPartBytes: 5 * 1024 * 1024,
  multipartTtlMs: 7 * 24 * 60 * 60 * 1000,
  maxOpenMultipartUploads: 100,
};

export const DRIVE_S3_DISABLED_MESSAGE =
  "The S3 API is turned off for this organization. An admin can turn on “Drive S3 API” (drive_s3_api) in Admin → Tenant settings.";

/**
 * Registers the S3-compatible Drive gateway under `/s3` in an encapsulated
 * scope: raw request bodies (no JSON parsing) and S3 XML errors that never
 * reach the JSON API error envelope.
 */
export async function registerDriveS3Gateway(
  app: FastifyInstance,
  options: DriveS3GatewayOptions,
): Promise<void> {
  const resolved = {
    ...options,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    rateLimiter: options.rateLimiter ?? createWebDavRateLimiter(),
    publicPrefix: options.publicPrefix ?? "",
    region: options.region ?? "us-east-1",
    now: options.now ?? (() => new Date()),
  };
  await app.register(async (s3) => {
    s3.removeAllContentTypeParsers();
    s3.addContentTypeParser("*", (_request, payload, done) => {
      done(null, payload);
    });
    s3.setErrorHandler(async (error, request, reply) => {
      await sendS3Error(request, reply, toS3Error(error));
    });
    const handler = (request: FastifyRequest, reply: FastifyReply) =>
      handleDriveS3Request(request, reply, resolved);
    for (const url of [DRIVE_S3_ROUTE_PREFIX, `${DRIVE_S3_ROUTE_PREFIX}/*`]) {
      s3.route({
        method: ["GET", "HEAD", "PUT", "POST", "DELETE"],
        url,
        exposeHeadRoute: false,
        handler,
      });
    }
  });
}

type ResolvedOptions = DriveS3GatewayOptions & {
  readonly limits: DriveS3Limits;
  readonly rateLimiter: WebDavRateLimiter;
  readonly publicPrefix: string;
  readonly region: string;
  readonly now: () => Date;
};

function requestTenant(request: FastifyRequest): TenantContext | null {
  return (request as { readonly tenant?: TenantContext | null }).tenant ?? null;
}

/**
 * Waits for the reply: an async route handler that resolves before a slow
 * onSend hook (the tenant transaction commit) finishes would otherwise make
 * Fastify send again with no payload and drop the XML error body.
 */
async function sendS3Error(
  request: FastifyRequest,
  reply: FastifyReply,
  error: S3Error,
): Promise<void> {
  if (reply.sent) return;
  if (error.retryAfterSeconds !== undefined) {
    reply.header("retry-after", String(error.retryAfterSeconds));
  }
  reply
    .code(error.statusCode)
    .header("x-amz-request-id", request.id)
    .header("x-amz-error-code", error.code);
  if (request.method === "HEAD") {
    await reply.send();
    return;
  }
  const resource = (request.url.split("?")[0] ?? "").slice(DRIVE_S3_ROUTE_PREFIX.length) || "/";
  await reply.type("application/xml").send(s3ErrorXml(error, resource, request.id));
}

async function handleDriveS3Request(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ResolvedOptions,
): Promise<void> {
  reply.header("x-amz-request-id", request.id);
  let operation: DriveS3Operation | undefined;
  let key: DriveS3AccessKeyRecord | undefined;
  let actor: Actor | undefined;
  let target: DriveS3Target | undefined;
  try {
    if (options.requireTls === true && request.protocol !== "https") {
      throw new S3Error("InvalidRequest", "The S3 API requires HTTPS.");
    }
    target = parseDriveS3Target(request.url);
    operation = classifyDriveS3Operation(request.method, target, request.headers);
    const authentication = await authenticateDriveS3Request({
      method: request.method,
      target,
      headers: request.headers,
      ip: request.ip,
      publicPrefix: options.publicPrefix,
      accessKeys: options.accessKeys,
      rateLimiter: options.rateLimiter,
      now: options.now(),
    });
    key = authentication.authenticated.key;
    const tenant = requestTenant(request);
    if (tenant !== null && tenant.orgId !== key.orgId) {
      throw new S3Error(
        "InvalidAccessKeyId",
        "This access key belongs to a different organization than this endpoint.",
      );
    }
    if (!(await options.isEnabled(request, key.orgId))) {
      throw new S3Error("AccessDenied", DRIVE_S3_DISABLED_MESSAGE);
    }
    actor = authorizeDriveS3Scope(authentication, operation.scope, options.rateLimiter);
    await setTenantPostgresActorId(actor.id);
    const orgSlug = tenant?.orgSlug ?? (await options.resolveOrgSlug?.(actor.orgId));
    const bucket =
      target.bucket === undefined
        ? DRIVE_S3_BUCKETS["my-drive"]
        : resolveDriveS3Bucket(target.bucket, orgSlug);
    const context: DriveS3Context = {
      store: options.store,
      actor,
      bucket,
      dlp: options.dlp,
      traceId: request.id,
      request,
      reply,
      target,
      authentication,
      headers: authentication.verified.headers,
      limits: options.limits,
      region: options.region,
      multipart: options.multipart,
      resolveStorage: options.resolveStorage,
      inOwnTransaction: ownTransactionFor(options, actor),
    };
    const result = await operation.run(context, orgSlug);
    await audit(options, request, reply, {
      key,
      actorId: actor.id,
      operation,
      target,
      outcome: "success",
      ...(result.objectId === undefined || result.objectId === null
        ? {}
        : { objectId: result.objectId }),
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    });
  } catch (error) {
    const s3Error = toS3Error(error);
    if (s3Error.code === "InternalError") {
      request.log.error({ err: error }, "Drive S3 gateway request failed");
    }
    if (key !== undefined && operation !== undefined && target !== undefined) {
      await audit(options, request, reply, {
        key,
        actorId: actor?.id ?? key.actorId,
        operation,
        target,
        outcome: "denied",
        detail: { code: s3Error.code },
      }).catch((auditError: unknown) => {
        request.log.error({ err: auditError }, "Drive S3 gateway audit failed");
      });
    }
    await sendS3Error(request, reply, s3Error);
  }
}

function ownTransactionFor(
  options: ResolvedOptions,
  actor: Actor,
): DriveS3Context["inOwnTransaction"] {
  const run = options.inOwnTenantTransaction;
  if (run === undefined) return undefined;
  return (work) => run({ orgId: actor.orgId, actorId: actor.id }, work);
}

async function audit(
  options: ResolvedOptions,
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    readonly key: DriveS3AccessKeyRecord;
    readonly actorId: string;
    readonly operation: DriveS3Operation;
    readonly target: DriveS3Target;
    readonly outcome: "success" | "denied";
    readonly objectId?: string;
    readonly detail?: JsonObject;
  },
): Promise<void> {
  const record = {
    orgId: input.key.orgId,
    actorId: input.actorId,
    verb: `drive.s3.${input.operation.verb}${input.outcome === "success" ? "" : ".denied"}`,
    objectType: input.objectId === undefined ? "drive.s3" : "drive.object",
    ...(input.objectId === undefined ? {} : { objectId: input.objectId }),
    trace: { traceId: request.id },
    metadata: {
      operation: input.operation.name,
      credentialType: "drive_s3_access_key",
      accessKeyId: input.key.accessKeyId,
      bucket: input.target.bucket ?? null,
      key: input.target.key.length === 0 ? null : input.target.key,
      ip: request.ip,
      ...(input.detail ?? {}),
    },
  };
  await afterReplySafe(reply, () => options.audit.append(record));
}

/**
 * Operations send their own reply, and sending commits the request's tenant
 * transaction (the tenancy onSend hook). Work that runs after that must not
 * reuse the finished transaction, so it runs on its own connection; the audit
 * store sets its own tenant context.
 */
export function afterReplySafe<T>(
  reply: Pick<FastifyReply, "sent">,
  work: () => Promise<T>,
): Promise<T> {
  return reply.sent ? detachedFromTenantPostgresContext(work) : work();
}
