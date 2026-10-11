import { formatRelativeTime } from "@/features/admin/console/format";
import { RelativeTime } from "@/features/admin/console/widgets";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SettingToggle } from "@/features/admin/console/widgets";
import {
  Globe as GlobeIcon,
  Key as KeyIcon,
  Plus as PlusIcon,
  Shield as ShieldIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
import { useAdminSectionTab } from "./admin-section-search";
import { AppStatusPanel, WorkspaceFlagsPanel } from "@/features/admin/console/app-settings";
import { AdminTabs } from "@/features/admin/console/tabs";
import {
  EmptyRow,
  ErrorNotice,
  LoadingState,
  PageHeading,
  PanelHeading,
} from "@/features/admin/console/primitives";
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
  createMailProvider,
  createRoutingRule,
  deleteRoutingRule,
  disableMailDomain,
  generateDkimKey,
  MAIL_PROVIDER_KINDS,
  mailAdminQueryKeys,
  mailDmarcQueryOptions,
  mailDomainsQueryOptions,
  mailOperationsQueryOptions,
  mailProviderKindLabels,
  mailProvidersQueryOptions,
  patchRoutingRule,
  removeMailSuppression,
  replayDeadLetter,
  ROUTING_ACTIONS,
  routingActionLabels,
  routingRulesQueryOptions,
  saveMailJournalSettings,
  setDefaultMailProvider,
  spamSettingsQueryOptions,
  type MailOperations as MailOperationsData,
  type MailProviderConfig,
  type MailProviderKind,
  type RoutingAction,
  type RoutingRule,
} from "@/features/admin/mail-admin-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* Mail sub-navigation                                                */
/* ------------------------------------------------------------------ */

export const MAIL_SUBVIEWS = [
  { id: "general", label: "General" },
  { id: "providers", label: "Outbound providers" },
  { id: "domains", label: "Mail domains" },
  { id: "deliverability", label: "Deliverability" },
  { id: "routing", label: "Routing rules" },
  { id: "operations", label: "Operations" },
  { id: "spam", label: "Spam filtering" },
] as const;

export type MailSubviewId = (typeof MAIL_SUBVIEWS)[number]["id"];

