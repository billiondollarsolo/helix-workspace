import { useAdminSectionTab } from "./admin-section-search";
/* Helix Admin — Mail section.
 *
 * Production TSX for the Admin console's "Mail" section. Four sub-views wired
 * to the mail-delivery admin backend (`/api/admin/mail/*`) via TanStack Query:
 *   - Outbound providers  — list, add (kind-specific config), choose default
 *   - Mail domains        — canonical verified domains and DKIM rotation
 *   - Deliverability      — DMARC aggregate report summary (pass/fail rates)
 *   - Spam filtering      — spamd threshold + daemon status (read view)
 *
 * Visual style matches the rest of the Admin console: tokens-only inline
 * styles, `.panel` / `.chip` / `.btn` classes, no hard-coded colors.
 */

import {
  useMemo,
  useState,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import {
  createMailProvider,
  createRoutingRule,
  disableMailDomain,
  deleteRoutingRule,
  generateDkimKey,
  mailAdminQueryKeys,
  mailDmarcQueryOptions,
  mailOperationsQueryOptions,
  mailProviderKindLabels,
  mailProvidersQueryOptions,
  MAIL_PROVIDER_KINDS,
  patchRoutingRule,
  removeMailSuppression,
  replayDeadLetter,
  saveMailJournalSettings,
  mailDomainsQueryOptions,
  routingActionLabels,
  routingRulesQueryOptions,
  ROUTING_ACTIONS,
  setDefaultMailProvider,
  spamSettingsQueryOptions,
  type MailProviderConfig,
  type MailProviderKind,
  type MailOperations as MailOperationsData,
  type RoutingAction,
  type RoutingRule,
} from "@/features/admin/mail-admin-api";

/* ------------------------------------------------------------------ */
/* Mail sub-navigation                                                */
/* ------------------------------------------------------------------ */

export const MAIL_SUBVIEWS = [
  { id: "providers", label: "Outbound providers" },
  { id: "domains", label: "Mail domains" },
  { id: "deliverability", label: "Deliverability" },
  { id: "routing", label: "Routing rules" },
  { id: "operations", label: "Operations" },
  { id: "spam", label: "Spam filtering" },
] as const;

export type MailSubviewId = (typeof MAIL_SUBVIEWS)[number]["id"];

/** Default tab when `?tab=` is missing or unknown (keeps `/admin/mail` clean). */
export const DEFAULT_MAIL_SUBVIEW: MailSubviewId = "providers";

export function isMailSubviewId(value: string): value is MailSubviewId {
  return MAIL_SUBVIEWS.some((view) => view.id === value);
}

/** Map URL `?tab=` to a known mail admin subview. Unknown → default. */
export function mailSubviewFromSearch(tab: string | undefined): MailSubviewId {
  return tab !== undefined && isMailSubviewId(tab) ? tab : DEFAULT_MAIL_SUBVIEW;
}

/**
 * Search fragment for the admin section route. Default tab is omitted so the
 * URL stays `/admin/mail` rather than `/admin/mail?tab=providers`.
 */
export function mailAdminSearchForSubview(subview: MailSubviewId): { readonly tab?: string } {
  return subview === DEFAULT_MAIL_SUBVIEW ? {} : { tab: subview };
}

const tabDomId = (id: MailSubviewId) => `mail-tab-${id}`;
const panelDomId = (id: MailSubviewId) => `mail-panel-${id}`;

/* ------------------------------------------------------------------ */
/* Shared layout primitives (mirror admin-console.tsx)                */
/* ------------------------------------------------------------------ */

function PageScroll({ children }: { children: ReactNode }) {
  return <div style={{ padding: 24, overflowY: "auto", flex: 1 }}>{children}</div>;
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
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>{actions}</div>
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

  const fieldLabel: CSSProperties = {
    fontSize: "var(--text-caption)",
    color: "var(--text-3)",
    display: "block",
  };

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
    mutationFn: (input: Parameters<typeof createMailProvider>[0]) => createMailProvider(input),
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
            {providersQuery.isPending ? "Loading providers…" : "No outbound providers configured."}
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
/* Mail domains                                                       */
/* ================================================================== */

function dkimStatusVariant(status: "active" | "retiring" | "retired"): string {
  return status === "active" ? "success" : status === "retiring" ? "warning" : "";
}

function MailDomains() {
  const queryClient = useQueryClient();
  const domainsQuery = useQuery(mailDomainsQueryOptions());

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: mailAdminQueryKeys.domains() });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => disableMailDomain(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => void invalidate(),
  });
  const generateMutation = useMutation({
    mutationFn: (domainId: string) => generateDkimKey(domainId, `helix-${Date.now().toString(36)}`),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => void invalidate(),
  });

  const domains = domainsQuery.data?.domains ?? [];
  const dkimBusy = generateMutation.isPending;

  return (
    <PageScroll>
      <PageHeading
        title="Mail domains"
        subtitle="Verified workspace domains authorized to send mail"
      />

      {domainsQuery.isPending ? (
        <StateBanner kind="loading">Loading mail domains…</StateBanner>
      ) : null}
      {domainsQuery.isError ? (
        <StateBanner kind="error">
          Mail domains are unavailable or you lack the mail admin scope.
        </StateBanner>
      ) : null}
      <p style={{ color: "var(--text-2)", marginBottom: 12 }}>
        Verify and enable mail capability in Domain settings before configuring DKIM here.
      </p>

      {domains.length === 0 ? (
        <div className="panel">
          <EmptyRow>
            {domainsQuery.isPending ? "Loading domains…" : "No mail-enabled domains configured."}
          </EmptyRow>
        </div>
      ) : (
        domains.map((domain) => (
          <div key={domain.id} className="panel" style={{ padding: 16, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: "var(--text-3)" }}>
                <Icons.Globe />
              </span>
              <span style={{ fontSize: "var(--text-body)", fontWeight: 600 }}>{domain.domain}</span>
              {domain.isPrimary ? <span className="chip success">Primary</span> : null}
              <button
                type="button"
                className="btn sm"
                style={{ marginLeft: "auto" }}
                aria-label={`Disable mail for ${domain.domain}`}
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(domain.id)}
              >
                <Icons.Trash /> Disable mail
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
                <Icons.Key /> {domain.dkimKeys.length === 0 ? "Generate key" : "Rotate key"}
              </button>
            </div>

            {domain.dkimKeys.length === 0 ? (
              <div
                style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", padding: "4px 0" }}
              >
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

function percent(fraction: number | null): string {
  if (fraction === null) return "Not reported";
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
    name: string;
    recipientPattern?: string;
    senderPattern?: string;
    subjectContains?: string;
    headerName?: string;
    headerContains?: string;
    actionKind: RoutingAction;
    destination?: string;
    stopProcessing?: boolean;
    isEnabled: boolean;
    priority: number;
  }) => void;
  readonly pending: boolean;
}

function RoutingForm({ onCancel, onSubmit, pending }: RoutingFormProps) {
  const [name, setName] = useState("");
  const [recipientPattern, setRecipientPattern] = useState("");
  const [senderPattern, setSenderPattern] = useState("");
  const [subjectContains, setSubjectContains] = useState("");
  const [headerName, setHeaderName] = useState("");
  const [headerContains, setHeaderContains] = useState("");
  const [action, setAction] = useState<RoutingAction>("mailbox");
  const [destination, setDestination] = useState("");
  const [priority, setPriority] = useState("100");
  const [stopProcessing, setStopProcessing] = useState(false);

  const fieldLabel: CSSProperties = {
    fontSize: "var(--text-caption)",
    color: "var(--text-3)",
    display: "block",
  };

  return (
    <form
      className="panel"
      style={{ padding: 16, marginBottom: 12, display: "grid", gap: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim().length === 0 || (action !== "drop" && destination.trim().length === 0)) {
          return;
        }
        if ((headerName.trim().length === 0) !== (headerContains.trim().length === 0)) return;
        onSubmit({
          name: name.trim(),
          ...(recipientPattern.trim().length === 0
            ? {}
            : { recipientPattern: recipientPattern.trim() }),
          ...(senderPattern.trim().length === 0 ? {} : { senderPattern: senderPattern.trim() }),
          ...(subjectContains.trim().length === 0
            ? {}
            : { subjectContains: subjectContains.trim() }),
          ...(headerName.trim().length === 0
            ? {}
            : { headerName: headerName.trim(), headerContains: headerContains.trim() }),
          actionKind: action,
          ...(action === "drop" ? {} : { destination: destination.trim() }),
          ...(stopProcessing ? { stopProcessing: true } : {}),
          isEnabled: true,
          priority: Number(priority) || 0,
        });
      }}
    >
      <div style={{ fontWeight: 600, fontSize: "var(--text-body-sm)" }}>
        Add inbound routing rule
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr 1fr 1.4fr 80px", gap: 10 }}>
        <label>
          <span style={fieldLabel}>Name</span>
          <input
            aria-label="Rule name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Support catch-all"
            style={{ ...INPUT_STYLE, width: "100%" }}
          />
        </label>
        <label>
          <span style={fieldLabel}>Recipient pattern</span>
          <input
            aria-label="Recipient pattern"
            value={recipientPattern}
            onChange={(event) => setRecipientPattern(event.target.value)}
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
            disabled={action === "drop"}
            placeholder={
              action === "alias"
                ? "User actor UUID"
                : action === "tag"
                  ? "Tag"
                  : "Mailbox or forwarding address"
            }
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto", gap: 10 }}>
        <label>
          <span style={fieldLabel}>Sender pattern</span>
          <input
            aria-label="Sender pattern"
            value={senderPattern}
            onChange={(event) => setSenderPattern(event.target.value)}
            placeholder="*@customer.example"
            style={{ ...INPUT_STYLE, width: "100%" }}
          />
        </label>
        <label>
          <span style={fieldLabel}>Subject contains</span>
          <input
            aria-label="Subject contains"
            value={subjectContains}
            onChange={(event) => setSubjectContains(event.target.value)}
            style={{ ...INPUT_STYLE, width: "100%" }}
          />
        </label>
        <label>
          <span style={fieldLabel}>Header name</span>
          <input
            aria-label="Header name"
            value={headerName}
            onChange={(event) => setHeaderName(event.target.value)}
            placeholder="X-Project"
            style={{ ...INPUT_STYLE, width: "100%" }}
          />
        </label>
        <label>
          <span style={fieldLabel}>Header contains</span>
          <input
            aria-label="Header contains"
            value={headerContains}
            onChange={(event) => setHeaderContains(event.target.value)}
            style={{ ...INPUT_STYLE, width: "100%" }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "end", gap: 6, paddingBottom: 8 }}>
          <input
            aria-label="Stop processing"
            type="checkbox"
            checked={stopProcessing}
            onChange={(event) => setStopProcessing(event.target.checked)}
          />
          Stop
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

function routingRuleDestination(rule: RoutingRule): string {
  switch (rule.actionKind) {
    case "forward":
      return rule.action.forwardTo ?? "—";
    case "alias":
      return rule.action.aliasActorId ?? "—";
    case "tag":
      return rule.action.tag ?? "—";
    case "mailbox":
      return rule.action.mailbox ?? "—";
    case "drop":
      return "—";
  }
}

function routingRuleMatch(rule: RoutingRule): string {
  return (
    [
      rule.match.recipientPattern,
      rule.match.senderPattern === undefined ? undefined : `from:${rule.match.senderPattern}`,
      rule.match.subjectContains === undefined
        ? undefined
        : `subject:${rule.match.subjectContains}`,
      rule.match.headerName === undefined
        ? undefined
        : `${rule.match.headerName}:${rule.match.headerContains ?? ""}`,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" · ") || "All known recipients"
  );
}

function RoutingRules() {
  const queryClient = useQueryClient();
  const rulesQuery = useQuery(routingRulesQueryOptions());
  const [showForm, setShowForm] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: mailAdminQueryKeys.routingRules() });

  const createMutation = useMutation({
    mutationFn: (input: Parameters<typeof createRoutingRule>[0]) => createRoutingRule(input),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setShowForm(false);
      void invalidate();
    },
  });
  const patchMutation = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      patchRoutingRule(input.id, { isEnabled: input.enabled }),
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
      {patchMutation.isError || deleteMutation.isError ? (
        <StateBanner kind="error">
          {(patchMutation.error ?? deleteMutation.error)?.message ??
            "Could not update routing rule."}
        </StateBanner>
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
              <span
                className="mono"
                style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}
              >
                {rule.priority}
              </span>
              <span className="mono truncate" style={{ fontSize: "var(--text-caption)" }}>
                {routingRuleMatch(rule)}
              </span>
              <span>
                <span className="chip">{routingActionLabels[rule.actionKind]}</span>
              </span>
              <span className="truncate" style={{ color: "var(--text-2)" }}>
                {routingRuleDestination(rule)}
              </span>
              <span>
                <span className={`chip ${rule.isEnabled ? "success" : "warning"}`}>
                  <span className="chip-dot" />
                  {rule.isEnabled ? "Active" : "Off"}
                </span>
              </span>
              <div style={{ display: "flex", gap: 6, justifySelf: "flex-end" }}>
                <button
                  type="button"
                  className="btn sm"
                  aria-label={`${rule.isEnabled ? "Disable" : "Enable"} rule ${rule.name}`}
                  disabled={patchMutation.isPending}
                  onClick={() => patchMutation.mutate({ id: rule.id, enabled: !rule.isEnabled })}
                >
                  {rule.isEnabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  className="btn sm"
                  aria-label={`Delete rule ${rule.name}`}
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
              <div
                style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginTop: 4 }}
              >
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
              <div
                style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginTop: 4 }}
              >
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
              <div
                style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginTop: 4 }}
              >
                Messages flagged as spam in the last day
              </div>
            </div>
          </div>
        </>
      ) : null}
    </PageScroll>
  );
}

