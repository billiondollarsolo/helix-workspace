import {
  BadgeDollarSign,
  Gauge,
  RadioTower,
  Route,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AdminAiRelatedNav } from "@/features/admin/admin-related-nav";
import { PageHeading, StateBanner } from "@/features/admin/console/primitives";
import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { adminPlatformConfigQueryOptions, type TierId } from "./security-tier-readiness";

interface AdminAIObservabilityQueryClient {
  ensureQueryData(options: ReturnType<typeof adminPlatformConfigQueryOptions>): Promise<unknown>;
}

interface AIConfigStatus {
  readonly costLimits?: {
    readonly perUserPerDayUSD?: number;
    readonly perOrgPerDayUSD?: number;
    readonly perAgentPerDayUSD?: number;
  };
  readonly audit?: {
    readonly logRequests?: "off" | "metadata-only" | "full";
    readonly retainDays?: number;
  };
  readonly privacy?: {
    readonly redactPIIBeforeSend?: boolean;
    readonly classificationGating?: boolean;
    readonly blockExternalForClassifications?: readonly string[];
  };
}

interface AIMetricRow {
  readonly id: string;
  readonly metric: string;
  readonly dimension: string;
  readonly evidence: string;
  readonly status: "configured" | "dashboard" | "pending";
}

interface AIGovernanceRow {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: string;
  readonly evidence: string;
}

const metricRows: readonly AIMetricRow[] = [
  {
    id: "call-rate",
    metric: "LLM call rate",
    dimension: "provider, model, feature",
    evidence: "Bundled Grafana panel uses helix_llm_calls_total",
    status: "dashboard",
  },
  {
    id: "cost",
    metric: "Cost by provider, feature, and actor",
    dimension: "provider, model, feature, actor_id",
    evidence: "Bundled Grafana panels use helix_llm_cost_usd_micros_total",
    status: "dashboard",
  },
  {
    id: "latency",
    metric: "Latency percentiles",
    dimension: "provider, model",
    evidence: "Bundled Grafana panel uses helix_llm_latency_seconds_bucket",
    status: "dashboard",
  },
  {
    id: "errors",
    metric: "Error rate",
    dimension: "provider, model, feature",
    evidence: "Bundled Grafana panel uses helix_llm_errors_total",
    status: "dashboard",
  },
  {
    id: "fallback",
    metric: "Routing fallback rate",
    dimension: "provider, feature",
    evidence: "Bundled Grafana panel uses helix_llm_routing_fallback_total",
    status: "dashboard",
  },
  {
    id: "top-actors",
    metric: "Top-cost actors",
    dimension: "actor_id",
    evidence: "Live actor spend requires Prometheus/Grafana runtime data",
    status: "pending",
  },
];

export async function prefetchAdminAIObservabilityQuery(
  queryClient: AdminAIObservabilityQueryClient,
) {
  await queryClient.ensureQueryData(adminPlatformConfigQueryOptions()).catch(() => undefined);
}