/** Default tab when `?tab=` is missing or unknown (keeps `/admin/mail` clean). */
export const DEFAULT_MAIL_SUBVIEW: MailSubviewId = "general";

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

  return (
    <form
      className="panel p-4 mb-3 grid gap-2.5"

      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim().length === 0) {
          return;
        }
        onSubmit({ name: name.trim(), kind, config });
      }}
    >
      <div className="font-semibold type-body-sm">Add outbound provider</div>
      <div className="grid [grid-template-columns:1fr_1fr] gap-2.5">
        <label>
          <span className="type-caption text-muted-foreground block">Name</span>
          <input
            aria-label="Provider name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Primary SES"
            className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
          />
        </label>
        <label>
          <span className="type-caption text-muted-foreground block">Kind</span>
          <select
            aria-label="Provider kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as MailProviderKind)}
            className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
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
      <div className="grid [grid-template-columns:1fr_1fr] gap-2.5">
        {(kind === "ses" || kind === "mailgun" || kind === "postmark") && (
          <label>
            <span className="type-caption text-muted-foreground block">API key (env ref)</span>
            <input
              aria-label="API key env ref"
              value={config.apiKeyRef ?? ""}
              onChange={(event) => setField("apiKeyRef", event.target.value)}
              placeholder="env:MAIL_API_KEY"
              className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
            />
          </label>
        )}
        {kind === "ses" && (
          <label>
            <span className="type-caption text-muted-foreground block">Region</span>
            <input
              aria-label="Region"
              value={config.region ?? ""}
              onChange={(event) => setField("region", event.target.value)}
              placeholder="us-east-1"
              className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
            />
          </label>
        )}
        {kind === "mailgun" && (
          <label>
            <span className="type-caption text-muted-foreground block">Domain</span>
            <input
              aria-label="Mailgun domain"
              value={config.domain ?? ""}
              onChange={(event) => setField("domain", event.target.value)}
              placeholder="mg.helix.io"
              className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
            />
          </label>
        )}
        {kind === "smtp" && (
          <>
            <label>
              <span className="type-caption text-muted-foreground block">Host</span>
              <input
                aria-label="SMTP host"
                value={config.host ?? ""}
                onChange={(event) => setField("host", event.target.value)}
                placeholder="smtp.relay.example"
                className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
              />
            </label>
            <label>
              <span className="type-caption text-muted-foreground block">Port</span>
              <input
                aria-label="SMTP port"
                type="number"
                value={config.port ?? ""}
                onChange={(event) => setField("port", event.target.value)}
                placeholder="587"
                className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
              />
            </label>
          </>
        )}
      </div>

      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Add provider"}
        </Button>
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
    <>
      <PanelHeading
        title="Outbound providers"
        subtitle="Mail-sending providers and the default used for outbound delivery"
        actions={
          <Button
            type="button"

            onClick={() => setShowForm((open) => !open)}
          >
            <PlusIcon size={16} /> Add provider
          </Button>
        }
      />

      {providersQuery.isPending ? <LoadingState label="Loading outbound providers…" /> : null}
      {providersQuery.isError ? (
        <ErrorNotice>
          Outbound providers are unavailable or you lack the mail admin scope.
        </ErrorNotice>
      ) : null}
      {createMutation.isError ? <ErrorNotice>{createMutation.error.message}</ErrorNotice> : null}
      {defaultMutation.isError ? <ErrorNotice>{defaultMutation.error.message}</ErrorNotice> : null}

      {showForm ? (
        <ProviderForm
          pending={createMutation.isPending}
          onCancel={() => setShowForm(false)}
          onSubmit={(input) => createMutation.mutate(input)}
        />
      ) : null}

      <div className="panel overflow-hidden">
        <div className="grid [grid-template-columns:1fr_130px_1.6fr_90px_110px] [padding:0_12px] h-8 items-center [border-bottom:1px_solid_var(--border)] bg-muted type-caption text-muted-foreground font-semibold uppercase [letter-spacing:.06em]">
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
              className="grid [grid-template-columns:1fr_130px_1.6fr_90px_110px] [padding:0_12px] [height:var(--rd-list-row-h)] items-center type-row [border-bottom:1px_solid_var(--border)]"
            >
              <span className="font-medium">
                {provider.name}
                {provider.isDefault ? <span className="chip accent ml-2">Default</span> : null}
              </span>
              <span>
                <span className="chip">{mailProviderKindLabels[provider.kind]}</span>
              </span>
              <span className="mono truncate type-caption [color:var(--text-2)]">
                {configSummary(provider.kind, provider.config)}
              </span>
              <span>
                <span className={`chip ${provider.enabled ? "success" : "warning"}`}>
                  <span className="chip-dot" />
                  {provider.enabled ? "Enabled" : "Disabled"}
                </span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="[justify-self:flex-end]"

                disabled={provider.isDefault || defaultMutation.isPending}
                aria-label={`Make ${provider.name} default`}
                onClick={() => defaultMutation.mutate(provider.id)}
              >
                {provider.isDefault ? "Default" : "Set default"}
              </Button>
            </div>
          ))
        )}
      </div>
    </>
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
    <>
      <PanelHeading
        title="Mail domains"
        subtitle="Verified workspace domains authorized to send mail"
      />

      {domainsQuery.isPending ? <LoadingState label="Loading mail domains…" /> : null}
      {domainsQuery.isError ? (
        <ErrorNotice>Mail domains are unavailable or you lack the mail admin scope.</ErrorNotice>
      ) : null}
      <p className="[color:var(--text-2)] mb-3">
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
          <div key={domain.id} className="panel p-4 mb-3">
            <div className="flex items-center gap-2.5">
              <span className="text-muted-foreground">
                <GlobeIcon size={16} />
              </span>
              <span className="type-body font-semibold">{domain.domain}</span>
              {domain.isPrimary ? <span className="chip success">Primary</span> : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto"

                aria-label={`Disable mail for ${domain.domain}`}
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(domain.id)}
              >
                <TrashIcon size={16} /> Disable mail
              </Button>
            </div>

            <div className="mt-3 flex items-center mb-2">
              <span className="type-caption text-muted-foreground font-semibold uppercase [letter-spacing:.06em]">
                DKIM keys
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto"

                aria-label={`Generate DKIM key for ${domain.domain}`}
                disabled={dkimBusy}
                onClick={() => generateMutation.mutate(domain.id)}
              >
                <KeyIcon size={16} /> {domain.dkimKeys.length === 0 ? "Generate key" : "Rotate key"}
              </Button>
            </div>

            {domain.dkimKeys.length === 0 ? (
              <div className="type-meta text-muted-foreground [padding:4px_0]">
                No DKIM keys — generate one to start signing mail.
              </div>
            ) : (
              domain.dkimKeys.map((key) => (
                <div
                  key={key.id}
                  className="grid [grid-template-columns:1fr_120px] items-center h-7.5 type-meta [border-top:1px_solid_var(--border)]"
                >
                  <span className="mono type-caption">{key.selector}</span>
                  <span className="[justify-self:flex-end]">
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
    </>
  );
}

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
    <>
      <PanelHeading
        title="Deliverability"
        subtitle={
          summary
            ? `DMARC aggregate reports over the last ${String(summary.windowDays)} days · ${new Intl.NumberFormat("en-US").format(summary.messagesEvaluated)} messages evaluated`
            : "DMARC aggregate report summary"
        }
      />

      {dmarcQuery.isPending ? <LoadingState label="Loading deliverability summary…" /> : null}
      {dmarcQuery.isError ? (
        <ErrorNotice>DMARC reports are unavailable or you lack the mail admin scope.</ErrorNotice>
      ) : null}

      {summary ? (
        <div className="grid [grid-template-columns:repeat(3,_1fr)] gap-3 mb-4">
          {rateCards.map((card) => (
            <div key={card.label} className="panel p-4">
              <span className="type-caption text-muted-foreground font-semibold uppercase [letter-spacing:.06em]">
                {card.label}
              </span>
              <div className="type-h1 font-bold [letter-spacing:-0.02em] mt-2">{card.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="panel overflow-hidden">
        <div className="grid [grid-template-columns:1fr_1fr_1.4fr_90px_90px_90px] [padding:0_12px] h-8 items-center [border-bottom:1px_solid_var(--border)] bg-muted type-caption text-muted-foreground font-semibold uppercase [letter-spacing:.06em]">
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
              className="grid [grid-template-columns:1fr_1fr_1.4fr_90px_90px_90px] [padding:0_12px] [height:var(--rd-list-row-h)] items-center type-row [border-bottom:1px_solid_var(--border)]"
            >
              <span className="font-medium">{report.reporter}</span>
              <span className="[color:var(--text-2)]">{report.domain}</span>
              <span className="mono type-caption text-muted-foreground">
                {report.rangeStart} → {report.rangeEnd}
              </span>
              <span>{report.total}</span>
              <span className="[color:var(--success)]">{report.passCount}</span>
              <span className={cn(report.failCount > 0 ? "text-destructive" : "")}>
                {report.failCount}
              </span>
            </div>
          ))
        )}
      </div>
    </>
  );
}

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

  return (
    <form
      className="panel p-4 mb-3 grid gap-2.5"

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
      <div className="font-semibold type-body-sm">Add inbound routing rule</div>
      <div className="grid [grid-template-columns:1fr_1.4fr_1fr_1.4fr_80px] gap-2.5">
        <label>
          <span className="type-caption text-muted-foreground block">Name</span>
          <input
            aria-label="Rule name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Support catch-all"
            className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
          />
        </label>
        <label>
          <span className="type-caption text-muted-foreground block">Recipient pattern</span>
          <input
            aria-label="Recipient pattern"
            value={recipientPattern}
            onChange={(event) => setRecipientPattern(event.target.value)}
            placeholder="*@support.helix.io"
            className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
          />
        </label>
        <label>
          <span className="type-caption text-muted-foreground block">Action</span>
          <select
            aria-label="Routing action"
            value={action}
            onChange={(event) => setAction(event.target.value as RoutingAction)}
            className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
          >
            {ROUTING_ACTIONS.map((value) => (
              <option key={value} value={value}>
                {routingActionLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="type-caption text-muted-foreground block">Destination</span>
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
            className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
          />
        </label>
        <label>
          <span className="type-caption text-muted-foreground block">Priority</span>
          <input
            aria-label="Priority"
            type="number"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
          />
        </label>
      </div>
      <div className="grid [grid-template-columns:1fr_1fr_1fr_1fr_auto] gap-2.5">
        <label>
          <span className="type-caption text-muted-foreground block">Sender pattern</span>
          <input
            aria-label="Sender pattern"
            value={senderPattern}
            onChange={(event) => setSenderPattern(event.target.value)}
            placeholder="*@customer.example"
            className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
          />
        </label>
        <label>
          <span className="type-caption text-muted-foreground block">Subject contains</span>
          <input
            aria-label="Subject contains"
            value={subjectContains}
            onChange={(event) => setSubjectContains(event.target.value)}
            className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
          />
        </label>
        <label>
          <span className="type-caption text-muted-foreground block">Header name</span>
          <input
            aria-label="Header name"
            value={headerName}
            onChange={(event) => setHeaderName(event.target.value)}
            placeholder="X-Project"
            className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
          />
        </label>
        <label>
          <span className="type-caption text-muted-foreground block">Header contains</span>
          <input
            aria-label="Header contains"
            value={headerContains}
            onChange={(event) => setHeaderContains(event.target.value)}
            className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full"
          />
        </label>
        <SettingToggle
          label="Stop processing later rules"
          checked={stopProcessing}
          onCheckedChange={(checked) => setStopProcessing(checked)}
        />
      </div>
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Add rule"}
        </Button>
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
    <>
      <PanelHeading
        title="Routing rules"
        subtitle="Inbound mail routing — matched in ascending priority order"
        actions={
          <Button
            type="button"

            onClick={() => setShowForm((open) => !open)}
          >
            <PlusIcon size={16} /> Add rule
          </Button>
        }
      />

      {rulesQuery.isPending ? <LoadingState label="Loading routing rules…" /> : null}
      {rulesQuery.isError ? (
        <ErrorNotice>Routing rules are unavailable or you lack the mail admin scope.</ErrorNotice>
      ) : null}
      {createMutation.isError ? <ErrorNotice>{createMutation.error.message}</ErrorNotice> : null}
      {patchMutation.isError || deleteMutation.isError ? (
        <ErrorNotice>
          {(patchMutation.error ?? deleteMutation.error)?.message ??
            "Could not update routing rule."}
        </ErrorNotice>
      ) : null}

      {showForm ? (
        <RoutingForm
          pending={createMutation.isPending}
          onCancel={() => setShowForm(false)}
          onSubmit={(input) => createMutation.mutate(input)}
        />
      ) : null}

      <div className="panel overflow-hidden">
        <div className="grid [grid-template-columns:60px_1.4fr_130px_1.4fr_90px_150px] [padding:0_12px] h-8 items-center [border-bottom:1px_solid_var(--border)] bg-muted type-caption text-muted-foreground font-semibold uppercase [letter-spacing:.06em]">
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
              className="grid [grid-template-columns:60px_1.4fr_130px_1.4fr_90px_150px] [padding:0_12px] [height:var(--rd-list-row-h)] items-center type-row [border-bottom:1px_solid_var(--border)]"
            >
              <span className="mono type-caption text-muted-foreground">{rule.priority}</span>
              <span className="mono truncate type-caption">{routingRuleMatch(rule)}</span>
              <span>
                <span className="chip">{routingActionLabels[rule.actionKind]}</span>
              </span>
              <span className="truncate [color:var(--text-2)]">{routingRuleDestination(rule)}</span>
              <span>
                <span className={`chip ${rule.isEnabled ? "success" : "warning"}`}>
                  <span className="chip-dot" />
                  {rule.isEnabled ? "Active" : "Off"}
                </span>
              </span>
              <div className="flex gap-1.5 [justify-self:flex-end]">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`${rule.isEnabled ? "Disable" : "Enable"} rule ${rule.name}`}
                  disabled={patchMutation.isPending}
                  onClick={() => patchMutation.mutate({ id: rule.id, enabled: !rule.isEnabled })}
                >
                  {rule.isEnabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Delete rule ${rule.name}`}
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate(rule.id)}
                >
                  <TrashIcon size={16} />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
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
    <>
      <PanelHeading
        title="Spam filtering"
        subtitle="spamd thresholds and daemon status — configuration is environment-driven"
      />

      {spamQuery.isPending ? <LoadingState label="Loading spam settings…" /> : null}
      {spamQuery.isError ? (
        <ErrorNotice>Spam settings are unavailable or you lack the mail admin scope.</ErrorNotice>
      ) : null}

      {settings ? (
        <>
          <div className="panel p-4 mb-3 flex items-center gap-3">
            <span className="text-muted-foreground">
              <ShieldIcon size={16} />
            </span>
            <div className="flex-1">
              <div className="type-body font-semibold">spamd daemon</div>
              <div className="type-meta [color:var(--text-2)]">
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

          <div className="grid [grid-template-columns:repeat(3,_1fr)] gap-3">
            <div className="panel p-4">
              <span className="type-caption text-muted-foreground font-semibold uppercase [letter-spacing:.06em]">
                Spam threshold
              </span>
              <div className="type-h1 font-bold mt-2">{settings.threshold.toFixed(1)}</div>
              <div className="type-caption text-muted-foreground mt-1">
                Score above which mail is tagged as spam
              </div>
            </div>
            <div className="panel p-4">
              <span className="type-caption text-muted-foreground font-semibold uppercase [letter-spacing:.06em]">
                Reject threshold
              </span>
              <div className="type-h1 font-bold mt-2">
                {settings.rejectThreshold === null || settings.rejectThreshold === undefined
                  ? "—"
                  : settings.rejectThreshold.toFixed(1)}
              </div>
              <div className="type-caption text-muted-foreground mt-1">
                Score above which mail is rejected outright
              </div>
            </div>
            <div className="panel p-4">
              <span className="type-caption text-muted-foreground font-semibold uppercase [letter-spacing:.06em]">
                Tagged (24h)
              </span>
              <div className="type-h1 font-bold mt-2">
                {settings.taggedLast24h === null || settings.taggedLast24h === undefined
                  ? "—"
                  : new Intl.NumberFormat("en-US").format(settings.taggedLast24h)}
              </div>
              <div className="type-caption text-muted-foreground mt-1">
                Messages flagged as spam in the last day
              </div>
            </div>
          </div>
        </>
      ) : null}
    </>
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
      className="panel p-4 mb-3 flex gap-3 [align-items:end]"

      onSubmit={(event) => {
        event.preventDefault();
        const days = Number(retentionDays);
        if (Number.isInteger(days) && days >= 1 && days <= 36_500) {
          onSave({ enabled, retentionDays: days });
        }
      }}
    >
      <SettingToggle
        label={`<span>
          <strong>Immutable compliance journal</strong>
          <span className="block text-muted-foreground">
            ${String(journal.entryCount)} captured messages
            ${
              journal.lastJournaledAt === null
                ? ""
                : ` · last ${formatRelativeTime(journal.lastJournaledAt)}`
            }
          </span>
        </span>`}
        checked={enabled}
        onCheckedChange={(checked) => setEnabled(checked)}
      />
      <label>
        <span className="type-caption text-muted-foreground font-semibold uppercase [letter-spacing:.06em]">
          Retention days
        </span>
        <input
          aria-label="Journal retention days"
          type="number"
          min={1}
          max={36_500}
          value={retentionDays}
          onChange={(event) => setRetentionDays(event.target.value)}
          className="h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-35"
        />
      </label>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save journal"}
      </Button>
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
    <>
      <PanelHeading
        title="Mail operations"
        subtitle="Tenant-scoped delivery trace, dead-letter recovery, and recipient suppressions"
      />
      <label
        htmlFor="mail-operation-reason"
        className="type-caption text-muted-foreground font-semibold uppercase [letter-spacing:.06em]"
      >
        Reason for recovery action
      </label>
      <input
        id="mail-operation-reason"
        className="input h-7.5 rounded-md [border:1px_solid_var(--border)] bg-card text-foreground [padding:0_8px] type-meta w-full [margin:8px_0_16px]"
        value={reason}
        maxLength={500}
        onChange={(event) => setReason(event.target.value)}
      />
      {operations.isPending ? <LoadingState label="Loading mail operations…" /> : null}
      {operations.isError ? <ErrorNotice>{operations.error.message}</ErrorNotice> : null}
      {actionError !== null ? <ErrorNotice>{actionError}</ErrorNotice> : null}

      {operations.data === undefined ? null : (
        <JournalSettings
          journal={operations.data.journal}
          pending={saveJournal.isPending}
          onSave={(input) => saveJournal.mutate(input)}
        />
      )}

      <section className="panel p-4 mb-3">
        <h2 className="mt-0">Dead letters</h2>
        {operations.data?.deadLetters.length === 0 ? <EmptyRow>No dead letters.</EmptyRow> : null}
        {operations.data?.deadLetters.map((message) => (
          <div
            key={message.id}
            className="flex gap-3 items-center [padding:8px_0] [border-top:1px_solid_var(--border)]"
          >
            <div className="flex-1">
              <strong>{message.messageId}</strong>
              <div className="text-muted-foreground">
                {message.lastError ?? "No diagnostic"} · {String(message.attemptCount)} attempts
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reason.trim() === "" || replay.isPending}
              onClick={() => replay.mutate(message.id)}
            >
              Replay
            </Button>
          </div>
        ))}
      </section>

      <section className="panel p-4 mb-3">
        <h2 className="mt-0">Delivery trace</h2>
        {operations.data?.events.length === 0 ? <EmptyRow>No delivery events.</EmptyRow> : null}
        {operations.data?.events.map((event) => (
          <div key={event.id} className="[padding:8px_0] [border-top:1px_solid_var(--border)]">
            <strong>{event.kind}</strong> · {event.recipient} ·{" "}
            <RelativeTime value={event.occurredAt} />
            {event.diagnostic === null ? null : (
              <div className="text-muted-foreground">{event.diagnostic}</div>
            )}
          </div>
        ))}
      </section>

      <section className="panel p-4">
        <h2 className="mt-0">Suppressions</h2>
        {operations.data?.suppressions.length === 0 ? (
          <EmptyRow>No active suppressions.</EmptyRow>
        ) : null}
        {operations.data?.suppressions.map((suppression) => (
          <div
            key={suppression.id}
            className="flex gap-3 items-center [padding:8px_0] [border-top:1px_solid_var(--border)]"
          >
            <div className="flex-1">
              <strong>{suppression.address}</strong> · {suppression.reason}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reason.trim() === "" || remove.isPending}
              onClick={() => remove.mutate(suppression.id)}
            >
              Remove
            </Button>
          </div>
        ))}
      </section>
    </>
  );
}

/* ================================================================== */
/* Mail section shell                                                 */
/* ================================================================== */

const MAIL_SUBVIEW_CONTENT: Record<MailSubviewId, () => ReactNode> = {
  general: MailGeneral,
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
  const Subview = MAIL_SUBVIEW_CONTENT[subview];

  return (
    <>
      <PageHeading
        title="Mail"
        subtitle="Sending, receiving, domains, routing, and spam protection for your organization."
      />
      <AdminTabs
        label="Mail settings"
        idPrefix="mail"
        tabs={MAIL_SUBVIEWS}
        selected={subview}
        onSelect={selectSubview}
      >
        <Subview />
      </AdminTabs>
    </>
  );
}

const MAIL_FLAGS = [
  {
    key: "mail_outbound",
    label: "Send mail outside the organization",
    description: "When off, people can only send to addresses in your organization's domains.",
  },
] as const;

function MailGeneral() {
  return (
    <div className="admin-stack">
      <AppStatusPanel appId="mail" />
      <WorkspaceFlagsPanel title="Sending" flags={MAIL_FLAGS} />
    </div>
  );
}
