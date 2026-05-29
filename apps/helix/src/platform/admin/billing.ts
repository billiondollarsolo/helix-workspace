import type postgres from "postgres";
import {
  isMeteringRollupMetricKey,
  meteringRollupMetricKeys,
  type Actor,
  type MeteringRollupMetricKey,
} from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminConsoleReadScope,
  canReadAdminConsole,
  cursorQuerySchema,
  decodeCursor,
  encodeCursor,
  invalidCursor,
  invalidRequest,
  limitQuerySchema,
  notFound,
  sendForbidden,
  type KeysetCursor,
} from "./console-shared.js";

/**
 * Admin Console — Billing (read model).
 *
 * This domain is intentionally read-only: there is NO payment-gateway
 * integration. Plan, license / storage / AI-credit counts, and invoices are
 * maintained by ops tooling and exposed here for the Billing section of the
 * Admin Console. The API surface is sized exactly to what that section renders
 * (plan card with usage meters, next-invoice line, recent-invoices table).
 */

export type BillingCycle = "monthly" | "annual";
export type InvoiceStatus = "paid" | "open" | "void" | "uncollectible";

export interface BillingAccountRecord {
  readonly orgId: string;
  readonly planName: string;
  readonly pricePerSeatCents: number;
  readonly billingCycle: BillingCycle;
  readonly currency: string;
  readonly licensesTotal: number;
  readonly licensesUsed: number;
  readonly storageUsedBytes: number;
  readonly storageLimitBytes: number;
  readonly aiCreditsUsed: number;
  readonly aiCreditsLimit: number;
  readonly nextInvoiceCents: number;
  readonly nextInvoiceAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InvoiceRecord {
  readonly id: string;
  readonly orgId: string;
  readonly invoiceNumber: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly status: InvoiceStatus;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly issuedAt: string;
  readonly createdAt: string;
}

export interface UsageRollupRecord {
  readonly orgId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly metricKey: MeteringRollupMetricKey;
  readonly quantity: number;
  readonly computedAt: string;
}

export type BillingUsageSummaryAggregation = "sum" | "average" | "max";

export interface BillingUsageSummaryMetric {
  readonly metricKey: MeteringRollupMetricKey;
  readonly quantity: number;
  readonly aggregation: BillingUsageSummaryAggregation;
  readonly sampleCount: number;
}

export interface BillingUsageSummary {
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly metrics: readonly BillingUsageSummaryMetric[];
}

/**
 * Derived usage meter (a 0..1 fill fraction) so the UI does not recompute
 * ratios. Returned alongside the raw counts in the account response.
 */
export interface BillingUsageMeter {
  readonly id: "licenses" | "storage" | "ai_credits";
  readonly used: number;
  readonly limit: number;
  readonly fraction: number;
}

export interface BillingAccountView {
  readonly account: BillingAccountRecord;
  readonly meters: readonly BillingUsageMeter[];
}

export interface BillingUsageView {
  readonly rollups: readonly UsageRollupRecord[];
  readonly summary: BillingUsageSummary;
}

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

export interface ListInvoicesInput {
  readonly orgId: string;
  readonly cursor?: KeysetCursor | undefined;
  readonly limit: number;
}

export interface ListUsageRollupsInput {
  readonly orgId: string;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly metricKey?: MeteringRollupMetricKey | undefined;
}

export interface BillingStore {
  getAccount(orgId: string): Promise<BillingAccountRecord | null>;
  /** Returns up to `limit + 1` rows so the caller can detect a next page. */
  listInvoices(input: ListInvoicesInput): Promise<readonly InvoiceRecord[]>;
  listUsageRollups(input: ListUsageRollupsInput): Promise<readonly UsageRollupRecord[]>;
}

/** Compute the 0..1 fill fraction for a usage meter, guarding divide-by-zero. */
export function meterFraction(used: number, limit: number): number {
  if (limit <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, used / limit));
}

/** Build the account view (raw account + derived usage meters). */
export function buildBillingAccountView(account: BillingAccountRecord): BillingAccountView {
  return {
    account,
    meters: [
      {
        id: "licenses",
        used: account.licensesUsed,
        limit: account.licensesTotal,
        fraction: meterFraction(account.licensesUsed, account.licensesTotal),
      },
      {
        id: "storage",
        used: account.storageUsedBytes,
        limit: account.storageLimitBytes,
        fraction: meterFraction(account.storageUsedBytes, account.storageLimitBytes),
      },
      {
        id: "ai_credits",
        used: account.aiCreditsUsed,
        limit: account.aiCreditsLimit,
        fraction: meterFraction(account.aiCreditsUsed, account.aiCreditsLimit),
      },
    ],
  };
}

