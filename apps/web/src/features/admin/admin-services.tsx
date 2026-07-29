import { authenticatedFetch } from "@/lib/auth";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, CircleDashed, PlugZap } from "lucide-react";
import { useMemo, useState } from "react";

export type AdminServiceStatus = "ready" | "configured" | "missing" | "degraded" | "disabled";
export type AdminServiceCategory =
  "workspace" | "communication" | "platform" | "security" | "integrations" | "ai";
export type AdminDependencyType =
  | "database"
  | "object-storage"
  | "event-bus"
  | "cache"
  | "search"
  | "external-service"
  | "secret"
  | "runtime";

export interface AdminServiceDependency {
  readonly id: string;
  readonly label: string;
  readonly type: AdminDependencyType;
  readonly required: boolean;
  readonly status: AdminServiceStatus;
  readonly envKeys: readonly string[];
  readonly evidence: string;
}

export interface AdminServiceConfigItem {
  readonly key: string;
  readonly label: string;
  readonly envKeys: readonly string[];
  readonly configured: boolean;
  readonly sensitive: boolean;
  readonly status: AdminServiceStatus;
  readonly evidence: string;
}

export interface AdminServiceAction {
  readonly id: string;
  readonly label: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly requiredScope: string;
  readonly destructive: boolean;
}

export interface AdminServiceSurface {
  readonly id: string;
  readonly pluginId: string;
  readonly label: string;
  readonly summary: string;
  readonly category: AdminServiceCategory;
  readonly status: AdminServiceStatus;
  readonly enabled: boolean;
  readonly evidence: string;
  readonly scopes: readonly string[];
  readonly adminScopes: readonly string[];
  readonly uiRoutes: readonly string[];
  readonly apiRoutes: readonly string[];
  readonly realtimeRoutes: readonly string[];
  readonly tools: readonly string[];
  readonly capabilities: readonly string[];
  readonly consumes: readonly string[];
  readonly dataStores: readonly string[];
  readonly dependencies: readonly AdminServiceDependency[];
  readonly configuration: readonly AdminServiceConfigItem[];
  readonly aiSlots: readonly string[];
  readonly enrichments: readonly string[];
  readonly adminActions: readonly AdminServiceAction[];
  readonly metrics: readonly string[];
}

export interface AdminServicesResponse {
  readonly generatedAt: string;
  readonly services: readonly AdminServiceSurface[];
}

export const adminServicesQueryKey = ["admin", "services"] as const;

export function adminServicesQueryOptions() {
  return queryOptions({
    queryKey: adminServicesQueryKey,
    queryFn: fetchAdminServices,
    throwOnError: false,
  });
}

interface AdminServicesQueryClient {
  ensureQueryData(options: ReturnType<typeof adminServicesQueryOptions>): Promise<unknown>;
}

export async function prefetchAdminServicesQuery(queryClient: AdminServicesQueryClient) {
  await queryClient.ensureQueryData(adminServicesQueryOptions()).catch(() => undefined);
}