function JournalSettings({
  journal,
  pending,
  onSave,
}: {
  readonly journal: MailOperationsData["journal"];
  readonly pending: boolean;
  readonly onSave: (input: { enabled: boolean; retentionDays: number }) => void;
}) {
  const [enabled, setEnabled] = useState(journal.enabled);
  const [retentionDays, setRetentionDays] = useState(String(journal.retentionDays));
  return (
    <form
      className="panel"
      style={{ padding: 16, marginBottom: 12, display: "flex", gap: 12, alignItems: "end" }}
      onSubmit={(event) => {
        event.preventDefault();
        const days = Number(retentionDays);
        if (Number.isInteger(days) && days >= 1 && days <= 36_500) {
          onSave({ enabled, retentionDays: days });
        }
      }}
    >
      <label style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}>
        <input
          aria-label="Enable compliance journal"
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span>
          <strong>Immutable compliance journal</strong>
          <span style={{ display: "block", color: "var(--text-3)" }}>
            {String(journal.entryCount)} captured messages
            {journal.lastJournaledAt === null
              ? ""
              : ` · last ${new Date(journal.lastJournaledAt).toLocaleString()}`}
          </span>
        </span>
      </label>
      <label>
        <span style={HEADER_CELL}>Retention days</span>
        <input
          aria-label="Journal retention days"
          type="number"
          min={1}
          max={36_500}
          value={retentionDays}
          onChange={(event) => setRetentionDays(event.target.value)}
          style={{ ...INPUT_STYLE, width: 140 }}
        />
      </label>
      <button type="submit" className="btn primary" disabled={pending}>
        {pending ? "Saving…" : "Save journal"}
      </button>
    </form>
  );
}