export function AIObservabilityDashboard() {
  const platformConfigQuery = useQuery(adminPlatformConfigQueryOptions());
  const platformConfig = platformConfigQuery.data;
  // No governance cards until the config actually loads: the tier decides what
  // the blank fields fall back to, so guessing a tier would put invented
  // budgets and an invented gating state on a security surface.
  const governanceRows = useMemo<readonly AIGovernanceRow[]>(
    () =>
      platformConfig === undefined
        ? []
        : aiGovernanceRows(platformConfig.config.security.tier, platformConfig.config.ai),
    [platformConfig],
  );
  const metricColumns = useMemo<ColumnDef<AIMetricRow>[]>(
    () => [
      { accessorKey: "metric", header: "Metric" },
      { accessorKey: "dimension", header: "Breakdown" },
      { accessorKey: "evidence", header: "Evidence" },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => statusLabel(row.original.status),
      },
    ],
    [],
  );
  const metricTable = useReactTable({
    columns: metricColumns,
    data: [...metricRows],
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  return (
    // No PageScroll: `ai-observability` is registered through `withPageScroll`
    // in admin-console.tsx, so the scroll container already wraps this.
    <>
      <PageHeading
        title="Observability"
        subtitle="Spend, audit, and privacy controls in force for AI calls, plus which metrics already have a provisioned dashboard panel. Live series are read in Grafana, not here. Keys and models are under AI providers."
      />
      <AdminAiRelatedNav current="ai-observability" />

      {platformConfigQuery.isPending ? (
        <StateBanner kind="loading">Loading observability config…</StateBanner>
      ) : null}
      {platformConfigQuery.isError ? (
        <StateBanner kind="error">
          Observability config is unavailable or missing admin config scope.
        </StateBanner>
      ) : null}

      <div className="admin-tier-page">
        {governanceRows.length === 0 ? null : (
          <section className="admin-tier-panel" aria-labelledby="admin-ai-governance-title">
            <div className="admin-tier-panel-header">
              <div>
                <p className="admin-tier-kicker">AI governance</p>
                <h2 id="admin-ai-governance-title">Controls in force</h2>
                <p>
                  Budgets, request auditing, and classification gating as this org resolves them.
                </p>
              </div>
            </div>

            <div className="admin-ai-cost-grid">
              {governanceRows.map((row) => (
                <article className="admin-ai-cost-card" key={row.id}>
                  <row.icon aria-hidden="true" size={18} />
                  <div>
                    <h3>{row.label}</h3>
                    <dl>
                      <div>
                        <dt>Configured</dt>
                        <dd>{row.value}</dd>
                      </div>
                      <div>
                        <dt>Evidence</dt>
                        <dd>{row.evidence}</dd>
                      </div>
                    </dl>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        <section className="admin-tier-panel" aria-labelledby="admin-ai-metrics-title">
          <div className="admin-tier-panel-header">
            <div>
              <p className="admin-tier-kicker">Dashboard coverage</p>
              <h2 id="admin-ai-metrics-title">Required AI metrics</h2>
              <p>
                Each metric the PRD requires, the breakdown it must support, and the panel or
                telemetry that backs it.
              </p>
            </div>
          </div>

          <Table aria-label="AI observability metrics" className="admin-tier-table" role="table">
            <TableHeader>
              {metricTable.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} role="row">
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} role="columnheader">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {metricTable.getRowModel().rows.map((row) => (
                <TableRow key={row.id} role="row">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} role="cell">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      </div>
    </>
  );
}

function aiGovernanceRows(
  tier: TierId,
  aiConfig: AIConfigStatus | undefined,
): readonly AIGovernanceRow[] {
  const limits = aiConfig?.costLimits;
  const audit = aiConfig?.audit;
  const privacy = aiConfig?.privacy;
  return [
    {
      id: "budget",
      icon: BadgeDollarSign,
      label: "Cost budgets",
      value: [
        `User ${formatUsdLimit(limits?.perUserPerDayUSD)}`,
        `Org ${formatUsdLimit(limits?.perOrgPerDayUSD)}`,
        `Agent ${formatUsdLimit(limits?.perAgentPerDayUSD)}`,
      ].join(" / "),
      evidence:
        limits === undefined
          ? `${titleForTier(tier)} tier defaults active`
          : "Live admin config override connected",
    },
    {
      id: "audit",
      icon: RadioTower,
      // There is no platform default for `logRequests`: an unset field means
      // nobody has chosen a mode, not that metadata-only logging is running.
      // Naming a mode here would be a false claim on an audit surface.
      label: "Request audit",
      value: audit?.logRequests ?? "Not configured",
      evidence:
        audit?.retainDays === undefined
          ? "Retention follows platform audit policy"
          : `${String(audit.retainDays)} day retention`,
    },
    {
      id: "privacy",
      icon: TriangleAlert,
      label: "Classification gating",
      value: classificationGatingLabel(tier, privacy?.classificationGating),
      evidence:
        privacy?.blockExternalForClassifications === undefined ||
        privacy.blockExternalForClassifications.length === 0
          ? "No external-AI classification blocks configured"
          : `Blocks ${privacy.blockExternalForClassifications.map(formatValue).join(", ")}`,
    },
    {
      id: "telemetry",
      icon: Gauge,
      label: "Live telemetry",
      value: "Pending runtime evidence",
      evidence: "Metrics table is provisioned; live Prometheus data requires a running stack",
    },
    {
      id: "routing",
      icon: Route,
      label: "Routing fallback",
      value: "Dashboard panel provisioned",
      evidence: "Runtime fallback rates appear when provider routing emits metrics",
    },
  ];
}

/* Mirrors the server gate (platform/ai/classification/gating.ts): every tier
 * except personal gates classified content unless the org sets the flag, so an
 * unset flag is not the same answer on every tier. */
function classificationGatingLabel(tier: TierId, override: boolean | undefined): string {
  return (override ?? tier !== "personal") ? "Enabled" : "Disabled";
}

function statusLabel(status: AIMetricRow["status"]): string {
  switch (status) {
    case "configured":
      return "Configured";
    case "dashboard":
      return "Dashboard provisioned";
    case "pending":
      return "Pending live telemetry";
  }
}

function formatUsdLimit(value: number | undefined): string {
  if (value === undefined) {
    return "tier default";
  }
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function formatValue(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function titleForTier(tier: TierId): string {
  switch (tier) {
    case "personal":
      return "Personal";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    case "sovereign":
      return "Sovereign";
  }
}
