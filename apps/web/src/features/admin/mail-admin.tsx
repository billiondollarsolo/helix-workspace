/* Helix Admin — Mail section.
 *
 * Production TSX for the Admin console's "Mail" section. Five sub-views wired
 * to the mail-delivery admin backend (`/api/admin/mail/*`) via TanStack Query:
 *   - Outbound providers  — list, add (kind-specific config), choose default
 *   - Sending domains     — list/add/delete, per-domain DKIM gen + rotate,
 *                           SPF/DKIM/DMARC verification badges
 *   - Deliverability      — DMARC aggregate report summary (pass/fail rates)
 *   - Routing rules       — list/add/edit/delete inbound rules
 *   - Spam filtering      — spamd threshold + daemon status (read view)
 *
 * Visual style matches the rest of the Admin console: tokens-only inline
 * styles, `.panel` / `.chip` / `.btn` classes, no hard-coded colors.
 */

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import {
  createMailProvider,
  createRoutingRule,
  createSendingDomain,
  deleteRoutingRule,
  deleteSendingDomain,
  generateDkimKey,
  mailAdminQueryKeys,
  mailDmarcQueryOptions,
  mailProviderKindLabels,
  mailProvidersQueryOptions,
  MAIL_PROVIDER_KINDS,
  patchRoutingRule,
  rotateDkimKey,
  routingActionLabels,
  routingRulesQueryOptions,
  ROUTING_ACTIONS,
  sendingDomainsQueryOptions,
  setDefaultMailProvider,
  spamSettingsQueryOptions,
  type MailProviderConfig,
  type MailProviderKind,
  type RoutingAction,
  type RoutingRule,
  type VerificationState,
} from "@/features/admin/mail-admin-api";

/* ------------------------------------------------------------------ */
/* Mail sub-navigation                                                */
/* ------------------------------------------------------------------ */

export const MAIL_SUBVIEWS = [
  { id: "providers", label: "Outbound providers" },
  { id: "domains", label: "Sending domains" },
  { id: "deliverability", label: "Deliverability" },
  { id: "routing", label: "Routing rules" },
  { id: "spam", label: "Spam filtering" },
] as const;

export type MailSubviewId = (typeof MAIL_SUBVIEWS)[number]["id"];

/* ------------------------------------------------------------------ */
/* Shared layout primitives (mirror admin-console.tsx)                */
/* ------------------------------------------------------------------ */

function PageScroll({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: 24, overflowY: "auto", flex: 1 }}>{children}</div>
  );
}

