/* Admin › Organization › Billing & usage — plan, invoices, metered rollups. */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import {
  billingAccountQueryOptions,
  billingQueryKeys,
  formatBytes,
  formatMoney,
  invoicesQueryOptions,
  usageRollupsQueryOptions,
  type MeteringRollupMetricKey,
  type UsageRollup,
  type UsageSummaryMetric,
} from "@/features/admin/billing-api";
import {
  EmptyRow,
  HEADER_CELL,
  INPUT_STYLE,
  PageHeading,
  PageScroll,
  QueryFailureBanner,
  StateBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";

/* ------------------------------------------------------------------ */
/* Billing                                                            */
/* ------------------------------------------------------------------ */

/* No trailing action column: there is no per-invoice document endpoint, and
   the "PDF" button that used to sit here had no handler. */
const INVOICE_GRID = "160px 1fr 140px 90px";

/** The console's inputs carry their colours inline, which overrides the browser's
 *  own disabled rendering — a disabled filter has to be dimmed by hand. */
const DISABLED_CONTROL: React.CSSProperties = { opacity: 0.55, cursor: "not-allowed" };

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
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
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

  /* Filters re-key the usage query, so leaving them live over a failed panel
     offers a control that cannot do its job until the query recovers. */
  const usageFiltersDisabled = usageFailure !== null;
  const usageFilterStyle: React.CSSProperties = usageFiltersDisabled
    ? { ...INPUT_STYLE, ...DISABLED_CONTROL }
    : INPUT_STYLE;

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
            />
          ) : accountQuery.isPending ? (
            <StateBanner kind="loading">Loading billing account…</StateBanner>
          ) : null}

          {view ? (
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
              <div className="panel" style={{ padding: 20 }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                  <span className="chip accent">Current plan</span>
                </div>
                <div
                  style={{ fontSize: "var(--text-h1)", fontWeight: 700, letterSpacing: "-0.02em" }}
                >
                  {view.account.planName}
                </div>
                <div
                  style={{
                    fontSize: "var(--text-body-sm)",
                    color: "var(--text-2)",
                    marginBottom: 16,
                  }}
                >
                  {`${formatMoney(view.account.pricePerSeatCents, view.account.currency)} per user / month · billed ${view.account.billingCycle}`}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: 12,
                  }}
                >
                  {view.meters.map((meter) => {
                    const valueText =
                      meter.id === "storage"
                        ? `${formatBytes(meter.used)} / ${formatBytes(meter.limit)}`
                        : `${new Intl.NumberFormat("en-US").format(meter.used)} / ${new Intl.NumberFormat("en-US").format(meter.limit)}`;
                    return (
                      <div key={meter.id}>
                        <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
                          {METER_LABEL[meter.id]}
                        </div>
                        <div style={{ fontWeight: 600, marginTop: 2 }}>{valueText}</div>
                        <div
                          style={{
                            height: 4,
                            background: "var(--surface-2)",
                            borderRadius: 2,
                            marginTop: 6,
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              width: `${String(meter.fraction * 100)}%`,
                              background: "var(--accent)",
                              borderRadius: 2,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div
                  style={{
                    borderTop: "1px solid var(--border)",
                    marginTop: 16,
                    paddingTop: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "var(--text-body-sm)", fontWeight: 600 }}>
                      Need more capacity?
                    </div>
                    <div
                      style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", marginTop: 2 }}
                    >
                      Request a plan change from the Helix billing team.
                    </div>
                  </div>
                  <a
                    className="btn primary"
                    href={buildPlanChangeMailto(view.account.planName, view.account.orgId)}
                    style={{ marginLeft: "auto", textDecoration: "none" }}
                  >
                    <Icons.Plus /> Upgrade plan
                  </a>
                </div>
              </div>

              <div className="panel" style={{ padding: 20 }}>
                <div style={{ ...HEADER_CELL, marginBottom: 4 }}>Next invoice</div>
                <div style={{ fontSize: "var(--text-h1)", fontWeight: 700 }}>
                  {formatMoney(view.account.nextInvoiceCents, view.account.currency)}
                </div>
                <div
                  style={{ fontSize: "var(--text-meta)", color: "var(--text-2)", marginBottom: 16 }}
                >
                  {formatDateLabel(view.account.nextInvoiceAt)}
                </div>
                {/* There is no self-serve payment or invoice-export endpoint —
                    the billing API is three GETs (account, invoices, usage).
                    These were buttons with no handler, indistinguishable from
                    the working controls beside them. The mailto is the same
                    escape hatch the plan-change action already uses, and it
                    actually does something. */}
                <a
                  className="btn"
                  style={{ width: "100%", marginBottom: 8, justifyContent: "center" }}
                  href={buildBillingContactMailto(
                    "Payment method update",
                    view.account.planName,
                    view.account.orgId,
                  )}
                >
                  <Icons.Credit /> Request payment method change
                </a>
                <a
                  className="btn"
                  style={{ width: "100%", justifyContent: "center" }}
                  href={buildBillingContactMailto(
                    "Invoice export",
                    view.account.planName,
                    view.account.orgId,
                  )}
                >
                  <Icons.Download /> Request invoice export
                </a>
              </div>
            </div>
          ) : null}

          <div className="panel" style={{ padding: 16, marginTop: 16 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 12,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontWeight: 600, fontSize: "var(--text-body-sm)" }}>
                Billing-period usage
              </span>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginLeft: "auto",
                  flexWrap: "wrap",
                }}
              >
                <select
                  aria-label="Usage metric filter"
                  value={usageFilters.metricKey}
                  disabled={usageFiltersDisabled}
                  onChange={(event) => {
                    const value = event.currentTarget.value as MeteringRollupMetricKey | "";
                    setUsageFilters((current) => ({ ...current, metricKey: value }));
                  }}
                  style={{ ...usageFilterStyle, minWidth: 170 }}
                >
                  <option value="">All metrics</option>
                  {USAGE_FILTER_METRICS.map(([metricKey, label]) => (
                    <option key={metricKey} value={metricKey}>
                      {label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Usage from date"
                  type="date"
                  value={usageFilters.from}
                  disabled={usageFiltersDisabled}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setUsageFilters((current) => ({ ...current, from: value }));
                  }}
                  style={{ ...usageFilterStyle, width: 132 }}
                />
                <input
                  aria-label="Usage to date"
                  type="date"
                  value={usageFilters.to}
                  disabled={usageFiltersDisabled}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setUsageFilters((current) => ({ ...current, to: value }));
                  }}
                  style={{ ...usageFilterStyle, width: 132 }}
                />
                <button
                  type="button"
                  className="btn sm"
                  disabled={usageFiltersDisabled}
                  /* `.btn` has no disabled styling in styles.css, so a disabled
                     Clear would still look pressable. */
                  style={usageFiltersDisabled ? DISABLED_CONTROL : undefined}
                  onClick={() => setUsageFilters({ from: "", to: "", metricKey: "" })}
                >
                  Clear
                </button>
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
              <div style={{ display: "grid", gap: 12 }}>
                {usageSummary === undefined || usageSummary.metrics.length === 0 ? null : (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                      gap: 12,
                    }}
                  >
                    {usageSummary.metrics.slice(0, 8).map((metric) => (
                      <UsageSummaryCard key={metric.metricKey} metric={metric} />
                    ))}
                  </div>
                )}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                    gap: 12,
                  }}
                >
                  {usageRollups.slice(0, 8).map((rollup) => (
                    <UsageRollupCard
                      key={`${rollup.periodStart}:${rollup.metricKey}`}
                      rollup={rollup}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="panel" style={{ padding: 16, marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontWeight: 600, fontSize: "var(--text-body-sm)" }}>
                Recent invoices
              </span>
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
              invoices.map((invoice, index) => (
                <div
                  key={invoice.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: INVOICE_GRID,
                    alignItems: "center",
                    height: 32,
                    fontSize: "var(--text-meta)",
                    borderTop: index ? "1px solid var(--border)" : "none",
                  }}
                >
                  <span className="mono">{invoice.invoiceNumber}</span>
                  <span style={{ color: "var(--text-2)" }}>
                    {formatDateLabel(invoice.issuedAt)}
                  </span>
                  <span>{formatMoney(invoice.amountCents, invoice.currency)}</span>
                  <span>
                    <span className={`chip ${invoice.status === "paid" ? "success" : "warning"}`}>
                      <span className="chip-dot" />
                      {invoice.status}
                    </span>
                  </span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </PageScroll>
  );
}

function UsageSummaryCard({ metric }: { readonly metric: UsageSummaryMetric }) {
  return (
    <article
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        minWidth: 0,
        background: "var(--surface-2)",
      }}
    >
      <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
        {USAGE_METRIC_LABELS[metric.metricKey] ?? metric.metricKey}
      </div>
      <div style={{ fontWeight: 700, marginTop: 4 }}>{formatUsageMetricQuantity(metric)}</div>
      <div style={{ fontSize: "var(--text-meta)", color: "var(--text-2)", marginTop: 4 }}>
        {metric.aggregation} over {metric.sampleCount} day{metric.sampleCount === 1 ? "" : "s"}
      </div>
    </article>
  );
}

function UsageRollupCard({ rollup }: { readonly rollup: UsageRollup }) {
  return (
    <article
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
        {USAGE_METRIC_LABELS[rollup.metricKey] ?? rollup.metricKey}
      </div>
      <div style={{ fontWeight: 700, marginTop: 4 }}>{formatUsageQuantity(rollup)}</div>
      <div style={{ fontSize: "var(--text-meta)", color: "var(--text-2)", marginTop: 4 }}>
        {formatUsagePeriod(rollup.periodStart)}
      </div>
    </article>
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
