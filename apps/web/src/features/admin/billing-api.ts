import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { meteringRollupMetricKeys, type MeteringRollupMetricKey } from "@helix/sdk-types";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { ADMIN_QUERY_DEFAULTS } from "@/features/admin/console/request-budget";
import { appendParam, parseResponse } from "@/features/admin/api-response";

export type { MeteringRollupMetricKey } from "@helix/sdk-types";

/**
 * Admin Console — Billing client (read-only).
 *
 * Talks to `/api/admin/billing` — there is NO payment-gateway integration; the
 * plan, usage counts, invoices, and metering rollups are maintained by ops tooling. Three routes:
 *  - `/account`  — plan + derived usage meters
 *  - `/invoices` — paginated invoice history
 *  - `/usage`    — daily metering rollups
 *
 * Backend responses are validated at the trust boundary with Zod.
 */

export const BILLING_CYCLES = ["monthly", "annual"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const INVOICE_STATUSES = ["paid", "open", "void", "uncollectible"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

const billingAccountSchema = z.object({
  orgId: z.string(),
  planName: z.string(),
  pricePerSeatCents: z.number(),
  billingCycle: z.enum(BILLING_CYCLES),
  currency: z.string(),
  licensesTotal: z.number(),
  licensesUsed: z.number(),
  storageUsedBytes: z.number(),
  storageLimitBytes: z.number(),
  aiCreditsUsed: z.number(),
  aiCreditsLimit: z.number(),
  nextInvoiceCents: z.number(),
  nextInvoiceAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type BillingAccount = z.infer<typeof billingAccountSchema>;

const billingUsageMeterSchema = z.object({
  id: z.enum(["licenses", "storage", "ai_credits"]),
  used: z.number(),
  limit: z.number(),
  fraction: z.number(),
});

export type BillingUsageMeter = z.infer<typeof billingUsageMeterSchema>;

const billingAccountViewSchema = z.object({
  account: billingAccountSchema,
  meters: z.array(billingUsageMeterSchema),
});

export type BillingAccountView = z.infer<typeof billingAccountViewSchema>;

const invoiceSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  invoiceNumber: z.string(),
  amountCents: z.number(),
  currency: z.string(),
  status: z.enum(INVOICE_STATUSES),
  periodStart: z.string(),
  periodEnd: z.string(),
  issuedAt: z.string(),
  createdAt: z.string(),
});

export type Invoice = z.infer<typeof invoiceSchema>;

const invoicesResponseSchema = z.object({
  invoices: z.array(invoiceSchema),
  nextCursor: z.string().nullable(),
});

export type InvoicesResponse = z.infer<typeof invoicesResponseSchema>;

const usageRollupSchema = z.object({
  orgId: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  metricKey: z.enum(meteringRollupMetricKeys),
  quantity: z.number(),
  computedAt: z.string(),
});

export type UsageRollup = z.infer<typeof usageRollupSchema>;

const usageSummaryMetricSchema = z.object({
  metricKey: z.enum(meteringRollupMetricKeys),
  quantity: z.number(),
  aggregation: z.enum(["sum", "average", "max"]),
  sampleCount: z.number(),
});

export type UsageSummaryMetric = z.infer<typeof usageSummaryMetricSchema>;

const usageSummarySchema = z.object({
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  metrics: z.array(usageSummaryMetricSchema),
});

export type UsageSummary = z.infer<typeof usageSummarySchema>;

const usageRollupsResponseSchema = z.object({
  rollups: z.array(usageRollupSchema),
  summary: usageSummarySchema.optional(),
});

export interface UsageRollupsResponse {
  readonly rollups: readonly UsageRollup[];
  readonly summary: UsageSummary;
}

const defaultUsageSummary: UsageSummary = {
  periodStart: null,
  periodEnd: null,
  metrics: [],
};

export interface InvoicesQueryInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface UsageRollupsQueryInput {
  readonly from?: string;
  readonly to?: string;
  readonly metricKey?: MeteringRollupMetricKey;
}

export const defaultInvoicesInput = { limit: 25 } as const satisfies InvoicesQueryInput;

// ---------------------------------------------------------------------------
// Query keys + options
// ---------------------------------------------------------------------------

export const billingQueryKeys = {
  account: () => ["admin", "billing", "account"] as const,
  invoices: (input: InvoicesQueryInput = defaultInvoicesInput) =>
    [
      "admin",
      "billing",
      "invoices",
      input.limit ?? defaultInvoicesInput.limit,
      input.cursor ?? "",
    ] as const,
  usage: (input: UsageRollupsQueryInput = {}) =>
    ["admin", "billing", "usage", input.from ?? "", input.to ?? "", input.metricKey ?? ""] as const,
};

export function billingAccountQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: billingQueryKeys.account(),
    queryFn: () => fetchBillingAccount(fetchImpl),
  });
}

export function invoicesQueryOptions(
  input: InvoicesQueryInput = defaultInvoicesInput,
  fetchImpl: AuthFetch = authenticatedFetch,
) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: billingQueryKeys.invoices(input),
    queryFn: () => fetchInvoices(input, fetchImpl),
  });
}

export function usageRollupsQueryOptions(
  input: UsageRollupsQueryInput = {},
  fetchImpl: AuthFetch = authenticatedFetch,
) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: billingQueryKeys.usage(input),
    queryFn: () => fetchUsageRollups(input, fetchImpl),
  });
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

export async function fetchBillingAccount(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<BillingAccountView> {
  const response = await fetchImpl("/api/admin/billing/account", { method: "GET" });
  return parseResponse(response, "load billing account", billingAccountViewSchema);
}

export async function fetchInvoices(
  input: InvoicesQueryInput = defaultInvoicesInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<InvoicesResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit ?? defaultInvoicesInput.limit));
  appendParam(params, "cursor", input.cursor);
  const response = await fetchImpl(`/api/admin/billing/invoices?${params.toString()}`, {
    method: "GET",
  });
  return parseResponse(response, "load invoices", invoicesResponseSchema);
}

export async function fetchUsageRollups(
  input: UsageRollupsQueryInput = {},
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<UsageRollupsResponse> {
  const params = new URLSearchParams();
  appendParam(params, "from", input.from);
  appendParam(params, "to", input.to);
  appendParam(params, "metricKey", input.metricKey);
  const query = params.toString();
  const response = await fetchImpl(
    `/api/admin/billing/usage${query.length === 0 ? "" : `?${query}`}`,
    {
      method: "GET",
    },
  );
  const parsed = await parseResponse(response, "load usage rollups", usageRollupsResponseSchema);
  return {
    rollups: parsed.rollups,
    summary: parsed.summary ?? defaultUsageSummary,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format a cents amount as a currency string. */
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase() || "USD",
  }).format(cents / 100);
}

/** Format a byte count into a human-readable TB/GB string. */
export function formatBytes(bytes: number): string {
  const tb = bytes / 1_000_000_000_000;
  if (tb >= 1) {
    return `${tb.toFixed(1)} TB`;
  }
  const gb = bytes / 1_000_000_000;
  return `${gb.toFixed(0)} GB`;
}
