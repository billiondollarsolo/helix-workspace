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
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import {
  CheckCircle2,
  CircleDashed,
  MailCheck,
  RadioTower,
  Send,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";

type MailStatus = "ready" | "configured" | "missing" | "unknown";
type MailProvider = "smtp" | "ses" | "none";
type DNSRecordType = "MX" | "SPF" | "DKIM" | "DMARC";

export interface AdminMailConfigurationResponse {
  readonly generatedAt: string;
  readonly inboundReceiver: {
    readonly enabled: boolean;
    readonly status: MailStatus;
    readonly host: string | null;
    readonly port: number | null;
    readonly orgId: string | null;
    readonly evidence: string;
  };
  readonly outboundRelay: {
    readonly configured: boolean;
    readonly status: MailStatus;
    readonly provider: MailProvider;
    readonly host: string | null;
    readonly port: number | null;
    readonly secure: boolean | null;
    readonly authConfigured: boolean;
    readonly evidence: string;
  };
  readonly domains: readonly AdminMailDomain[];
  readonly quotas: {
    readonly perActorPerHour: number;
    readonly perActorPerDay: number;
    readonly maxMessageBytes: number | null;
    readonly evidence: string;
  };
  readonly deliveryHealth: {
    readonly since: string;
    readonly counts: {
      readonly queued: number;
      readonly sending: number;
      readonly sent: number;
      readonly failed: number;
      readonly cancelled: number;
    };
    readonly failedLast24h: number;
    readonly lastFailureAt: string | null;
    readonly lastError: string | null;
  };
}

export interface AdminMailDomain {
  readonly domain: string;
  readonly defaultFrom: boolean;
  readonly records: readonly AdminMailDNSRecord[];
}

export interface AdminMailDNSRecord {
  readonly type: DNSRecordType;
  readonly status: MailStatus;
  readonly expected?: string;
  readonly evidence: string;
}

interface DNSRecordRow extends AdminMailDNSRecord {
  readonly id: string;
  readonly domain: string;
  readonly defaultFrom: boolean;
}

export const adminMailConfigurationQueryKey = ["admin", "mail", "configuration"] as const;

export function adminMailConfigurationQueryOptions() {
  return queryOptions({
    queryKey: adminMailConfigurationQueryKey,
    queryFn: fetchAdminMailConfiguration,
    throwOnError: false,
  });
}

interface AdminMailConfigurationQueryClient {
  ensureQueryData(options: ReturnType<typeof adminMailConfigurationQueryOptions>): Promise<unknown>;
}

export async function prefetchAdminMailConfigurationQuery(
  queryClient: AdminMailConfigurationQueryClient,
) {
  await queryClient.ensureQueryData(adminMailConfigurationQueryOptions()).catch(() => undefined);
}

export function MailConfiguration() {
  const mailConfigQuery = useQuery(adminMailConfigurationQueryOptions());
  const config = mailConfigQuery.data;
  const dnsRows = useMemo(() => domainRecordRows(config?.domains ?? []), [config?.domains]);
  const dnsColumns = useMemo<ColumnDef<DNSRecordRow>[]>(
    () => [
      {
        accessorKey: "domain",
        header: "Domain",
        cell: ({ row }) =>
          row.original.defaultFrom ? `${row.original.domain} (default)` : row.original.domain,
      },
      { accessorKey: "type", header: "Record" },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => statusLabel(row.original.status),
      },
      {
        accessorKey: "expected",
        header: "Expected",
        cell: ({ row }) => row.original.expected ?? "-",
      },
      { accessorKey: "evidence", header: "Evidence" },
    ],
    [],
  );
  const dnsTable = useReactTable({
    columns: dnsColumns,
    data: dnsRows,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  return (
    <section className="admin-tier-panel" aria-labelledby="admin-mail-configuration-title">
      <div className="admin-tier-panel-header">
        <div>
          <p className="admin-tier-kicker">Mail control plane</p>
          <h2 id="admin-mail-configuration-title">Mail configuration</h2>
          <p>
            Operational readiness for inbound SMTP, outbound relay, domain DNS, quotas, and delivery
            health.
          </p>
        </div>
        {config === undefined ? null : (
          <span className="text-xs font-semibold text-muted-foreground">
            Generated {formatTimestamp(config.generatedAt)}
          </span>
        )}
      </div>

      {mailConfigQuery.isPending ? (
        <p role="status">Loading mail configuration</p>
      ) : mailConfigQuery.isError ? (
        <p role="alert">
          Mail configuration is unavailable or missing admin mail configuration scope.
        </p>
      ) : null}

      <div className="admin-ai-cost-grid">
        <MailStatusCard
          icon={MailCheck}
          title="Inbound receiver"
          status={config?.inboundReceiver.status ?? "unknown"}
          rows={[
            ["Enabled", formatBoolean(config?.inboundReceiver.enabled)],
            ["Endpoint", endpointLabel(config?.inboundReceiver.host, config?.inboundReceiver.port)],
            ["Org", config?.inboundReceiver.orgId ?? "-"],
            ["Evidence", config?.inboundReceiver.evidence ?? "Waiting for mail config API"],
          ]}
        />
        <MailStatusCard
          icon={Send}
          title="Outbound relay"
          status={config?.outboundRelay.status ?? "unknown"}
          rows={[
            ["Provider", providerLabel(config?.outboundRelay.provider)],
            ["Relay", endpointLabel(config?.outboundRelay.host, config?.outboundRelay.port)],
            ["TLS", secureLabel(config?.outboundRelay.secure)],
            ["Auth", formatBoolean(config?.outboundRelay.authConfigured)],
            ["Evidence", config?.outboundRelay.evidence ?? "Waiting for relay config"],
          ]}
        />
        <MailStatusCard
          icon={ShieldAlert}
          title="Domains"
          status={domainsStatus(config?.domains)}
          rows={[
            ["Configured", String(config?.domains.length ?? 0)],
            ["Default from", defaultFromDomain(config?.domains)],
            ["DNS records", String(dnsRows.length)],
            [
              "Evidence",
              dnsRows.length === 0 ? "No domain DNS records reported" : "DNS checks reported",
            ],
          ]}
        />
        <MailStatusCard
          icon={RadioTower}
          title="Delivery health"
          status={deliveryStatus(config)}
          rows={[
            ["Since", formatTimestamp(config?.deliveryHealth.since)],
            ["Sent", formatNumber(config?.deliveryHealth.counts.sent)],
            ["Failed 24h", formatNumber(config?.deliveryHealth.failedLast24h)],
            ["Last error", config?.deliveryHealth.lastError ?? "-"],
          ]}
        />
      </div>

      {config === undefined ? null : (
        <div className="admin-ai-cost-grid">
          <MailStatusCard
            icon={CircleDashed}
            title="Quotas"
            status="configured"
            rows={[
              ["Per actor hour", formatNumber(config.quotas.perActorPerHour)],
              ["Per actor day", formatNumber(config.quotas.perActorPerDay)],
              ["Max size", formatBytes(config.quotas.maxMessageBytes)],
              ["Evidence", config.quotas.evidence],
            ]}
          />
          <MailStatusCard
            icon={CheckCircle2}
            title="Delivery counts"
            status={deliveryStatus(config)}
            rows={[
              ["Queued", formatNumber(config.deliveryHealth.counts.queued)],
              ["Sending", formatNumber(config.deliveryHealth.counts.sending)],
              ["Failed", formatNumber(config.deliveryHealth.counts.failed)],
              ["Cancelled", formatNumber(config.deliveryHealth.counts.cancelled)],
              ["Last failure", formatTimestamp(config.deliveryHealth.lastFailureAt)],
            ]}
          />
        </div>
      )}

      <Table aria-label="Mail DNS records" className="admin-tier-table" role="table">
        <TableHeader>
          {dnsTable.getHeaderGroups().map((headerGroup) => (
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
          {dnsRows.length === 0 ? (
            <TableRow role="row">
              <TableCell colSpan={dnsColumns.length} role="cell">
                {mailConfigQuery.isPending
                  ? "Loading DNS records..."
                  : "No mail DNS records reported."}
              </TableCell>
            </TableRow>
          ) : (
            dnsTable.getRowModel().rows.map((row) => (
              <TableRow key={row.id} role="row">
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} role="cell">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  );
}

async function fetchAdminMailConfiguration(): Promise<AdminMailConfigurationResponse> {
  const response = await authenticatedFetch("/api/admin/mail/config");
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ?? `Mail config request failed with ${response.status}`,
    );
  }
  if (!isAdminMailConfigurationResponse(output)) {
    throw new Error("Mail configuration response was missing required fields.");
  }
  return output;
}

function MailStatusCard({
  icon: Icon,
  rows,
  status,
  title,
}: {
  readonly icon: LucideIcon;
  readonly rows: readonly (readonly [string, string])[];
  readonly status: MailStatus;
  readonly title: string;
}) {
  return (
    <article className="admin-ai-cost-card" data-status={status}>
      <Icon aria-hidden="true" size={18} />
      <div>
        <h3>{title}</h3>
        <dl>
          <div>
            <dt>Status</dt>
            <dd>{statusLabel(status)}</dd>
          </div>
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

function domainRecordRows(domains: readonly AdminMailDomain[]): DNSRecordRow[] {
  return domains.flatMap((domain) =>
    domain.records.map((record, index) => ({
      ...record,
      defaultFrom: domain.defaultFrom,
      domain: domain.domain,
      id: `${domain.domain}:${record.type}:${index}`,
    })),
  );
}

function domainsStatus(domains: readonly AdminMailDomain[] | undefined): MailStatus {
  if (domains === undefined || domains.length === 0) {
    return "unknown";
  }
  const records = domains.flatMap((domain) => domain.records);
  if (records.length === 0) {
    return "missing";
  }
  if (records.some((record) => record.status === "missing")) {
    return "missing";
  }
  if (records.some((record) => record.status === "unknown")) {
    return "unknown";
  }
  if (records.some((record) => record.status === "configured")) {
    return "configured";
  }
  return "ready";
}

function deliveryStatus(config: AdminMailConfigurationResponse | undefined): MailStatus {
  if (config === undefined) {
    return "unknown";
  }
  return config.deliveryHealth.failedLast24h > 0 ? "configured" : "ready";
}

function statusLabel(status: MailStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "configured":
      return "Configured";
    case "missing":
      return "Missing";
    case "unknown":
      return "Unknown";
  }
}

function providerLabel(provider: MailProvider | undefined): string {
  switch (provider) {
    case "smtp":
      return "SMTP";
    case "ses":
      return "SES";
    case "none":
      return "None";
    case undefined:
      return "-";
  }
}

function endpointLabel(host: string | null | undefined, port: number | null | undefined): string {
  if (host === undefined || host === null || host.length === 0) {
    return "-";
  }
  return port === undefined || port === null ? host : `${host}:${String(port)}`;
}

function secureLabel(value: boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }
  return value ? "TLS enabled" : "TLS disabled";
}

function defaultFromDomain(domains: readonly AdminMailDomain[] | undefined): string {
  return domains?.find((domain) => domain.defaultFrom)?.domain ?? "-";
}

function formatBoolean(value: boolean | undefined): string {
  return value === undefined ? "-" : value ? "Yes" : "No";
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "-" : new Intl.NumberFormat("en-US").format(value);
}

function formatBytes(value: number | null): string;
function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (value < 1024) {
    return `${String(value)} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(size)} ${units[unitIndex]}`;
}

function formatTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) {
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

function isAdminMailConfigurationResponse(value: unknown): value is AdminMailConfigurationResponse {
  return (
    isRecord(value) &&
    typeof value.generatedAt === "string" &&
    isInboundReceiver(value.inboundReceiver) &&
    isOutboundRelay(value.outboundRelay) &&
    Array.isArray(value.domains) &&
    value.domains.every(isAdminMailDomain) &&
    isQuotas(value.quotas) &&
    isDeliveryHealth(value.deliveryHealth)
  );
}

function isInboundReceiver(
  value: unknown,
): value is AdminMailConfigurationResponse["inboundReceiver"] {
  return (
    isRecord(value) &&
    typeof value.enabled === "boolean" &&
    isMailStatus(value.status) &&
    isNullableString(value.host) &&
    isNullableNumber(value.port) &&
    isNullableString(value.orgId) &&
    typeof value.evidence === "string"
  );
}

function isOutboundRelay(value: unknown): value is AdminMailConfigurationResponse["outboundRelay"] {
  return (
    isRecord(value) &&
    typeof value.configured === "boolean" &&
    isMailStatus(value.status) &&
    isMailProvider(value.provider) &&
    isNullableString(value.host) &&
    isNullableNumber(value.port) &&
    (typeof value.secure === "boolean" || value.secure === null) &&
    typeof value.authConfigured === "boolean" &&
    typeof value.evidence === "string"
  );
}

function isAdminMailDomain(value: unknown): value is AdminMailDomain {
  return (
    isRecord(value) &&
    typeof value.domain === "string" &&
    typeof value.defaultFrom === "boolean" &&
    Array.isArray(value.records) &&
    value.records.every(isAdminMailDNSRecord)
  );
}

function isAdminMailDNSRecord(value: unknown): value is AdminMailDNSRecord {
  return (
    isRecord(value) &&
    isDNSRecordType(value.type) &&
    isMailStatus(value.status) &&
    (value.expected === undefined || typeof value.expected === "string") &&
    typeof value.evidence === "string"
  );
}

function isQuotas(value: unknown): value is AdminMailConfigurationResponse["quotas"] {
  return (
    isRecord(value) &&
    typeof value.perActorPerHour === "number" &&
    typeof value.perActorPerDay === "number" &&
    isNullableNumber(value.maxMessageBytes) &&
    typeof value.evidence === "string"
  );
}

function isDeliveryHealth(
  value: unknown,
): value is AdminMailConfigurationResponse["deliveryHealth"] {
  return (
    isRecord(value) &&
    typeof value.since === "string" &&
    isRecord(value.counts) &&
    typeof value.counts.queued === "number" &&
    typeof value.counts.sending === "number" &&
    typeof value.counts.sent === "number" &&
    typeof value.counts.failed === "number" &&
    typeof value.counts.cancelled === "number" &&
    typeof value.failedLast24h === "number" &&
    isNullableString(value.lastFailureAt) &&
    isNullableString(value.lastError)
  );
}

function isMailStatus(value: unknown): value is MailStatus {
  return value === "ready" || value === "configured" || value === "missing" || value === "unknown";
}

function isMailProvider(value: unknown): value is MailProvider {
  return value === "smtp" || value === "ses" || value === "none";
}

function isDNSRecordType(value: unknown): value is DNSRecordType {
  return value === "MX" || value === "SPF" || value === "DKIM" || value === "DMARC";
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isNullableNumber(value: unknown): value is number | null {
  return typeof value === "number" || value === null;
}

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error === "string" ? output.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
