import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";

/**
 * Admin Console — Billing client (read-only).
 *
 * Talks to `/api/admin/billing` — there is NO payment-gateway integration; the
 * plan, usage counts, and invoices are maintained by ops tooling. Two routes:
 *  - `/account`  — plan + derived usage meters
 *  - `/invoices` — paginated invoice history
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

export interface InvoicesQueryInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export const defaultInvoicesInput = { limit: 25 } as const satisfies InvoicesQueryInput;

// ---------------------------------------------------------------------------
// Query keys + options
// ---------------------------------------------------------------------------

export const billingQueryKeys = {
  account: () => ["admin", "billing", "account"] as const,
  invoices: (input: InvoicesQueryInput = defaultInvoicesInput) =>
    ["admin", "billing", "invoices", input.limit ?? defaultInvoicesInput.limit, input.cursor ?? ""] as const,
};

export function billingAccountQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: billingQueryKeys.account(),
    queryFn: () => fetchBillingAccount(fetchImpl),
    retry: false,
    throwOnError: false,
  });
}

export function invoicesQueryOptions(
  input: InvoicesQueryInput = defaultInvoicesInput,
  fetchImpl: AuthFetch = authenticatedFetch,
) {
  return queryOptions({
    queryKey: billingQueryKeys.invoices(input),
    queryFn: () => fetchInvoices(input, fetchImpl),
    retry: false,
    throwOnError: false,
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
  if (input.cursor !== undefined && input.cursor.trim().length > 0) {
    params.set("cursor", input.cursor.trim());
  }
  const response = await fetchImpl(`/api/admin/billing/invoices?${params.toString()}`, {
    method: "GET",
  });
  return parseResponse(response, "load invoices", invoicesResponseSchema);
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

// ---------------------------------------------------------------------------
// Shared response handling
// ---------------------------------------------------------------------------

async function parseResponse<T>(
  response: Response,
  action: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessage(payload) ?? `Failed to ${action} (${String(response.status)}).`);
  }
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(`Failed to ${action}: malformed response.`);
}

function errorMessage(payload: unknown): string | undefined {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return undefined;
}