export function buildBillingUsageSummary(
  rollups: readonly UsageRollupRecord[],
): BillingUsageSummary {
  const periodStart = rollups.reduce<string | null>(
    (current, rollup) =>
      current === null || rollup.periodStart < current ? rollup.periodStart : current,
    null,
  );
  const periodEnd = rollups.reduce<string | null>(
    (current, rollup) =>
      current === null || rollup.periodEnd > current ? rollup.periodEnd : current,
    null,
  );
  const byMetric = new Map<MeteringRollupMetricKey, UsageRollupRecord[]>();
  for (const rollup of rollups) {
    byMetric.set(rollup.metricKey, [...(byMetric.get(rollup.metricKey) ?? []), rollup]);
  }
  const metrics = [...byMetric.entries()]
    .map(([metricKey, metricRollups]) => {
      const aggregation = usageSummaryAggregation(metricKey);
      const quantity =
        aggregation === "average"
          ? average(metricRollups.map((rollup) => rollup.quantity))
          : aggregation === "max"
            ? Math.max(...metricRollups.map((rollup) => rollup.quantity))
            : sum(metricRollups.map((rollup) => rollup.quantity));
      return {
        metricKey,
        quantity,
        aggregation,
        sampleCount: metricRollups.length,
      };
    })
    .sort((left, right) => left.metricKey.localeCompare(right.metricKey));
  return {
    periodStart,
    periodEnd,
    metrics,
  };
}

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

const listInvoicesQuery = z.object({
  cursor: cursorQuerySchema,
  limit: limitQuerySchema,
});

const usageRollupsQuery = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  metricKey: z.enum(meteringRollupMetricKeys).optional(),
});

export interface RegisterAdminBillingRoutesOptions {
  readonly store: BillingStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
}

/**
 * Register the Billing admin routes (read-only):
 *
 *   GET /api/admin/billing/account   — plan + usage meters
 *   GET /api/admin/billing/invoices  — paginated invoice history
 *   GET /api/admin/billing/usage     — metering rollups for dashboard charts
 */
export async function registerAdminBillingRoutes(
  app: FastifyInstance,
  options: RegisterAdminBillingRoutesOptions,
): Promise<void> {
  const { store, actorFromRequest } = options;

  app.get("/api/admin/billing/account", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const account = await store.getAccount(actor.orgId);
    if (account === null) {
      return reply.code(404).send(notFound("No billing account is provisioned for this org."));
    }
    return buildBillingAccountView(account);
  });

  app.get("/api/admin/billing/invoices", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const parsed = listInvoicesQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest("Invalid invoices query.", parsed.error.issues));
    }
    const cursor = parsed.data.cursor === undefined ? undefined : decodeCursor(parsed.data.cursor);
    if (cursor === null) {
      return reply.code(400).send(invalidCursor());
    }
    const limit = parsed.data.limit;
    const rows = await store.listInvoices({
      orgId: actor.orgId,
      limit: limit + 1,
      ...(cursor === undefined ? {} : { cursor }),
    });
    // Invoices are keyset-ordered by `issuedAt`, so the cursor encodes
    // `issuedAt` into the shared `(createdAt, id)` cursor tuple.
    const invoices = rows.slice(0, limit);
    const last = invoices.at(-1);
    const nextCursor =
      rows.length > limit && last !== undefined
        ? encodeCursor({ createdAt: last.issuedAt, id: last.id })
        : null;
    return { invoices, nextCursor };
  });

  app.get("/api/admin/billing/usage", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const parsed = usageRollupsQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest("Invalid usage query.", parsed.error.issues));
    }
    const from = parsed.data.from === undefined ? undefined : dateFromIsoDate(parsed.data.from);
    const to = parsed.data.to === undefined ? undefined : dateFromIsoDate(parsed.data.to);
    if (from === null || to === null) {
      return reply.code(400).send(invalidRequest("Invalid usage date range.", []));
    }
    if (from !== undefined && to !== undefined && from > to) {
      return reply.code(400).send(invalidRequest("Invalid usage date range.", []));
    }
    const rollups = await store.listUsageRollups({
      orgId: actor.orgId,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(parsed.data.metricKey === undefined ? {} : { metricKey: parsed.data.metricKey }),
    });
    return {
      rollups,
      summary: buildBillingUsageSummary(rollups),
    } satisfies BillingUsageView;
  });
}