function MailOperations() {
  const queryClient = useQueryClient();
  const operations = useQuery(mailOperationsQueryOptions());
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: mailAdminQueryKeys.operations() });
  const replay = useMutation({
    mutationFn: (id: string) => replayDeadLetter(id, reason),
    onMutate: () => setActionError(null),
    onError: (error) => setActionError(error.message),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeMailSuppression(id, reason),
    onMutate: () => setActionError(null),
    onError: (error) => setActionError(error.message),
    onSuccess: refresh,
  });
  const saveJournal = useMutation({
    mutationFn: (input: { enabled: boolean; retentionDays: number }) =>
      saveMailJournalSettings(input),
    onMutate: () => setActionError(null),
    onError: (error) => setActionError(error.message),
    onSuccess: refresh,
  });

  return (
    <PageScroll>
      <PageHeading
        title="Mail operations"
        subtitle="Tenant-scoped delivery trace, dead-letter recovery, and recipient suppressions"
      />
      <label htmlFor="mail-operation-reason" style={HEADER_CELL}>
        Reason for recovery action
      </label>
      <input
        id="mail-operation-reason"
        className="input"
        value={reason}
        maxLength={500}
        onChange={(event) => setReason(event.target.value)}
        style={{ ...INPUT_STYLE, width: "100%", margin: "8px 0 16px" }}
      />
      {operations.isPending ? (
        <StateBanner kind="loading">Loading mail operations…</StateBanner>
      ) : null}
      {operations.isError ? (
        <StateBanner kind="error">{operations.error.message}</StateBanner>
      ) : null}
      {actionError !== null ? <StateBanner kind="error">{actionError}</StateBanner> : null}

      {operations.data === undefined ? null : (
        <JournalSettings
          journal={operations.data.journal}
          pending={saveJournal.isPending}
          onSave={(input) => saveJournal.mutate(input)}
        />
      )}

      <section className="panel" style={{ padding: 16, marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>Dead letters</h2>
        {operations.data?.deadLetters.length === 0 ? <EmptyRow>No dead letters.</EmptyRow> : null}
        {operations.data?.deadLetters.map((message) => (
          <div
            key={message.id}
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              padding: "8px 0",
              borderTop: "1px solid var(--border)",
            }}
          >
            <div style={{ flex: 1 }}>
              <strong>{message.messageId}</strong>
              <div style={{ color: "var(--text-3)" }}>
                {message.lastError ?? "No diagnostic"} · {String(message.attemptCount)} attempts
              </div>
            </div>
            <button
              type="button"
              className="btn sm"
              disabled={reason.trim() === "" || replay.isPending}
              onClick={() => replay.mutate(message.id)}
            >
              Replay
            </button>
          </div>
        ))}
      </section>

      <section className="panel" style={{ padding: 16, marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>Delivery trace</h2>
        {operations.data?.events.length === 0 ? <EmptyRow>No delivery events.</EmptyRow> : null}
        {operations.data?.events.map((event) => (
          <div key={event.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}>
            <strong>{event.kind}</strong> · {event.recipient} ·{" "}
            {new Date(event.occurredAt).toLocaleString()}
            {event.diagnostic === null ? null : (
              <div style={{ color: "var(--text-3)" }}>{event.diagnostic}</div>
            )}
          </div>
        ))}
      </section>

      <section className="panel" style={{ padding: 16 }}>
        <h2 style={{ marginTop: 0 }}>Suppressions</h2>
        {operations.data?.suppressions.length === 0 ? (
          <EmptyRow>No active suppressions.</EmptyRow>
        ) : null}
        {operations.data?.suppressions.map((suppression) => (
          <div
            key={suppression.id}
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              padding: "8px 0",
              borderTop: "1px solid var(--border)",
            }}
          >
            <div style={{ flex: 1 }}>
              <strong>{suppression.address}</strong> · {suppression.reason}
            </div>
            <button
              type="button"
              className="btn sm"
              disabled={reason.trim() === "" || remove.isPending}
              onClick={() => remove.mutate(suppression.id)}
            >
              Remove
            </button>
          </div>
        ))}
      </section>
    </PageScroll>
  );
}

