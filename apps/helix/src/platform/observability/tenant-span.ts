import { trace, type Context, type Span } from "@opentelemetry/api";
import type { ReadableSpan, Span as SdkSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { TenantContext } from "../tenancy/context.js";

export type TenantSpanContext = Pick<TenantContext, "orgId"> &
  Partial<Pick<TenantContext, "orgSlug" | "orgTier" | "orgRegion">>;

const tenantAttributeKeys = [
  "org_id",
  "helix.tenant.org_id",
  "helix.tenant.slug",
  "helix.tenant.tier",
  "helix.tenant.region",
] as const;

/**
 * Attach the resolved tenant to the active request span.
 *
 * `org_id` is intentionally plain for dashboard/query ergonomics; the
 * namespaced attributes carry the same tenant dimensions for Helix-specific
 * filtering without relying on HTTP labels.
 */
export function enrichActiveSpanWithTenant(tenant: TenantSpanContext): boolean {
  const span = trace.getActiveSpan();
  if (span === undefined) {
    return false;
  }
  setSpanTenantAttributes(span, tenant);
  return true;
}

export function setSpanTenantAttributes(span: Span, tenant: TenantSpanContext): void {
  span.setAttribute("org_id", tenant.orgId);
  span.setAttribute("helix.tenant.org_id", tenant.orgId);
  if (tenant.orgSlug !== undefined) {
    span.setAttribute("helix.tenant.slug", tenant.orgSlug);
  }
  if (tenant.orgTier !== undefined) {
    span.setAttribute("helix.tenant.tier", tenant.orgTier);
  }
  if (tenant.orgRegion !== undefined) {
    span.setAttribute("helix.tenant.region", tenant.orgRegion);
  }
}

export function createTenantSpanProcessor(): SpanProcessor {
  return {
    onStart(span, parentContext) {
      copyTenantAttributesFromParentSpan(span, parentContext);
    },
    onEnd() {
      // No-op. Tenant dimensions are copied synchronously when the child span starts.
    },
    forceFlush() {
      return Promise.resolve();
    },
    shutdown() {
      return Promise.resolve();
    },
  };
}

function copyTenantAttributesFromParentSpan(span: SdkSpan, parentContext: Context): void {
  const parentSpan = trace.getSpan(parentContext);
  if (!hasReadableAttributes(parentSpan)) {
    return;
  }

  for (const key of tenantAttributeKeys) {
    const value = parentSpan.attributes[key];
    if (value !== undefined && span.attributes[key] === undefined) {
      span.setAttribute(key, value);
    }
  }
}

function hasReadableAttributes(
  span: Span | undefined,
): span is Span & Pick<ReadableSpan, "attributes"> {
  return span !== undefined && "attributes" in span && typeof span.attributes === "object";
}