// --------------------------------------------------------------------------
// Postgres store
// --------------------------------------------------------------------------

// Numeric columns are typed `string | number`: the postgres driver returns
// `bigint`/`numeric` columns as strings and `integer` columns as numbers, so
// every numeric field is normalized through `Number()` on read.
interface BillingAccountRow {
  readonly org_id: string;
  readonly plan_name: string;
  readonly plan_price_per_seat_cents: string | number;
  readonly billing_cycle: BillingCycle;
  readonly currency: string;
  readonly licenses_total: string | number;
  readonly licenses_used: string | number;
  readonly storage_used_bytes: string | number;
  readonly storage_limit_bytes: string | number;
  readonly ai_credits_used: string | number;
  readonly ai_credits_limit: string | number;
  readonly next_invoice_cents: string | number;
  readonly next_invoice_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface InvoiceRow {
  readonly id: string;
  readonly org_id: string;
  readonly invoice_number: string;
  readonly amount_cents: string | number;
  readonly currency: string;
  readonly status: InvoiceStatus;
  readonly period_start: Date;
  readonly period_end: Date;
  readonly issued_at: Date;
  readonly created_at: Date;
}

interface UsageRollupRow {
  readonly org_id: string;
  readonly period_start: Date | string;
  readonly period_end: Date | string;
  readonly metric_key: string;
  readonly quantity: string | number;
  readonly computed_at: Date;
}

export class PostgresBillingStore implements BillingStore {
  constructor(private readonly sql: postgres.Sql) {}

  async getAccount(orgId: string): Promise<BillingAccountRecord | null> {
    const rows = (await this.sql`
      select org_id, plan_name, plan_price_per_seat_cents, billing_cycle, currency,
             licenses_total, licenses_used, storage_used_bytes, storage_limit_bytes,
             ai_credits_used, ai_credits_limit, next_invoice_cents, next_invoice_at,
             created_at, updated_at
      from admin_billing_accounts
      where org_id = ${orgId}
    `) as unknown as readonly BillingAccountRow[];
    const row = rows[0];
    return row === undefined ? null : mapAccountRow(row);
  }

  async listInvoices(input: ListInvoicesInput): Promise<readonly InvoiceRecord[]> {
    const cursorIssuedAt = input.cursor?.createdAt ?? null;
    const cursorId = input.cursor?.id ?? null;
    const rows = (await this.sql`
      select id, org_id, invoice_number, amount_cents, currency, status,
             period_start, period_end, issued_at, created_at
      from admin_billing_invoices
      where org_id = ${input.orgId}
        and (
          ${cursorIssuedAt}::timestamptz is null
          or (issued_at, id) < (${cursorIssuedAt}::timestamptz, ${cursorId}::uuid)
        )
      order by issued_at desc, id desc
      limit ${input.limit}
    `) as unknown as readonly InvoiceRow[];
    return rows.map(mapInvoiceRow);
  }

