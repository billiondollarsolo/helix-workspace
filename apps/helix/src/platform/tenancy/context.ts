import type { FastifyRequest } from "fastify";
import type { HelixConfig, TenantConfig } from "@helix/sdk-types";
import { isSingleTenant, resolveHelixMode } from "../mode/index.js";
import type { OrgRecord, OrgStore } from "./orgs.js";
import { buildEffectiveTenantConfig, type PlanStore } from "./plans.js";

export interface TenantContext {
  readonly orgId: string;
  readonly orgSlug: string;
  readonly orgTier: string;
  readonly orgRegion: string;
  readonly effectiveConfig: TenantConfig;
  readonly org: OrgRecord;
}

export interface TenantResolutionOptions {
  readonly config: Pick<HelixConfig, "mode">;
  readonly orgs: OrgStore;
  readonly plans?: PlanStore;
  readonly request: Pick<FastifyRequest, "headers" | "url" | "method">;
  readonly defaultOrg?: {
    readonly id?: string;
    readonly slug?: string;
    readonly displayName?: string;
    readonly region?: string;
  };
  readonly rootHosts?: readonly string[];
}

export class TenantResolutionError extends Error {
  constructor(
    readonly statusCode: 400 | 402 | 404 | 410 | 423,
    readonly code:
      | "tenant-required"
      | "tenant-not-found"
      | "tenant-suspended"
      | "tenant-soft-deleted"
      | "tenant-provisioning",
    message: string,
  ) {
    super(message);
    this.name = "TenantResolutionError";
  }
}

export async function resolveTenantContext(
  options: TenantResolutionOptions,
): Promise<TenantContext> {
  const mode = resolveHelixMode(options.config);
  const org = isSingleTenant(mode)
    ? await options.orgs.getOrCreateDefaultOrg(options.defaultOrg)
    : await resolveSaasOrg(options);

  if (org.status === "suspended" && !allowsSuspendedTenant(options.request)) {
    throw new TenantResolutionError(402, "tenant-suspended", `Tenant "${org.slug}" is suspended.`);
  }
  if (org.status === "provisioning") {
    throw new TenantResolutionError(
      423,
      "tenant-provisioning",
      `Tenant "${org.slug}" is still provisioning.`,
    );
  }
  if (org.status === "hard_deleted") {
    throw new TenantResolutionError(
      404,
      "tenant-not-found",
      `Tenant "${org.slug}" is not available.`,
    );
  }
  if (org.status === "soft_deleted" && !allowsSoftDeletedTenant(options.request)) {
    throw new TenantResolutionError(
      410,
      "tenant-soft-deleted",
      `Tenant "${org.slug}" is soft-deleted and available only for restore or export during the grace period.`,
    );
  }

  const plan = options.plans === undefined ? null : await options.plans.findById(org.planId);
  const effectiveConfig = buildEffectiveTenantConfig({ org, plan });

  return {
    orgId: org.id,
    orgSlug: org.slug,
    orgTier: org.tier,
    orgRegion: org.region,
    effectiveConfig,
    org,
  };
}

function allowsSuspendedTenant(request: Pick<FastifyRequest, "url" | "method">): boolean {
  const path = request.url.split("?")[0] ?? "/";
  return (
    (request.method === "POST" &&
      (/^\/api\/admin\/tenants\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/unsuspend$/u.test(path) ||
        /^\/api\/admin\/tenants\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/delete$/u.test(path))) ||
    isTenantExportRecoveryRoute(request, path)
  );
}

function allowsSoftDeletedTenant(request: Pick<FastifyRequest, "url" | "method">): boolean {
  const path = request.url.split("?")[0] ?? "/";
  return (
    (request.method === "POST" &&
      /^\/api\/admin\/tenants\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/restore$/u.test(path)) ||
    isTenantExportRecoveryRoute(request, path)
  );
}

function isTenantExportRecoveryRoute(
  request: Pick<FastifyRequest, "method">,
  path: string,
): boolean {
  if (request.method === "GET") {
    return (
      /^\/api\/admin\/tenants\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/export(?:\/manifest)?$/u.test(
        path,
      ) ||
      /^\/api\/admin\/tenants\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/export\/jobs(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/u.test(
        path,
      )
    );
  }
  return (
    request.method === "POST" &&
    (/^\/api\/admin\/tenants\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/export\/artifact$/u.test(
      path,
    ) ||
      /^\/api\/admin\/tenants\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/export\/jobs$/u.test(path))
  );
}

export function extractTenantSlug(
  request: Pick<FastifyRequest, "headers">,
  options: { readonly rootHosts?: readonly string[] } = {},
): string | null {
  const headerSlug = firstHeaderValue(request.headers["x-helix-tenant"]);
  if (headerSlug !== undefined && isValidTenantSlug(headerSlug)) {
    return headerSlug;
  }

  const host = firstHeaderValue(request.headers.host);
  if (host === undefined) {
    return null;
  }
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  if (hostname.length === 0 || hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/u.test(hostname)) {
    return null;
  }

  const rootHosts = options.rootHosts ?? ["helix.app"];
  for (const rootHost of rootHosts) {
    const normalizedRoot = rootHost.toLowerCase();
    if (!hostname.endsWith(`.${normalizedRoot}`)) {
      continue;
    }
    const prefix = hostname.slice(0, -(normalizedRoot.length + 1));
    const [candidate] = prefix.split(".");
    if (candidate !== undefined && isValidTenantSlug(candidate)) {
      return candidate;
    }
  }

  const [candidate] = hostname.split(".");
  return candidate !== undefined && isValidTenantSlug(candidate) ? candidate : null;
}

async function resolveSaasOrg(options: TenantResolutionOptions): Promise<OrgRecord> {
  const slug = extractTenantSlug(
    options.request,
    options.rootHosts === undefined ? {} : { rootHosts: options.rootHosts },
  );
  if (slug === null) {
    throw new TenantResolutionError(
      400,
      "tenant-required",
      "Tenant slug is required in multi-tenant SaaS mode.",
    );
  }
  const org = await options.orgs.findBySlug(slug);
  if (org === null) {
    throw new TenantResolutionError(404, "tenant-not-found", `Tenant "${slug}" was not found.`);
  }
  return org;
}

function firstHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function isValidTenantSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}