/* ================================================================== */
/* Mail section shell                                                 */
/* ================================================================== */

const MAIL_SUBVIEW_CONTENT: Record<MailSubviewId, () => ReactNode> = {
  providers: MailProviders,
  domains: MailDomains,
  deliverability: Deliverability,
  routing: RoutingRules,
  operations: MailOperations,
  spam: SpamFiltering,
};

const MAIL_SUBVIEW_IDS = MAIL_SUBVIEWS.map((view) => view.id);

export function MailAdminSection() {
  const [subview, selectSubview] = useAdminSectionTab(
    MAIL_SUBVIEW_IDS,
    DEFAULT_MAIL_SUBVIEW,
    "mail",
  );
  const tabRefs = useRef<Partial<Record<MailSubviewId, HTMLButtonElement | null>>>({});
  const Subview = MAIL_SUBVIEW_CONTENT[subview];

  /* Arrow keys move between tabs and only the selected tab sits in the tab
     order — the ARIA tabs pattern. Five plain buttons would otherwise cost a
     keyboard user five stops before reaching the panel. */
  const moveSelection = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const last = MAIL_SUBVIEWS.length - 1;
    const current = MAIL_SUBVIEWS.findIndex((view) => view.id === subview);
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (current + 1) % MAIL_SUBVIEWS.length;
        break;
      case "ArrowLeft":
        nextIndex = (current + last) % MAIL_SUBVIEWS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = last;
        break;
      default:
        return;
    }
    const next = MAIL_SUBVIEWS[nextIndex];
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    selectSubview(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <PageHeading
        title="Mail"
        subtitle="Outbound delivery, mail domains, deliverability, routing, and spam filtering."
      />

      {/* The console's only second-level nav: sibling views of one section,
          which is what a tab bar is for. The buttons wear the app-wide `.tab`
          look; the bar itself is built here rather than with `.tabs` because
          that class carries a 12px inset that would knock the tabs out of line
          with the heading above them. */}
      <div
        role="tablist"
        aria-label="Mail admin views"
        className="mb-5 flex gap-0.5 overflow-x-auto border-b border-[var(--border)]"
        onKeyDown={moveSelection}
      >
        {MAIL_SUBVIEWS.map((view) => {
          const active = view.id === subview;
          return (
            <button
              key={view.id}
              id={tabDomId(view.id)}
              ref={(node) => {
                tabRefs.current[view.id] = node;
              }}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelDomId(view.id)}
              tabIndex={active ? 0 : -1}
              /* Roving tabindex moves focus programmatically, so the focused
                 tab has to be visible even though `.tab` styles only hover and
                 selection. */
              className={`tab shrink-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)] ${active ? "active" : ""}`.trim()}
              onClick={() => selectSubview(view.id)}
            >
              {view.label}
            </button>
          );
        })}
      </div>

      <div id={panelDomId(subview)} role="tabpanel" aria-labelledby={tabDomId(subview)}>
        <Subview />
      </div>
    </div>
  );
}
