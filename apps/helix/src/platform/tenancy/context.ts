import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { FastifyRequest } from "fastify";
import type { HelixConfig, TenantConfig } from "@helix/sdk-types";
import { isSingleTenant, resolveHelixMode } from "../mode/index.js";
import type { OrgRecord, OrgStore } from "./orgs.js";
import { buildEffectiveTenantConfig, type PlanStore } from "./plans.js";
import { assertTenantRegion } from "./residency.js";
import { resolveRequestOrgIdentity } from "./request-tenant-identity.js";

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
  readonly domains?: TenantDomainResolver;
  readonly proxyAssertion?: TenantProxyAssertionOptions;
  readonly deploymentRegion?: string;
}

interface TenantDomainResolver {
  findVerifiedOrgId(hostname: string): Promise<string | null>;
}

export interface TenantProxyAssertionOptions {
  readonly secret: string;
  readonly maxAgeSeconds?: number;
  readonly now?: () => Date;
}

export class TenantResolutionError extends Error {
  constructor(
    readonly statusCode: 400 | 402 | 404 | 410 | 421 | 423,
    readonly code:
      | "tenant-required"
      | "tenant-not-found"
      | "tenant-suspended"
      | "tenant-soft-deleted"
      | "tenant-provisioning"
      | "tenant-region-mismatch",
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

  if (options.deploymentRegion !== undefined) {
    try {
      assertTenantRegion(org.region, options.deploymentRegion);
    } catch {
      throw new TenantResolutionError(
        421,
        "tenant-region-mismatch",
        `Tenant "${org.slug}" must be served from its assigned region.`,
      );
    }
  }

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

  // G1.8 — Request-path org id must come from an explicitly resolved tenant
  // (mode-bound single-tenant org or SaaS slug/header), never from inventing a
  // tenant solely via HELIX_DEFAULT_ORG_ID when resolution failed. Single-tenant
  // mode already resolved `org` via getOrCreateDefaultOrg; SaaS via slug. Both
  // pass `resolvedTenantOrgId` so defaultOrgId cannot substitute.
  const requestOrgId = resolveRequestOrgIdentity({
    actorOrgId: undefined,
    resolvedTenantOrgId: org.id,
    defaultOrgId: options.defaultOrg?.id,
    bootstrapContext: false,
  });

  return {
    orgId: requestOrgId,
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
    (request.method === "GET" &&
      /^\/api\/admin\/tenants\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/export(?:\/manifest)?$/u.test(
        path,
      ))
  );
}

function allowsSoftDeletedTenant(request: Pick<FastifyRequest, "url" | "method">): boolean {
  const path = request.url.split("?")[0] ?? "/";
  return (
    (request.method === "POST" &&
      /^\/api\/admin\/tenants\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/restore$/u.test(path)) ||
    (request.method === "GET" &&
      /^\/api\/admin\/tenants\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/export(?:\/manifest)?$/u.test(
        path,
      ))
  );
}

export function extractTenantSlug(
  request: Pick<FastifyRequest, "headers" | "method" | "url">,
  options: {
    readonly rootHosts?: readonly string[];
    readonly proxyAssertion?: TenantProxyAssertionOptions;
  } = {},
): string | null {
  const headerSlug = firstHeaderValue(request.headers["x-helix-tenant"]);
  if (
    headerSlug !== undefined &&
    isValidTenantSlug(headerSlug) &&
    options.proxyAssertion !== undefined &&
    hasValidProxyAssertion(request, headerSlug, options.proxyAssertion)
  ) {
    return headerSlug;
  }

  const hostname = extractRequestHostname(request.headers.host);
  if (hostname === null) {
    return null;
  }

  for (const rootHost of options.rootHosts ?? []) {
    const normalizedRoot = normalizeConfiguredRootHost(rootHost);
    if (normalizedRoot === null) {
      continue;
    }
    if (!hostname.endsWith(`.${normalizedRoot}`)) {
      continue;
    }
    const prefix = hostname.slice(0, -(normalizedRoot.length + 1));
    if (!prefix.includes(".") && isValidTenantSlug(prefix)) {
      return prefix;
    }
  }
  return null;
}

async function resolveSaasOrg(options: TenantResolutionOptions): Promise<OrgRecord> {
  const slug = extractTenantSlug(options.request, {
    ...(options.rootHosts === undefined ? {} : { rootHosts: options.rootHosts }),
    ...(options.proxyAssertion === undefined ? {} : { proxyAssertion: options.proxyAssertion }),
  });
  const hostname = extractRequestHostname(options.request.headers.host);
  const org =
    slug === null
      ? hostname === null || options.domains === undefined
        ? null
        : await findOrgByVerifiedDomain(options, hostname)
      : await options.orgs.findBySlug(slug);
  if (slug === null && org === null) {
    throw new TenantResolutionError(
      400,
      "tenant-required",
      "Request host is not mapped to a tenant.",
    );
  }
  if (org === null) {
    throw new TenantResolutionError(404, "tenant-not-found", "Tenant was not found.");
  }
  return org;
}

async function findOrgByVerifiedDomain(
  options: TenantResolutionOptions,
  hostname: string,
): Promise<OrgRecord | null> {
  const orgId = await options.domains?.findVerifiedOrgId(hostname);
  return orgId === null || orgId === undefined ? null : options.orgs.findById(orgId);
}

export function signTenantProxyAssertion(input: {
  readonly secret: string;
  readonly timestamp: string;
  readonly method: string;
  readonly url: string;
  readonly host: string;
  readonly tenantSlug: string;
}): string {
  return createHmac("sha256", input.secret)
    .update(proxyAssertionPayload(input))
    .digest("base64url");
}

function hasValidProxyAssertion(
  request: Pick<FastifyRequest, "headers" | "method" | "url">,
  tenantSlug: string,
  options: TenantProxyAssertionOptions,
): boolean {
  if (options.secret.length < 32) {
    return false;
  }
  const timestamp = firstHeaderValue(request.headers["x-helix-tenant-timestamp"]);
  const signature = firstHeaderValue(request.headers["x-helix-tenant-signature"]);
  const host = firstHeaderValue(request.headers.host);
  if (timestamp === undefined || signature === undefined || host === undefined) {
    return false;
  }
  const seconds = Number(timestamp);
  const nowSeconds = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  if (
    !/^\d{10}$/u.test(timestamp) ||
    !Number.isSafeInteger(seconds) ||
    Math.abs(nowSeconds - seconds) > (options.maxAgeSeconds ?? 60)
  ) {
    return false;
  }
  const expected = signTenantProxyAssertion({
    secret: options.secret,
    timestamp,
    method: request.method,
    url: request.url,
    host,
    tenantSlug,
  });
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function proxyAssertionPayload(input: {
  readonly timestamp: string;
  readonly method: string;
  readonly url: string;
  readonly host: string;
  readonly tenantSlug: string;
}): string {
  return [
    "helix-tenant-v1",
    input.timestamp,
    input.method.toUpperCase(),
    input.url,
    input.host.toLowerCase(),
    input.tenantSlug,
  ].join("\n");
}

function extractRequestHostname(value: string | readonly string[] | undefined): string | null {
  const host = firstHeaderValue(value)?.trim();
  if (host === undefined || host.length === 0 || host.endsWith(".") || /[\s/@?#]/u.test(host)) {
    return null;
  }
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  const ascii = domainToASCII(hostname);
  return ascii === hostname && isValidHostname(hostname) ? hostname : null;
}

function normalizeConfiguredRootHost(value: string): string | null {
  return extractRequestHostname(value);
}

function isValidHostname(value: string): boolean {
  return (
    value !== "localhost" &&
    isIP(value) === 0 &&
    value.length <= 253 &&
    value.includes(".") &&
    value
      .split(".")
      .every(
        (label) =>
          label.length <= 63 &&
          !label.startsWith("xn--") &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  );
}

function firstHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function isValidTenantSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}
