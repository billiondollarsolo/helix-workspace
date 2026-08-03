/* Admin › Organization › Billing & usage — plan, invoices, metered rollups. */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  billingAccountQueryOptions,
  billingQueryKeys,
  formatBytes,
  formatMoney,
  invoicesQueryOptions,
  usageRollupsQueryOptions,
  type BillingUsageMeter,
  type Invoice,
  type MeteringRollupMetricKey,
  type UsageRollup,
  type UsageSummaryMetric,
} from "@/features/admin/billing-api";
import {
  AdminInput,
  AdminSelect,
  AdminStatRow,
  AdminStatTile,
  AdminToolbar,
} from "@/features/admin/console/controls";
import { AdminTable, type AdminColumn } from "@/features/admin/console/table";
import {
  EmptyRow,
  PageHeading,
  PageScroll,
  QueryFailureBanner,
  StateBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";

/* ------------------------------------------------------------------ */
/* Billing                                                            */
/* ------------------------------------------------------------------ */

/** What every figure on this page falls back to when its query has not
 *  resolved. A billing console that answers "how much do we owe?" with `0`
 *  reads as "nothing" — the one wrong answer a money figure can give. */
const NO_VALUE = "—";

const METER_LABEL: Record<"licenses" | "storage" | "ai_credits", string> = {
  licenses: "Licenses used",
  storage: "Storage",
  ai_credits: "AI credits",
};

const USAGE_METRIC_LABELS: Record<MeteringRollupMetricKey, string> = {
  ai_tokens: "AI tokens",
  storage_delta_bytes: "Storage delta",
  exports_count: "Exports",
  api_calls_billable: "Billable API calls",
  ai_images_generated: "Generated images",
  seats_delta: "Seat changes",
  seats_max: "Max seats",
  collab_session_seconds: "Collab session seconds",
  storage_avg_bytes: "Average storage",
};

const USAGE_FILTER_METRICS = Object.entries(USAGE_METRIC_LABELS) as ReadonlyArray<
  readonly [MeteringRollupMetricKey, string]
>;

function formatDateLabel(value: string | null): string {
  if (value === null) {
    return NO_VALUE;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
}

function formatMeterValue(meter: BillingUsageMeter): string {
  if (meter.id === "storage") {
    return `${formatBytes(meter.used)} / ${formatBytes(meter.limit)}`;
  }
  const number = new Intl.NumberFormat("en-US");
  return `${number.format(meter.used)} / ${number.format(meter.limit)}`;
}

function buildPlanChangeMailto(planName: string, orgId: string): string {
  return buildBillingContactMailto("Plan change", planName, orgId);
}

/** Billing is read-only over the API — account, invoices and usage are all
 *  GETs. Anything that would need a write is a request to a human, and the
 *  mail carries the workspace identifiers so they do not have to be asked. */
function buildBillingContactMailto(topic: string, planName: string, orgId: string): string {
  const subject = `${topic} request for ${orgId}`;
  const body = [
    `Please help us with: ${topic.toLowerCase()}.`,
    "",
    `Current plan: ${planName}`,
    `Org ID: ${orgId}`,
  ].join("\n");
  return `mailto:sales@helix.example?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/* No trailing action column: there is no per-invoice document endpoint, and
   the "PDF" button that used to sit here had no handler. */
const INVOICE_COLUMNS: readonly AdminColumn<Invoice>[] = [
  {
    id: "number",
    header: "Invoice",
    width: "160px",
    cell: (invoice) => <span className="mono">{invoice.invoiceNumber}</span>,
  },
  {
    id: "issued",
    header: "Issued",
    cell: (invoice) => (
      <span className="text-[var(--text-2)]">{formatDateLabel(invoice.issuedAt)}</span>
    ),
  },
  {
    id: "amount",
    header: "Amount",
    align: "right",
    width: "140px",
    cell: (invoice) => formatMoney(invoice.amountCents, invoice.currency),
  },
  {
    id: "status",
    header: "Status",
    width: "110px",
    cell: (invoice) => (
      <span className={`chip ${invoice.status === "paid" ? "success" : "warning"}`}>
        <span className="chip-dot" />
        {invoice.status}
      </span>
    ),
  },
];

export function AdminBilling() {
  const queryClient = useQueryClient();
  const [usageFilters, setUsageFilters] = useState<{
    readonly from: string;
    readonly to: string;
    readonly metricKey: MeteringRollupMetricKey | "";
  }>({ from: "", to: "", metricKey: "" });
  const usageQueryInput = useMemo(
    () => ({
      ...(usageFilters.from.trim().length === 0 ? {} : { from: usageFilters.from }),
      ...(usageFilters.to.trim().length === 0 ? {} : { to: usageFilters.to }),
      ...(usageFilters.metricKey === "" ? {} : { metricKey: usageFilters.metricKey }),
    }),
    [usageFilters],
  );
  const accountQuery = useQuery(billingAccountQueryOptions());
  const invoicesQuery = useQuery(invoicesQueryOptions());
  const usageQuery = useQuery(usageRollupsQueryOptions(usageQueryInput));

  const view = accountQuery.data;
  const invoices = invoicesQuery.data?.invoices ?? [];
  const usageRollups = usageQuery.data?.rollups ?? [];
  const usageSummary = usageQuery.data?.summary;

  /* Retrying by invalidating the key (rather than the observer's own refetch)
     keeps every reader of that key in step, and the usage key carries the
     current filters so a retry re-runs the request the user is looking at. */
  const retryQuery = (queryKey: readonly unknown[]) => () => {
    void queryClient.invalidateQueries({ queryKey });
  };
  const accountFailure = useQueryFailure(accountQuery, retryQuery(billingQueryKeys.account()));
  const invoicesFailure = useQueryFailure(invoicesQuery, retryQuery(billingQueryKeys.invoices()));
  const usageFailure = useQueryFailure(
    usageQuery,
    retryQuery(billingQueryKeys.usage(usageQueryInput)),
  );

  /* The three endpoints sit behind one service, so they fail together far more
     often than alone. Three copies of the same banner read as three separate
     incidents; one page-level state says it once. Per-panel banners stay for
     the partial case, which is a genuinely different story.
     The account error stands in for all three: one service explains them all,
     and the account call is the one this page is built around. */
  const serviceFailure =
    accountFailure !== null && invoicesFailure !== null && usageFailure !== null
      ? accountFailure
      : null;
  const anyQueryFetching =
    accountQuery.isFetching || invoicesQuery.isFetching || usageQuery.isFetching;
  const retryAll = () => {
    accountFailure?.retry();
    invoicesFailure?.retry();
    usageFailure?.retry();
  };

  /* React Query keeps the last good `data` after a failed refetch, so `view`
     outlives the read that produced it. Plan and seat *labels* survive that
     gap honestly enough, but a money or quota figure presented as current when
     the console could not confirm it is the page's worst failure mode — those
     read `NO_VALUE` until the account query itself resolves again. */
  const accountResolved = accountQuery.isSuccess;

  /* Filters re-key the usage query, so leaving them live over a failed panel
     offers a control that cannot do its job until the query recovers. */
  const usageFiltersDisabled = usageFailure !== null;

  return (
    <PageScroll>
      <PageHeading title="Billing & licenses" subtitle="" />

      {serviceFailure !== null ? (
        <QueryFailureBanner
          summary="Billing data is unavailable"
          subject="billing"
          error={serviceFailure.error}
          isRetrying={anyQueryFetching}
          onRetry={retryAll}
          retryVariant="default"
        >
          Plan, usage, and invoices all failed together — nothing on this page is current.
        </QueryFailureBanner>
      ) : (
        <>
          {accountFailure !== null ? (
            <QueryFailureBanner
              summary="Plan and license data is unavailable"
              subject="billing"
              error={accountFailure.error}
              isRetrying={accountFailure.isRetrying}
              onRetry={accountFailure.retry}
            >
              The plan figures below read “{NO_VALUE}” rather than a number: the console cannot
              confirm what the current amounts are.
            </QueryFailureBanner>
          ) : accountQuery.isPending ? (
            <StateBanner kind="loading">Loading billing account…</StateBanner>
          ) : null}

          {view ? (
            <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
              <div className="panel p-5">
                <div className="mb-3 flex items-center">
                  <span className="chip accent">Current plan</span>
                </div>
                {/* Deliberately not a heading: the plan name is a value, and
                    an outline entry reading "Business" names nothing. */}
                <div className="font-bold tracking-[-0.02em] [font-size:var(--text-h1)]">
                  {view.account.planName}
                </div>
                <p className="mt-0 mb-4 text-[var(--text-2)] [font-size:var(--text-body-sm)]">
                  {accountResolved
                    ? `${formatMoney(view.account.pricePerSeatCents, view.account.currency)} per user / month · billed ${view.account.billingCycle}`
                    : "Per-seat price unavailable — the plan read did not complete."}
                </p>
                <AdminStatRow>
                  {view.meters.map((meter) => (
                    <AdminStatTile
                      key={meter.id}
                      label={METER_LABEL[meter.id]}
                      value={accountResolved ? formatMeterValue(meter) : NO_VALUE}
                      note={
                        accountResolved ? (
                          /* `<progress>` rather than a div whose width is a
                             percentage: the bar then carries its own value to
                             assistive tech, and the fill needs no inline
                             style to place it. */
                          <progress
                            className="h-1 w-full accent-[var(--accent)]"
                            aria-label={`${METER_LABEL[meter.id]} against limit`}
                            value={meter.fraction}
                            max={1}
                          />
                        ) : undefined
                      }
                    />
                  ))}
                </AdminStatRow>
                <div className="mt-4 flex items-center gap-3 border-t border-[var(--border)] pt-3">
                  <div className="min-w-0">
                    <div className="font-semibold [font-size:var(--text-body-sm)]">
                      Need more capacity?
                    </div>
                    <div className="mt-0.5 text-[var(--text-3)] [font-size:var(--text-meta)]">
                      Request a plan change from the Helix billing team.
                    </div>
                  </div>
                  <Button asChild size="sm" className="ml-auto">
                    <a href={buildPlanChangeMailto(view.account.planName, view.account.orgId)}>
                      <Icons.Plus /> Upgrade plan
                    </a>
                  </Button>
                </div>
              </div>

              <div className="grid content-start gap-4">
                <AdminStatTile
                  label="Next invoice"
                  value={
                    accountResolved
                      ? formatMoney(view.account.nextInvoiceCents, view.account.currency)
                      : NO_VALUE
                  }
                  note={accountResolved ? formatDateLabel(view.account.nextInvoiceAt) : undefined}
                />
                {/* There is no self-serve payment or invoice-export endpoint —
                    the billing API is three GETs (account, invoices, usage).
                    These were buttons with no handler, indistinguishable from
                    the working controls beside them. The mailto is the same
                    escape hatch the plan-change action already uses, and it
                    actually does something. */}
                <div className="panel grid gap-2 p-4">
                  <Button asChild variant="outline" size="sm">
                    <a
                      href={buildBillingContactMailto(
                        "Payment method update",
                        view.account.planName,
                        view.account.orgId,
                      )}
                    >
                      <Icons.Credit /> Request payment method change
                    </a>
                  </Button>
                  <Button asChild variant="outline" size="sm">
                    <a
                      href={buildBillingContactMailto(
                        "Invoice export",
                        view.account.planName,
                        view.account.orgId,
                      )}
                    >
                      <Icons.Download /> Request invoice export
                    </a>
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="panel mt-4 p-4">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="m-0 font-semibold [font-size:var(--text-body-sm)]">
                Billing-period usage
              </h2>
              <div className="ml-auto">
                <AdminToolbar label="Billing-period usage filters">
                  <AdminSelect
                    aria-label="Usage metric filter"
                    className="min-w-[170px]"
                    value={usageFilters.metricKey}
                    disabled={usageFiltersDisabled}
                    onChange={(event) => {
                      const value = event.currentTarget.value as MeteringRollupMetricKey | "";
                      setUsageFilters((current) => ({ ...current, metricKey: value }));
                    }}
                  >
                    <option value="">All metrics</option>
                    {USAGE_FILTER_METRICS.map(([metricKey, label]) => (
                      <option key={metricKey} value={metricKey}>
                        {label}
                      </option>
                    ))}
                  </AdminSelect>
                  <AdminInput
                    aria-label="Usage from date"
                    type="date"
                    className="w-[132px]"
                    value={usageFilters.from}
                    disabled={usageFiltersDisabled}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setUsageFilters((current) => ({ ...current, from: value }));
                    }}
                  />
                  <AdminInput
                    aria-label="Usage to date"
                    type="date"
                    className="w-[132px]"
                    value={usageFilters.to}
                    disabled={usageFiltersDisabled}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setUsageFilters((current) => ({ ...current, to: value }));
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={usageFiltersDisabled}
                    onClick={() => setUsageFilters({ from: "", to: "", metricKey: "" })}
                  >
                    Clear
                  </Button>
                </AdminToolbar>
              </div>
            </div>
            {usageFailure !== null ? (
              <QueryFailureBanner
                summary="Billing-period usage is unavailable"
                subject="billing"
                error={usageFailure.error}
                isRetrying={usageFailure.isRetrying}
                onRetry={usageFailure.retry}
              >
                The date and metric filters above stay disabled until the rollups load.
              </QueryFailureBanner>
            ) : usageQuery.isPending ? (
              <EmptyRow>Loading usage rollups…</EmptyRow>
            ) : usageRollups.length === 0 ? (
              <EmptyRow>No metered usage rollups yet.</EmptyRow>
            ) : (
              /* Reached only with no usage failure and rollups in hand, so every
                 figure below came from a read that completed. */
              <div className="grid gap-3">
                {usageSummary === undefined || usageSummary.metrics.length === 0 ? null : (
                  <AdminStatRow>
                    {usageSummary.metrics.slice(0, 8).map((metric) => (
                      <UsageSummaryCard key={metric.metricKey} metric={metric} />
                    ))}
                  </AdminStatRow>
                )}
                <AdminStatRow>
                  {usageRollups.slice(0, 8).map((rollup) => (
                    <UsageRollupCard
                      key={`${rollup.periodStart}:${rollup.metricKey}`}
                      rollup={rollup}
                    />
                  ))}
                </AdminStatRow>
              </div>
            )}
          </div>

          <div className="panel mt-4 p-4">
            <div className="mb-3 flex items-center">
              <h2 className="m-0 font-semibold [font-size:var(--text-body-sm)]">Recent invoices</h2>
            </div>
            {invoicesFailure !== null ? (
              <QueryFailureBanner
                summary="Recent invoices are unavailable"
                subject="billing"
                error={invoicesFailure.error}
                isRetrying={invoicesFailure.isRetrying}
                onRetry={invoicesFailure.retry}
              />
            ) : invoicesQuery.isPending ? (
              <EmptyRow>Loading invoices…</EmptyRow>
            ) : invoices.length === 0 ? (
              <EmptyRow>No invoices yet.</EmptyRow>
            ) : (
              <AdminTable
                label="Recent invoices"
                columns={INVOICE_COLUMNS}
                rows={invoices}
                rowKey={(invoice) => invoice.id}
              />
            )}
          </div>
        </>
      )}
    </PageScroll>
  );
}

function UsageSummaryCard({ metric }: { readonly metric: UsageSummaryMetric }) {
  return (
    <AdminStatTile
      label={USAGE_METRIC_LABELS[metric.metricKey] ?? metric.metricKey}
      value={formatUsageMetricQuantity(metric)}
      note={`${metric.aggregation} over ${String(metric.sampleCount)} day${metric.sampleCount === 1 ? "" : "s"}`}
    />
  );
}

function UsageRollupCard({ rollup }: { readonly rollup: UsageRollup }) {
  return (
    <AdminStatTile
      label={USAGE_METRIC_LABELS[rollup.metricKey] ?? rollup.metricKey}
      value={formatUsageQuantity(rollup)}
      note={formatUsagePeriod(rollup.periodStart)}
    />
  );
}

function formatUsageQuantity(rollup: UsageRollup): string {
  if (rollup.metricKey === "storage_delta_bytes") {
    const sign = rollup.quantity > 0 ? "+" : rollup.quantity < 0 ? "-" : "";
    return `${sign}${formatUsageBytes(Math.abs(rollup.quantity))}`;
  }
  if (rollup.metricKey === "storage_avg_bytes") {
    return formatUsageBytes(rollup.quantity);
  }
  return new Intl.NumberFormat("en-US").format(rollup.quantity);
}

function formatUsageMetricQuantity(metric: UsageSummaryMetric): string {
  if (metric.metricKey === "storage_delta_bytes") {
    const sign = metric.quantity > 0 ? "+" : metric.quantity < 0 ? "-" : "";
    return `${sign}${formatUsageBytes(Math.abs(metric.quantity))}`;
  }
  if (metric.metricKey === "storage_avg_bytes") {
    return formatUsageBytes(metric.quantity);
  }
  return new Intl.NumberFormat("en-US").format(metric.quantity);
}

function formatUsageBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  const formatted = value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

function formatUsagePeriod(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}