export function AdminServicesOverview() {
  const servicesQuery = useQuery(adminServicesQueryOptions());
  const services = useMemo(() => [...(servicesQuery.data?.services ?? [])], [servicesQuery.data]);
  const [selectedServiceId, setSelectedServiceId] = useState<string | undefined>();
  const selectedService =
    services.find((service) => service.id === selectedServiceId) ?? services[0] ?? undefined;
  const totals = useMemo(() => serviceTotals(services), [services]);

  return (
    <section className="admin-tier-panel" aria-labelledby="admin-services-title">
      <div className="admin-tier-panel-header">
        <div>
          <p className="admin-tier-kicker">Shared services</p>
          <h2 id="admin-services-title">Admin services</h2>
          <p>Runtime service surface, dependencies, routes, scopes, tools, and operations.</p>
        </div>
        {servicesQuery.data === undefined ? null : (
          <span className="text-xs font-semibold text-muted-foreground">
            Generated {formatTimestamp(servicesQuery.data.generatedAt)}
          </span>
        )}
      </div>

      {servicesQuery.isPending ? (
        <p role="status">Loading admin services</p>
      ) : servicesQuery.isError ? (
        <p role="alert">Admin services are unavailable or missing admin services scope.</p>
      ) : null}

      <div className="admin-ai-cost-grid">
        <ServiceSummaryCard
          title="Services"
          status={totals.disabled > 0 ? "configured" : totals.total > 0 ? "ready" : "missing"}
          rows={[
            ["Total", formatNumber(totals.total)],
            ["Enabled", formatNumber(totals.enabled)],
            ["Disabled", formatNumber(totals.disabled)],
          ]}
        />
        <ServiceSummaryCard
          title="Readiness"
          status={totals.missing > 0 || totals.degraded > 0 ? "degraded" : "ready"}
          rows={[
            ["Ready", formatNumber(totals.ready)],
            ["Configured", formatNumber(totals.configured)],
            ["Missing", formatNumber(totals.missing)],
            ["Degraded", formatNumber(totals.degraded)],
          ]}
        />
        <ServiceSummaryCard
          title="Operations"
          status="configured"
          rows={[
            ["Routes", formatNumber(totals.routes)],
            ["Tools", formatNumber(totals.tools)],
            ["Admin actions", formatNumber(totals.actions)],
          ]}
        />
        <ServiceSummaryCard
          title="Data and AI"
          status="configured"
          rows={[
            ["Data stores", formatNumber(totals.dataStores)],
            ["AI slots", formatNumber(totals.aiSlots)],
            ["Enrichments", formatNumber(totals.enrichments)],
          ]}
        />
      </div>

      <Table aria-label="Admin services" className="admin-tier-table" role="table">
        <TableHeader>
          <TableRow role="row">
            <TableHead role="columnheader">Service</TableHead>
            <TableHead role="columnheader">Plugin</TableHead>
            <TableHead role="columnheader">Status</TableHead>
            <TableHead role="columnheader">Category</TableHead>
            <TableHead role="columnheader">Dependencies</TableHead>
            <TableHead role="columnheader">Routes</TableHead>
            <TableHead role="columnheader">Tools</TableHead>
            <TableHead role="columnheader">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {services.length === 0 ? (
            <TableRow role="row">
              <TableCell colSpan={8} role="cell">
                {servicesQuery.isPending ? "Loading service catalog..." : "No services reported."}
              </TableCell>
            </TableRow>
          ) : (
            services.map((service) => (
              <TableRow
                aria-selected={selectedService?.id === service.id}
                key={service.id}
                onClick={() => setSelectedServiceId(service.id)}
                role="row"
              >
                <TableCell role="cell">
                  <button
                    className="text-left font-medium text-foreground"
                    onClick={() => setSelectedServiceId(service.id)}
                    type="button"
                  >
                    {service.label}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {service.id}
                    </span>
                  </button>
                </TableCell>
                <TableCell className="max-w-[220px] truncate" role="cell">
                  {service.pluginId}
                </TableCell>
                <TableCell role="cell">
                  {statusLabel(service.status)} / {service.enabled ? "Enabled" : "Disabled"}
                </TableCell>
                <TableCell role="cell">{categoryLabel(service.category)}</TableCell>
                <TableCell role="cell">{dependenciesSummary(service.dependencies)}</TableCell>
                <TableCell role="cell">{formatNumber(routeCount(service))}</TableCell>
                <TableCell role="cell">{formatNumber(service.tools.length)}</TableCell>
                <TableCell role="cell">{formatNumber(service.adminActions.length)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {selectedService === undefined ? null : <ServiceDetail service={selectedService} />}
    </section>
  );
}

async function fetchAdminServices(): Promise<AdminServicesResponse> {
  const response = await authenticatedFetch("/api/admin/services");
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ?? `Admin services failed with ${response.status}`,
    );
  }
  if (!isAdminServicesResponse(output)) {
    throw new Error("Admin services response was missing required fields.");
  }
  return output;
}

function ServiceSummaryCard({
  rows,
  status,
  title,
}: {
  readonly rows: readonly (readonly [string, string])[];
  readonly status: AdminServiceStatus;
  readonly title: string;
}) {
  const Icon = statusIcon(status);
  return (
    <article className="admin-ai-cost-card" data-status={status}>
      <Icon aria-hidden="true" size={18} />
      <div>
        <h3>{title}</h3>
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </article>
  );
}

function ServiceDetail({ service }: { readonly service: AdminServiceSurface }) {
  return (
    <section
      className="mt-4 rounded-lg border bg-card p-4"
      aria-labelledby="admin-service-detail-title"
    >
      <div className="mb-3 flex flex-col gap-1 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="admin-tier-kicker">{service.pluginId}</p>
          <h3 id="admin-service-detail-title" className="text-lg font-semibold">
            {service.label} detail
          </h3>
          <p className="max-w-4xl text-sm text-muted-foreground">{service.evidence}</p>
        </div>
        <span className="text-xs font-semibold text-muted-foreground">
          {statusLabel(service.status)} / {service.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <DetailList title="Routes" rows={routeRows(service)} />
        <DetailList
          title="Scopes"
          rows={[
            ["User", listLabel(service.scopes)],
            ["Admin", listLabel(service.adminScopes)],
          ]}
        />
        <DetailList
          title="Capabilities"
          rows={[
            ["Provides", listLabel(service.capabilities)],
            ["Consumes", listLabel(service.consumes)],
          ]}
        />
        <DetailList
          title="Data"
          rows={[
            ["Stores", listLabel(service.dataStores)],
            ["Config keys", configSummary(service.configuration)],
          ]}
        />
        <DetailList
          title="AI"
          rows={[
            ["Slots", listLabel(service.aiSlots)],
            ["Enrichments", listLabel(service.enrichments)],
          ]}
        />
        <DetailList
          title="Operations"
          rows={[
            ["Metrics", listLabel(service.metrics)],
            ["Actions", actionsLabel(service.adminActions)],
          ]}
        />
      </div>

      <Table
        aria-label={`${service.label} dependencies`}
        className="admin-tier-table mt-4"
        role="table"
      >
        <TableHeader>
          <TableRow role="row">
            <TableHead role="columnheader">Dependency</TableHead>
            <TableHead role="columnheader">Type</TableHead>
            <TableHead role="columnheader">Required</TableHead>
            <TableHead role="columnheader">Status</TableHead>
            <TableHead role="columnheader">Evidence</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {service.dependencies.length === 0 ? (
            <TableRow role="row">
              <TableCell colSpan={5} role="cell">
                No dependencies reported.
              </TableCell>
            </TableRow>
          ) : (
            service.dependencies.map((dependency) => (
              <TableRow key={dependency.id} role="row">
                <TableCell role="cell">
                  <span className="font-medium">{dependency.label}</span>
                  <span className="block text-xs text-muted-foreground">{dependency.id}</span>
                </TableCell>
                <TableCell role="cell">{dependency.type}</TableCell>
                <TableCell role="cell">{dependency.required ? "Required" : "Optional"}</TableCell>
                <TableCell role="cell">{statusLabel(dependency.status)}</TableCell>
                <TableCell className="max-w-[360px] truncate" role="cell">
                  {dependency.evidence}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  );
}

function DetailList({
  rows,
  title,
}: {
  readonly rows: readonly (readonly [string, string])[];
  readonly title: string;
}) {
  return (
    <article className="rounded-lg border p-3">
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      <dl className="grid gap-2 text-xs">
        {rows.map(([label, value]) => (
          <div className="grid gap-1" key={label}>
            <dt className="font-semibold text-muted-foreground">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function serviceTotals(services: readonly AdminServiceSurface[]) {
  return services.reduce(
    (totals, service) => ({
      total: totals.total + 1,
      enabled: totals.enabled + (service.enabled ? 1 : 0),
      disabled: totals.disabled + (service.enabled ? 0 : 1),
      ready: totals.ready + (service.status === "ready" ? 1 : 0),
      configured: totals.configured + (service.status === "configured" ? 1 : 0),
      missing: totals.missing + (service.status === "missing" ? 1 : 0),
      degraded: totals.degraded + (service.status === "degraded" ? 1 : 0),
      routes: totals.routes + routeCount(service),
      tools: totals.tools + service.tools.length,
      actions: totals.actions + service.adminActions.length,
      dataStores: totals.dataStores + service.dataStores.length,
      aiSlots: totals.aiSlots + service.aiSlots.length,
      enrichments: totals.enrichments + service.enrichments.length,
    }),
    {
      actions: 0,
      aiSlots: 0,
      configured: 0,
      dataStores: 0,
      degraded: 0,
      disabled: 0,
      enabled: 0,
      enrichments: 0,
      missing: 0,
      ready: 0,
      routes: 0,
      tools: 0,
      total: 0,
    },
  );
}

function routeRows(service: AdminServiceSurface): readonly (readonly [string, string])[] {
  return [
    ["UI", listLabel(service.uiRoutes)],
    ["API", listLabel(service.apiRoutes)],
    ["Realtime", listLabel(service.realtimeRoutes)],
  ];
}

function routeCount(service: AdminServiceSurface): number {
  return service.uiRoutes.length + service.apiRoutes.length + service.realtimeRoutes.length;
}

function dependenciesSummary(dependencies: readonly AdminServiceDependency[]): string {
  if (dependencies.length === 0) {
    return "-";
  }
  const requiredMissing = dependencies.filter(
    (dependency) => dependency.required && dependency.status === "missing",
  ).length;
  return `${formatNumber(dependencies.length)} total, ${formatNumber(requiredMissing)} required missing`;
}

function configSummary(configuration: readonly AdminServiceConfigItem[]): string {
  if (configuration.length === 0) {
    return "-";
  }
  return configuration
    .map(
      (item) =>
        `${item.key} (${item.sensitive ? "sensitive" : "plain"}: ${statusLabel(item.status)})`,
    )
    .join(", ");
}

function actionsLabel(actions: readonly AdminServiceAction[]): string {
  if (actions.length === 0) {
    return "-";
  }
  return actions
    .map((action) => `${action.method} ${action.path} [${action.requiredScope}]`)
    .join(", ");
}

function listLabel(values: readonly string[]): string {
  return values.length === 0 ? "-" : values.join(", ");
}

function statusIcon(status: AdminServiceStatus) {
  switch (status) {
    case "ready":
      return CheckCircle2;
    case "configured":
      return PlugZap;
    case "missing":
    case "degraded":
      return CircleAlert;
    case "disabled":
      return CircleDashed;
  }
}

function statusLabel(status: AdminServiceStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "configured":
      return "Configured";
    case "missing":
      return "Missing";
    case "degraded":
      return "Degraded";
    case "disabled":
      return "Disabled";
  }
}

function categoryLabel(category: AdminServiceCategory): string {
  switch (category) {
    case "workspace":
      return "Workspace";
    case "communication":
      return "Communication";
    case "platform":
      return "Platform";
    case "security":
      return "Security";
    case "integrations":
      return "Integrations";
    case "ai":
      return "AI";
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTimestamp(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function isAdminServicesResponse(value: unknown): value is AdminServicesResponse {
  return (
    isRecord(value) &&
    typeof value.generatedAt === "string" &&
    Array.isArray(value.services) &&
    value.services.every(isAdminServiceSurface)
  );
}

function isAdminServiceSurface(value: unknown): value is AdminServiceSurface {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.pluginId === "string" &&
    typeof value.label === "string" &&
    typeof value.summary === "string" &&
    isAdminServiceCategory(value.category) &&
    isAdminServiceStatus(value.status) &&
    typeof value.enabled === "boolean" &&
    typeof value.evidence === "string" &&
    isStringArray(value.scopes) &&
    isStringArray(value.adminScopes) &&
    isStringArray(value.uiRoutes) &&
    isStringArray(value.apiRoutes) &&
    isStringArray(value.realtimeRoutes) &&
    isStringArray(value.tools) &&
    isStringArray(value.capabilities) &&
    isStringArray(value.consumes) &&
    isStringArray(value.dataStores) &&
    Array.isArray(value.dependencies) &&
    value.dependencies.every(isAdminServiceDependency) &&
    Array.isArray(value.configuration) &&
    value.configuration.every(isAdminServiceConfigItem) &&
    isStringArray(value.aiSlots) &&
    isStringArray(value.enrichments) &&
    Array.isArray(value.adminActions) &&
    value.adminActions.every(isAdminServiceAction) &&
    isStringArray(value.metrics)
  );
}

function isAdminServiceDependency(value: unknown): value is AdminServiceDependency {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    isAdminDependencyType(value.type) &&
    typeof value.required === "boolean" &&
    isAdminServiceStatus(value.status) &&
    isStringArray(value.envKeys) &&
    typeof value.evidence === "string"
  );
}

function isAdminServiceConfigItem(value: unknown): value is AdminServiceConfigItem {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.label === "string" &&
    isStringArray(value.envKeys) &&
    typeof value.configured === "boolean" &&
    typeof value.sensitive === "boolean" &&
    isAdminServiceStatus(value.status) &&
    typeof value.evidence === "string"
  );
}

function isAdminServiceAction(value: unknown): value is AdminServiceAction {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    isActionMethod(value.method) &&
    typeof value.path === "string" &&
    typeof value.requiredScope === "string" &&
    typeof value.destructive === "boolean"
  );
}

function isAdminServiceStatus(value: unknown): value is AdminServiceStatus {
  return (
    value === "ready" ||
    value === "configured" ||
    value === "missing" ||
    value === "degraded" ||
    value === "disabled"
  );
}

function isAdminServiceCategory(value: unknown): value is AdminServiceCategory {
  return (
    value === "workspace" ||
    value === "communication" ||
    value === "platform" ||
    value === "security" ||
    value === "integrations" ||
    value === "ai"
  );
}

function isAdminDependencyType(value: unknown): value is AdminDependencyType {
  return (
    value === "database" ||
    value === "object-storage" ||
    value === "event-bus" ||
    value === "cache" ||
    value === "search" ||
    value === "external-service" ||
    value === "secret" ||
    value === "runtime"
  );
}

function isActionMethod(value: unknown): value is AdminServiceAction["method"] {
  return value === "GET" || value === "POST" || value === "PATCH" || value === "DELETE";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error === "string" ? output.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