function PageHeading({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div style={{ marginBottom: subtitle ? 20 : 16 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <h1 style={{ fontSize: "var(--text-h2)", fontWeight: 600, margin: 0 }}>{title}</h1>
        {actions ? (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {actions}
          </div>
        ) : null}
      </div>
      {subtitle ? (
        <div style={{ fontSize: "var(--text-body-sm)", color: "var(--text-3)", marginTop: 4 }}>
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

const HEADER_CELL: CSSProperties = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: ".06em",
};

const INPUT_STYLE: CSSProperties = {
  height: 30,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  padding: "0 8px",
  fontSize: "var(--text-meta)",
};

function StateBanner({ kind, children }: { kind: "loading" | "error"; children: ReactNode }) {
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      style={{
        padding: "10px 12px",
        borderRadius: 6,
        fontSize: "var(--text-meta)",
        marginBottom: 12,
        background: kind === "error" ? "var(--danger-soft, var(--surface-2))" : "var(--surface-2)",
        color: kind === "error" ? "var(--danger)" : "var(--text-2)",
        border: "1px solid var(--border)",
      }}
    >
      {children}
    </div>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: 32,
        textAlign: "center",
        fontSize: "var(--text-body-sm)",
        color: "var(--text-3)",
      }}
    >
      {children}
    </div>
  );
}

function VerificationBadge({ label, state }: { label: string; state: VerificationState }) {
  const variant =
    state === "verified" ? "success" : state === "pending" ? "warning" : "danger";
  return (
    <span className={`chip ${variant}`} title={`${label}: ${state}`}>
      <span className="chip-dot" />
      {label}
    </span>
  );
}

/* ================================================================== */
/* Outbound providers                                                 */
/* ================================================================== */

const PROVIDERS_GRID = "1fr 130px 1.6fr 90px 110px";

const EMPTY_PROVIDER_CONFIG: MailProviderConfig = {
  apiKeyRef: "",
  region: "",
  domain: "",
  host: "",
  port: null,
};

function configSummary(kind: MailProviderKind, config: MailProviderConfig): string {
  switch (kind) {
    case "ses":
      return `region ${config.region ?? "—"} · key ${config.apiKeyRef ?? "—"}`;
    case "mailgun":
      return `domain ${config.domain ?? "—"} · key ${config.apiKeyRef ?? "—"}`;
    case "postmark":
      return `key ${config.apiKeyRef ?? "—"}`;
    case "smtp":
      return `host ${config.host ?? "—"}:${config.port ?? "—"}`;
  }
}

interface ProviderFormProps {
  readonly onCancel: () => void;
  readonly onSubmit: (input: {
    name: string;
    kind: MailProviderKind;
    config: MailProviderConfig;
  }) => void;
  readonly pending: boolean;
}

function ProviderForm({ onCancel, onSubmit, pending }: ProviderFormProps) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<MailProviderKind>("ses");
  const [config, setConfig] = useState<MailProviderConfig>(EMPTY_PROVIDER_CONFIG);

  const setField = (key: keyof MailProviderConfig, value: string) => {
    setConfig((current) => ({
      ...current,
      [key]: key === "port" ? (value === "" ? null : Number(value)) : value,
    }));
  };

  const fieldLabel: CSSProperties = { fontSize: "var(--text-caption)", color: "var(--text-3)", display: "block" };

  return (
    <form
      className="panel"
      style={{ padding: 16, marginBottom: 12, display: "grid", gap: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim().length === 0) {
          return;
        }
        onSubmit({ name: name.trim(), kind, config });
      }}
    >
      <div style={{ fontWeight: 600, fontSize: "var(--text-body-sm)" }}>Add outbound provider</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label>
          <span style={fieldLabel}>Name</span>
          <input
            aria-label="Provider name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Primary SES"
            style={{ ...INPUT_STYLE, width: "100%" }}
          />
        </label>
        <label>
          <span style={fieldLabel}>Kind</span>
          <select
            aria-label="Provider kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as MailProviderKind)}
            style={{ ...INPUT_STYLE, width: "100%" }}
          >
            {MAIL_PROVIDER_KINDS.map((value) => (
              <option key={value} value={value}>
                {mailProviderKindLabels[value]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Kind-specific config fields */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {(kind === "ses" || kind === "mailgun" || kind === "postmark") && (
          <label>
            <span style={fieldLabel}>API key (env ref)</span>
            <input
              aria-label="API key env ref"
              value={config.apiKeyRef ?? ""}
              onChange={(event) => setField("apiKeyRef", event.target.value)}
              placeholder="env:MAIL_API_KEY"
              style={{ ...INPUT_STYLE, width: "100%" }}
            />
          </label>
        )}
        {kind === "ses" && (
          <label>
            <span style={fieldLabel}>Region</span>
            <input
              aria-label="Region"
              value={config.region ?? ""}
              onChange={(event) => setField("region", event.target.value)}
              placeholder="us-east-1"
              style={{ ...INPUT_STYLE, width: "100%" }}
            />
          </label>
        )}
        {kind === "mailgun" && (
          <label>
            <span style={fieldLabel}>Domain</span>
            <input
              aria-label="Mailgun domain"
              value={config.domain ?? ""}
              onChange={(event) => setField("domain", event.target.value)}
              placeholder="mg.helix.io"
              style={{ ...INPUT_STYLE, width: "100%" }}
            />
          </label>
        )}
        {kind === "smtp" && (
          <>
            <label>
              <span style={fieldLabel}>Host</span>
              <input
                aria-label="SMTP host"
                value={config.host ?? ""}
                onChange={(event) => setField("host", event.target.value)}
                placeholder="smtp.relay.example"
                style={{ ...INPUT_STYLE, width: "100%" }}
              />
            </label>
            <label>
              <span style={fieldLabel}>Port</span>
              <input
                aria-label="SMTP port"
                type="number"
                value={config.port ?? ""}
                onChange={(event) => setField("port", event.target.value)}
                placeholder="587"
                style={{ ...INPUT_STYLE, width: "100%" }}
              />
            </label>
          </>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "Saving…" : "Add provider"}
        </button>
      </div>
    </form>
  );
}

function MailProviders() {
  const queryClient = useQueryClient();
  const providersQuery = useQuery(mailProvidersQueryOptions());
  const [showForm, setShowForm] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: mailAdminQueryKeys.providers() });

  const createMutation = useMutation({
    mutationFn: (input: Parameters<typeof createMailProvider>[0]) =>
      createMailProvider(input),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setShowForm(false);
      void invalidate();
    },
  });

  const defaultMutation = useMutation({
    mutationFn: (id: string) => setDefaultMailProvider(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => void invalidate(),
  });

  const providers = providersQuery.data?.providers ?? [];

  return (
    <PageScroll>
      <PageHeading
        title="Outbound providers"
        subtitle="Mail-sending providers and the default used for outbound delivery"
        actions={
          <button
            type="button"
            className="btn primary"
            onClick={() => setShowForm((open) => !open)}
          >
            <Icons.Plus /> Add provider
          </button>
        }
      />

      {providersQuery.isPending ? (
        <StateBanner kind="loading">Loading outbound providers…</StateBanner>
      ) : null}
      {providersQuery.isError ? (
        <StateBanner kind="error">
          Outbound providers are unavailable or you lack the mail admin scope.
        </StateBanner>
      ) : null}
      {createMutation.isError ? (
        <StateBanner kind="error">{createMutation.error.message}</StateBanner>
      ) : null}
      {defaultMutation.isError ? (
        <StateBanner kind="error">{defaultMutation.error.message}</StateBanner>
      ) : null}

      {showForm ? (
        <ProviderForm
          pending={createMutation.isPending}
          onCancel={() => setShowForm(false)}
          onSubmit={(input) => createMutation.mutate(input)}
        />
      ) : null}

      <div className="panel" style={{ overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: PROVIDERS_GRID,
            padding: "0 12px",
            height: 32,
            alignItems: "center",
            borderBottom: "1px solid var(--border)",
            background: "var(--surface-2)",
            ...HEADER_CELL,
          }}
        >
          <span>Name</span>
          <span>Kind</span>
          <span>Config</span>
          <span>Status</span>
          <span />
        </div>
        {providers.length === 0 ? (
          <EmptyRow>
            {providersQuery.isPending
              ? "Loading providers…"
              : "No outbound providers configured."}
          </EmptyRow>
        ) : (
          providers.map((provider) => (
            <div
              key={provider.id}
              style={{
                display: "grid",
                gridTemplateColumns: PROVIDERS_GRID,
                padding: "0 12px",
                height: "var(--rd-list-row-h)",
                alignItems: "center",
                fontSize: "var(--rd-row-fs)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={{ fontWeight: 500 }}>
                {provider.name}
                {provider.isDefault ? (
                  <span className="chip accent" style={{ marginLeft: 8 }}>
                    Default
                  </span>
                ) : null}
              </span>
              <span>
                <span className="chip">{mailProviderKindLabels[provider.kind]}</span>
              </span>
              <span
                className="mono truncate"
                style={{ fontSize: "var(--text-caption)", color: "var(--text-2)" }}
              >
                {configSummary(provider.kind, provider.config)}
              </span>
              <span>
                <span className={`chip ${provider.enabled ? "success" : "warning"}`}>
                  <span className="chip-dot" />
                  {provider.enabled ? "Enabled" : "Disabled"}
                </span>
              </span>
              <button
                type="button"
                className="btn sm"
                style={{ justifySelf: "flex-end" }}
                disabled={provider.isDefault || defaultMutation.isPending}
                aria-label={`Make ${provider.name} default`}
                onClick={() => defaultMutation.mutate(provider.id)}
              >
                {provider.isDefault ? "Default" : "Set default"}
              </button>
            </div>
          ))
        )}
      </div>
    </PageScroll>
  );
}

/* ================================================================== */
/* Sending domains                                                    */
/* ================================================================== */

function dkimStatusVariant(status: "active" | "retiring" | "retired"): string {
  return status === "active" ? "success" : status === "retiring" ? "warning" : "";
}

function SendingDomains() {
  const queryClient = useQueryClient();
  const domainsQuery = useQuery(sendingDomainsQueryOptions());
  const [newDomain, setNewDomain] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: mailAdminQueryKeys.sendingDomains() });

  const addMutation = useMutation({
    mutationFn: (domain: string) => createSendingDomain(domain),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setNewDomain("");
      void invalidate();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSendingDomain(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => void invalidate(),
  });
  const generateMutation = useMutation({
    mutationFn: (domainId: string) => generateDkimKey(domainId),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => void invalidate(),
  });
  const rotateMutation = useMutation({
    mutationFn: (domainId: string) => rotateDkimKey(domainId),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => void invalidate(),
  });

  const domains = domainsQuery.data?.domains ?? [];
  const dkimBusy = generateMutation.isPending || rotateMutation.isPending;

  return (
    <PageScroll>
      <PageHeading
        title="Sending domains"
        subtitle="Domains authorized to send mail, with DKIM keys and SPF/DKIM/DMARC status"
      />

      {domainsQuery.isPending ? (
        <StateBanner kind="loading">Loading sending domains…</StateBanner>
      ) : null}
      {domainsQuery.isError ? (
        <StateBanner kind="error">
          Sending domains are unavailable or you lack the mail admin scope.
        </StateBanner>
      ) : null}
      {addMutation.isError ? (
        <StateBanner kind="error">{addMutation.error.message}</StateBanner>
      ) : null}

      <form
        className="panel"
        style={{
          padding: 12,
          marginBottom: 12,
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (newDomain.trim().length === 0) {
            return;
          }
          addMutation.mutate(newDomain.trim());
        }}
      >
        <input
          aria-label="New sending domain"
          value={newDomain}
          onChange={(event) => setNewDomain(event.target.value)}
          placeholder="mail.helix.io"
          style={{ ...INPUT_STYLE, flex: 1 }}
        />
        <button type="submit" className="btn primary" disabled={addMutation.isPending}>
          <Icons.Plus /> Add domain
        </button>
      </form>

      {domains.length === 0 ? (
        <div className="panel">
          <EmptyRow>
            {domainsQuery.isPending ? "Loading domains…" : "No sending domains configured."}
          </EmptyRow>
        </div>
      ) : (
        domains.map((domain) => (
          <div
            key={domain.id}
            className="panel"
            style={{ padding: 16, marginBottom: 12 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: "var(--text-3)" }}>
                <Icons.Globe />
              </span>
              <span style={{ fontSize: "var(--text-body)", fontWeight: 600 }}>{domain.domain}</span>
              <div style={{ display: "flex", gap: 6, marginLeft: 8 }}>
                <VerificationBadge label="SPF" state={domain.spf} />
                <VerificationBadge label="DKIM" state={domain.dkim} />
                <VerificationBadge label="DMARC" state={domain.dmarc} />
              </div>
              <button
                type="button"
                className="btn sm"
                style={{ marginLeft: "auto" }}
                aria-label={`Remove ${domain.domain}`}
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(domain.id)}
              >
                <Icons.Trash /> Remove
              </button>
            </div>

            <div
              style={{
                marginTop: 12,
                display: "flex",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <span style={{ ...HEADER_CELL }}>DKIM keys</span>
              <button
                type="button"
                className="btn sm"
                style={{ marginLeft: "auto" }}
                aria-label={`Generate DKIM key for ${domain.domain}`}
                disabled={dkimBusy}
                onClick={() => generateMutation.mutate(domain.id)}
              >
                <Icons.Key /> Generate key
              </button>
              <button
                type="button"
                className="btn sm"
                style={{ marginLeft: 6 }}
                aria-label={`Rotate DKIM key for ${domain.domain}`}
                disabled={dkimBusy || domain.dkimKeys.length === 0}
                onClick={() => rotateMutation.mutate(domain.id)}
              >
                <Icons.History /> Rotate
              </button>
            </div>

            {domain.dkimKeys.length === 0 ? (
              <div style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", padding: "4px 0" }}>
                No DKIM keys — generate one to start signing mail.
              </div>
            ) : (
              domain.dkimKeys.map((key) => (
                <div
                  key={key.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 120px",
                    alignItems: "center",
                    height: 30,
                    fontSize: "var(--text-meta)",
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  <span className="mono" style={{ fontSize: "var(--text-caption)" }}>
                    {key.selector}
                  </span>
                  <span style={{ justifySelf: "flex-end" }}>
                    <span className={`chip ${dkimStatusVariant(key.status)}`.trim()}>
                      <span className="chip-dot" />
                      {key.status}
                    </span>
                  </span>
                </div>
              ))
            )}
          </div>
        ))
      )}
    </PageScroll>
  );
}

/* ================================================================== */
/* Deliverability (DMARC)                                             */
/* ================================================================== */

const DMARC_GRID = "1fr 1fr 1.4fr 90px 90px 90px";

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function Deliverability() {
  const dmarcQuery = useQuery(mailDmarcQueryOptions());
  const data = dmarcQuery.data;
  const summary = data?.summary;
  const reports = data?.reports ?? [];

  const rateCards = useMemo(
    () =>
      summary
        ? [
            { label: "DMARC pass rate", value: percent(summary.dmarcPassRate) },
            { label: "SPF pass rate", value: percent(summary.spfPassRate) },
            { label: "DKIM pass rate", value: percent(summary.dkimPassRate) },
          ]
        : [],
    [summary],
  );

  return (
    <PageScroll>
      <PageHeading
        title="Deliverability"
        subtitle={
          summary
            ? `DMARC aggregate reports over the last ${String(summary.windowDays)} days · ${new Intl.NumberFormat("en-US").format(summary.messagesEvaluated)} messages evaluated`
            : "DMARC aggregate report summary"
        }
      />

      {dmarcQuery.isPending ? (
        <StateBanner kind="loading">Loading deliverability summary…</StateBanner>
      ) : null}
      {dmarcQuery.isError ? (
        <StateBanner kind="error">
          DMARC reports are unavailable or you lack the mail admin scope.
        </StateBanner>
      ) : null}

      {summary ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 12,
            marginBottom: 16,
          }}
        >
          {rateCards.map((card) => (
            <div key={card.label} className="panel" style={{ padding: 16 }}>
              <span style={{ ...HEADER_CELL }}>{card.label}</span>
              <div
                style={{
                  fontSize: "var(--text-h1)",
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                  marginTop: 8,
                }}
              >
                {card.value}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="panel" style={{ overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: DMARC_GRID,
            padding: "0 12px",
            height: 32,
            alignItems: "center",
            borderBottom: "1px solid var(--border)",
            background: "var(--surface-2)",
            ...HEADER_CELL,
          }}
        >
          <span>Reporter</span>
          <span>Domain</span>
          <span>Window</span>
          <span>Messages</span>
          <span>Pass</span>
          <span>Fail</span>
        </div>
        {reports.length === 0 ? (
          <EmptyRow>
            {dmarcQuery.isPending ? "Loading reports…" : "No DMARC aggregate reports yet."}
          </EmptyRow>
        ) : (
          reports.map((report) => (
            <div
              key={report.id}
              style={{
                display: "grid",
                gridTemplateColumns: DMARC_GRID,
                padding: "0 12px",
                height: "var(--rd-list-row-h)",
                alignItems: "center",
                fontSize: "var(--rd-row-fs)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={{ fontWeight: 500 }}>{report.reporter}</span>
              <span style={{ color: "var(--text-2)" }}>{report.domain}</span>
              <span
                className="mono"
                style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}
              >
                {report.rangeStart} → {report.rangeEnd}
              </span>
              <span>{report.total}</span>
              <span style={{ color: "var(--success)" }}>{report.passCount}</span>
              <span style={{ color: report.failCount > 0 ? "var(--danger)" : undefined }}>
                {report.failCount}
              </span>
            </div>
          ))
        )}
      </div>
    </PageScroll>
  );
}

/* ================================================================== */
/* Routing rules                                                      */
/* ================================================================== */

const ROUTING_GRID = "60px 1.4fr 130px 1.4fr 90px 150px";

interface RoutingFormProps {
  readonly onCancel: () => void;
  readonly onSubmit: (input: {
    matchPattern: string;
    action: RoutingAction;
    destination: string;
    enabled: boolean;
    priority: number;
  }) => void;
  readonly pending: boolean;
}

function RoutingForm({ onCancel, onSubmit, pending }: RoutingFormProps) {
  const [matchPattern, setMatchPattern] = useState("");
  const [action, setAction] = useState<RoutingAction>("mailbox");
  const [destination, setDestination] = useState("");
  const [priority, setPriority] = useState("100");

  const fieldLabel: CSSProperties = { fontSize: "var(--text-caption)", color: "var(--text-3)", display: "block" };

  return (
    <form
      className="panel"
      style={{ padding: 16, marginBottom: 12, display: "grid", gap: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        if (matchPattern.trim().length === 0 || destination.trim().length === 0) {
          return;
        }
        onSubmit({
          matchPattern: matchPattern.trim(),
          action,
          destination: destination.trim(),
          enabled: true,
          priority: Number(priority) || 0,
        });
      }}
    >
      <div style={{ fontWeight: 600, fontSize: "var(--text-body-sm)" }}>Add inbound routing rule</div>
      <div
        style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1.4fr 80px", gap: 10 }}
      >
        <label>
          <span style={fieldLabel}>Match pattern</span>
          <input
            aria-label="Match pattern"
            value={matchPattern}
            onChange={(event) => setMatchPattern(event.target.value)}
            placeholder="*@support.helix.io"
            style={{ ...INPUT_STYLE, width: "100%" }}
          />
        </label>
        <label>
          <span style={fieldLabel}>Action</span>
          <select
            aria-label="Routing action"
            value={action}
            onChange={(event) => setAction(event.target.value as RoutingAction)}
            style={{ ...INPUT_STYLE, width: "100%" }}
          >
            {ROUTING_ACTIONS.map((value) => (
              <option key={value} value={value}>
                {routingActionLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span style={fieldLabel}>Destination</span>
          <input
            aria-label="Destination"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="support-team or https://hook"
            style={{ ...INPUT_STYLE, width: "100%" }}
          />
        </label>
        <label>
          <span style={fieldLabel}>Priority</span>
          <input
            aria-label="Priority"
            type="number"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            style={{ ...INPUT_STYLE, width: "100%" }}
          />
        </label>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "Saving…" : "Add rule"}
        </button>
      </div>
    </form>
  );
}

function RoutingRules() {
  const queryClient = useQueryClient();
  const rulesQuery = useQuery(routingRulesQueryOptions());
  const [showForm, setShowForm] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: mailAdminQueryKeys.routingRules() });

  const createMutation = useMutation({
    mutationFn: (input: Parameters<typeof createRoutingRule>[0]) =>
      createRoutingRule(input),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setShowForm(false);
      void invalidate();
    },
  });
  const patchMutation = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      patchRoutingRule(input.id, { enabled: input.enabled }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => void invalidate(),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteRoutingRule(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => void invalidate(),
  });

  const rules = useMemo<readonly RoutingRule[]>(
    () => [...(rulesQuery.data?.rules ?? [])].sort((a, b) => a.priority - b.priority),
    [rulesQuery.data],
  );

  return (
    <PageScroll>
      <PageHeading
        title="Routing rules"
        subtitle="Inbound mail routing — matched in ascending priority order"
        actions={
          <button
            type="button"
            className="btn primary"
            onClick={() => setShowForm((open) => !open)}
          >
            <Icons.Plus /> Add rule
          </button>
        }
      />

      {rulesQuery.isPending ? (
        <StateBanner kind="loading">Loading routing rules…</StateBanner>
      ) : null}
      {rulesQuery.isError ? (
        <StateBanner kind="error">
          Routing rules are unavailable or you lack the mail admin scope.
        </StateBanner>
      ) : null}
      {createMutation.isError ? (
        <StateBanner kind="error">{createMutation.error.message}</StateBanner>
      ) : null}

      {showForm ? (
        <RoutingForm
          pending={createMutation.isPending}
          onCancel={() => setShowForm(false)}
          onSubmit={(input) => createMutation.mutate(input)}
        />
      ) : null}

      <div className="panel" style={{ overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: ROUTING_GRID,
            padding: "0 12px",
            height: 32,
            alignItems: "center",
            borderBottom: "1px solid var(--border)",
            background: "var(--surface-2)",
            ...HEADER_CELL,
          }}
        >
          <span>Priority</span>
          <span>Match</span>
          <span>Action</span>
          <span>Destination</span>
          <span>Status</span>
          <span />
        </div>
        {rules.length === 0 ? (
          <EmptyRow>
            {rulesQuery.isPending ? "Loading rules…" : "No inbound routing rules defined."}
          </EmptyRow>
        ) : (
          rules.map((rule) => (
            <div
              key={rule.id}
              style={{
                display: "grid",
                gridTemplateColumns: ROUTING_GRID,
                padding: "0 12px",
                height: "var(--rd-list-row-h)",
                alignItems: "center",
                fontSize: "var(--rd-row-fs)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span className="mono" style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
                {rule.priority}
              </span>
              <span className="mono truncate" style={{ fontSize: "var(--text-caption)" }}>
                {rule.matchPattern}
              </span>
              <span>
                <span className="chip">{routingActionLabels[rule.action]}</span>
              </span>
              <span className="truncate" style={{ color: "var(--text-2)" }}>
                {rule.destination}
              </span>
              <span>
                <span className={`chip ${rule.enabled ? "success" : "warning"}`}>
                  <span className="chip-dot" />
                  {rule.enabled ? "Active" : "Off"}
                </span>
              </span>
              <div style={{ display: "flex", gap: 6, justifySelf: "flex-end" }}>
                <button
                  type="button"
                  className="btn sm"
                  aria-label={`${rule.enabled ? "Disable" : "Enable"} rule ${rule.matchPattern}`}
                  disabled={patchMutation.isPending}
                  onClick={() =>
                    patchMutation.mutate({ id: rule.id, enabled: !rule.enabled })
                  }
                >
                  {rule.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  className="btn sm"
                  aria-label={`Delete rule ${rule.matchPattern}`}
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate(rule.id)}
                >
                  <Icons.Trash />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </PageScroll>
  );
}

/* ================================================================== */
/* Spam filtering                                                     */
/* ================================================================== */

function SpamFiltering() {
  const spamQuery = useQuery(spamSettingsQueryOptions());
  const settings = spamQuery.data;

  const daemonVariant =
    settings?.daemonStatus === "running"
      ? "success"
      : settings?.daemonStatus === "stopped"
        ? "danger"
        : "warning";

  return (
    <PageScroll>
      <PageHeading
        title="Spam filtering"
        subtitle="spamd thresholds and daemon status — configuration is environment-driven"
      />

      {spamQuery.isPending ? (
        <StateBanner kind="loading">Loading spam settings…</StateBanner>
      ) : null}
      {spamQuery.isError ? (
        <StateBanner kind="error">
          Spam settings are unavailable or you lack the mail admin scope.
        </StateBanner>
      ) : null}

      {settings ? (
        <>
          <div
            className="panel"
            style={{
              padding: 16,
              marginBottom: 12,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span style={{ color: "var(--text-3)" }}>
              <Icons.Shield />
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "var(--text-body)", fontWeight: 600 }}>spamd daemon</div>
              <div style={{ fontSize: "var(--text-meta)", color: "var(--text-2)" }}>
                Ruleset {settings.rulesetVersion ?? "—"}
              </div>
            </div>
            <span className={`chip ${settings.enabled ? "success" : "warning"}`}>
              <span className="chip-dot" />
              {settings.enabled ? "Filtering on" : "Filtering off"}
            </span>
            <span className={`chip ${daemonVariant}`}>
              <span className="chip-dot" />
              {settings.daemonStatus}
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 12,
            }}
          >
            <div className="panel" style={{ padding: 16 }}>
              <span style={{ ...HEADER_CELL }}>Spam threshold</span>
              <div style={{ fontSize: "var(--text-h1)", fontWeight: 700, marginTop: 8 }}>
                {settings.threshold.toFixed(1)}
              </div>
              <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginTop: 4 }}>
                Score above which mail is tagged as spam
              </div>
            </div>
            <div className="panel" style={{ padding: 16 }}>
              <span style={{ ...HEADER_CELL }}>Reject threshold</span>
              <div style={{ fontSize: "var(--text-h1)", fontWeight: 700, marginTop: 8 }}>
                {settings.rejectThreshold === null || settings.rejectThreshold === undefined
                  ? "—"
                  : settings.rejectThreshold.toFixed(1)}
              </div>
              <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginTop: 4 }}>
                Score above which mail is rejected outright
              </div>
            </div>
            <div className="panel" style={{ padding: 16 }}>
              <span style={{ ...HEADER_CELL }}>Tagged (24h)</span>
              <div style={{ fontSize: "var(--text-h1)", fontWeight: 700, marginTop: 8 }}>
                {settings.taggedLast24h === null || settings.taggedLast24h === undefined
                  ? "—"
                  : new Intl.NumberFormat("en-US").format(settings.taggedLast24h)}
              </div>
              <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginTop: 4 }}>
                Messages flagged as spam in the last day
              </div>
            </div>
          </div>
        </>
      ) : null}
    </PageScroll>
  );
}

/* ================================================================== */
/* Mail section shell                                                 */
/* ================================================================== */

const MAIL_SUBVIEW_CONTENT: Record<MailSubviewId, () => ReactNode> = {
  providers: MailProviders,
  domains: SendingDomains,
  deliverability: Deliverability,
  routing: RoutingRules,
  spam: SpamFiltering,
};

export function MailAdminSection() {
  const [subview, setSubview] = useState<MailSubviewId>("providers");
  const Subview = MAIL_SUBVIEW_CONTENT[subview];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
      <div
        role="tablist"
        aria-label="Mail admin views"
        style={{
          display: "flex",
          gap: 4,
          padding: "8px 24px 0",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        {MAIL_SUBVIEWS.map((view) => {
          const active = view.id === subview;
          return (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSubview(view.id)}
              style={{
                height: 34,
                padding: "0 12px",
                fontSize: "var(--text-body-sm)",
                fontWeight: active ? 600 : 400,
                color: active ? "var(--accent)" : "var(--text-2)",
                background: "transparent",
                borderBottom: active
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
              }}
            >
              {view.label}
            </button>
          );
        })}
      </div>
      <Subview />
    </div>
  );
}
