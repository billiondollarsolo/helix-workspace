/**
 * G1.8 — Request-path tenant identity must not silently fall back to the
 * bootstrap default organization. `HELIX_DEFAULT_ORG_ID` remains valid for
 * single-org *bootstrap/provisioning* only, never as an unauthenticated
 * request-tenant substitute.
 */

export class RequestTenantIdentityError extends Error {
  readonly statusCode = 400;
  readonly code = "request-tenant-identity";

  constructor(message: string) {
    super(message);
    this.name = "RequestTenantIdentityError";
  }
}

export interface ResolveRequestOrgIdentityInput {
  /** Authenticated actor org (session or credential). */
  readonly actorOrgId: string | undefined;
  /** Explicit tenant slug/id resolution already performed from host/header. */
  readonly resolvedTenantOrgId: string | undefined;
  /** Bootstrap default org id from env — allowed only for bootstrap contexts. */
  readonly defaultOrgId: string | undefined;
  /**
   * True only for boot/seed paths that intentionally create the default org.
   * Must never be true for normal HTTP/tool request handling.
   */
  readonly bootstrapContext?: boolean;
}

/**
 * Resolve the org id that may be used for a *request*. Prefer the authenticated
 * actor org; otherwise use an explicitly resolved tenant. Refuse to invent a
 * tenant from the bootstrap default org outside bootstrap contexts.
 */
export function resolveRequestOrgIdentity(input: ResolveRequestOrgIdentityInput): string {
  if (input.actorOrgId !== undefined && input.actorOrgId.length > 0) {
    if (
      input.resolvedTenantOrgId !== undefined &&
      input.resolvedTenantOrgId.length > 0 &&
      input.resolvedTenantOrgId !== input.actorOrgId
    ) {
      throw new RequestTenantIdentityError(
        "Authenticated actor org does not match the resolved request tenant.",
      );
    }
    return input.actorOrgId;
  }

  if (input.resolvedTenantOrgId !== undefined && input.resolvedTenantOrgId.length > 0) {
    return input.resolvedTenantOrgId;
  }

  if (input.bootstrapContext === true) {
    if (input.defaultOrgId !== undefined && input.defaultOrgId.length > 0) {
      return input.defaultOrgId;
    }
    throw new RequestTenantIdentityError(
      "Bootstrap context requires HELIX_DEFAULT_ORG_ID (or equivalent) to be set.",
    );
  }

  throw new RequestTenantIdentityError(
    "Request tenant identity cannot fall back to the bootstrap default organization; authenticate or resolve an explicit tenant.",
  );
}

/** True when the only candidate identity is the bootstrap default org id. */
export function isDefaultOrgOnlyIdentity(input: {
  readonly actorOrgId: string | undefined;
  readonly resolvedTenantOrgId: string | undefined;
  readonly defaultOrgId: string | undefined;
}): boolean {
  if (input.actorOrgId !== undefined && input.actorOrgId.length > 0) {
    return false;
  }
  if (input.resolvedTenantOrgId !== undefined && input.resolvedTenantOrgId.length > 0) {
    return false;
  }
  return input.defaultOrgId !== undefined && input.defaultOrgId.length > 0;
}