  async listUsageRollups(input: ListUsageRollupsInput): Promise<readonly UsageRollupRecord[]> {
    const rows = (await this.sql`
      select org_id, period_start, period_end, metric_key, quantity::text as quantity, computed_at
      from metering_rollups
      where org_id = ${input.orgId}
        and (${input.from ?? null}::date is null or period_start >= ${input.from ?? null}::date)
        and (${input.to ?? null}::date is null or period_start <= ${input.to ?? null}::date)
        and (${input.metricKey ?? null}::text is null or metric_key = ${input.metricKey ?? null})
      order by period_start desc, metric_key asc
      limit 120
    `) as unknown as readonly UsageRollupRow[];
    return rows.map(mapUsageRollupRow);
  }
}

function mapAccountRow(row: BillingAccountRow): BillingAccountRecord {
  return {
    orgId: row.org_id,
    planName: row.plan_name,
    pricePerSeatCents: Number(row.plan_price_per_seat_cents),
    billingCycle: row.billing_cycle,
    currency: row.currency,
    licensesTotal: Number(row.licenses_total),
    licensesUsed: Number(row.licenses_used),
    storageUsedBytes: Number(row.storage_used_bytes),
    storageLimitBytes: Number(row.storage_limit_bytes),
    aiCreditsUsed: Number(row.ai_credits_used),
    aiCreditsLimit: Number(row.ai_credits_limit),
    nextInvoiceCents: Number(row.next_invoice_cents),
    nextInvoiceAt: row.next_invoice_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapInvoiceRow(row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    invoiceNumber: row.invoice_number,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    status: row.status,
    periodStart: row.period_start.toISOString(),
    periodEnd: row.period_end.toISOString(),
    issuedAt: row.issued_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

function mapUsageRollupRow(row: UsageRollupRow): UsageRollupRecord {
  if (!isMeteringRollupMetricKey(row.metric_key)) {
    throw new Error(`Unknown metering rollup metric key: ${row.metric_key}`);
  }
  return {
    orgId: row.org_id,
    periodStart: isoDate(row.period_start),
    periodEnd: isoDate(row.period_end),
    metricKey: row.metric_key,
    quantity: Number(row.quantity),
    computedAt: row.computed_at.toISOString(),
  };
}

function dateFromIsoDate(value: string): Date | null {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(value: Date | string): string {
  if (typeof value === "string") {
    return value;
  }
  return value.toISOString().slice(0, 10);
}

function usageSummaryAggregation(
  metricKey: MeteringRollupMetricKey,
): BillingUsageSummaryAggregation {
  if (metricKey === "storage_avg_bytes") {
    return "average";
  }
  if (metricKey === "seats_max") {
    return "max";
  }
  return "sum";
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

// --------------------------------------------------------------------------
// In-memory store (tests / offline)
// --------------------------------------------------------------------------

/**
 * Deterministic in-memory {@link BillingStore}. Seed it with an account and
 * invoices for the orgs under test.
 */
export class InMemoryBillingStore implements BillingStore {
  readonly #accounts = new Map<string, BillingAccountRecord>();
  readonly #invoices: InvoiceRecord[] = [];

  setAccount(account: BillingAccountRecord): void {
    this.#accounts.set(account.orgId, account);
  }

  addInvoice(invoice: InvoiceRecord): void {
    this.#invoices.push(invoice);
  }

  async getAccount(orgId: string): Promise<BillingAccountRecord | null> {
    return this.#accounts.get(orgId) ?? null;
  }

  async listInvoices(input: ListInvoicesInput): Promise<readonly InvoiceRecord[]> {
    return this.#invoices
      .filter((invoice) => invoice.orgId === input.orgId)
      .sort((a, b) =>
        a.issuedAt === b.issuedAt ? b.id.localeCompare(a.id) : b.issuedAt.localeCompare(a.issuedAt),
      )
      .filter((invoice) => {
        if (input.cursor === undefined) {
          return true;
        }
        const cursorKey = `${input.cursor.createdAt.toISOString()}:${input.cursor.id}`;
        return `${invoice.issuedAt}:${invoice.id}` < cursorKey;
      })
      .slice(0, input.limit);
  }

  async listUsageRollups(input: ListUsageRollupsInput): Promise<readonly UsageRollupRecord[]> {
    const fromTime = input.from?.getTime() ?? Number.NEGATIVE_INFINITY;
    const toTime = input.to?.getTime() ?? Number.POSITIVE_INFINITY;
    return this.#usageRollups
      .filter((rollup) => rollup.orgId === input.orgId)
      .filter((rollup) => input.metricKey === undefined || rollup.metricKey === input.metricKey)
      .filter((rollup) => {
        const periodTime = new Date(`${rollup.periodStart}T00:00:00.000Z`).getTime();
        return periodTime >= fromTime && periodTime <= toTime;
      })
      .sort((left, right) =>
        left.periodStart === right.periodStart
          ? left.metricKey.localeCompare(right.metricKey)
          : right.periodStart.localeCompare(left.periodStart),
      )
      .slice(0, 120);
  }

  readonly #usageRollups: UsageRollupRecord[] = [];

  addUsageRollup(rollup: UsageRollupRecord): void {
    this.#usageRollups.push(rollup);
  }
}
