/* Helix Admin — Mail section.
 *
 * Sub-views wired to the mail-delivery admin backend (`/api/admin/mail/*`)
 * via TanStack Query:
 *   - Outbound providers  — list, add (kind-specific config), choose default
 *
 * Sending and inbound domains used to be two tabs here. They are capabilities
 * of a domain, not of Mail, and they now live under Admin > Domains beside the
 * ownership proof and DNS records they depend on — one place to add a domain
 * instead of three.
 *   - Deliverability      — DMARC aggregate report summary (pass/fail rates)
 *   - Routing rules       — list/add/edit/delete inbound rules
 *   - Spam filtering      — spamd threshold + daemon status (read view)
 *
 * `admin-console.tsx` registers `mail` WITHOUT `withPageScroll`, so the shell at
 * the bottom of this file owns the section's one `PageScroll`; the
 * sub-views render inside it and must never add another (nesting scroll
 * containers doubles the page padding and gives the section two scrollbars).
 */

import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { useAdminSectionTab } from "@/features/admin/admin-section-search";
import { Button } from "@/components/ui/button";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import {
  AdminField,
  AdminInput,
  AdminSelect,
  AdminStatRow,
  AdminStatTile,
} from "@/features/admin/console/controls";
import {
  EmptyRow,
  EmptyState,
  PageHeading,
  PageScroll,
  QueryFailureBanner,
  SubviewHeading,
  StateBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import { AdminTable, type AdminColumn } from "@/features/admin/console/table";
import {
  createMailProvider,
  createRoutingRule,
  deleteRoutingRule,
  mailAdminQueryKeys,
  mailDmarcQueryOptions,
  mailProviderKindLabels,
  mailProvidersQueryOptions,
  MAIL_PROVIDER_KINDS,
  patchRoutingRule,
  routingActionLabels,
  routingRulesQueryOptions,
  ROUTING_ACTIONS,
  setDefaultMailProvider,
  spamSettingsQueryOptions,
  type DmarcReport,
  type MailProvider,
  type MailProviderConfig,
  type MailProviderKind,
  type RoutingAction,
  type RoutingRule,
} from "@/features/admin/mail-admin-api";

/* ------------------------------------------------------------------ */
/* Mail sub-navigation                                                */
/* ------------------------------------------------------------------ */

export const MAIL_SUBVIEWS = [
  { id: "providers", label: "Outbound providers" },
  { id: "deliverability", label: "Deliverability" },
  { id: "routing", label: "Routing rules" },
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
/* Local layout vocabulary                                            */
/* ------------------------------------------------------------------ */

const DISCLOSURE = "rounded-[var(--radius)] border border-[var(--border)]";
const DISCLOSURE_SUMMARY =
  "cursor-pointer px-3 py-2 [font-size:var(--text-body-sm)] text-[var(--text-2)]";

/** Title of a panel or form inside a sub-view. The page `<h1>` is "Mail" and a
 *  sub-view title is the `<h2>` under it, so a panel title is an `<h3>` — as a
 *  styled `<div>` it was invisible to anything walking the heading chain. */
function PanelTitle({
  children,
  /** Form titles sit a step below the status-card titles they share a page with. */
  size = "sm",
}: {
  readonly children: ReactNode;
  readonly size?: "sm" | "md";
}) {
  return (
    <h3
      className={
        size === "sm"
          ? "m-0 font-semibold [font-size:var(--text-body-sm)]"
          : "m-0 font-semibold [font-size:var(--text-body)]"
      }
    >
      {children}
    </h3>
  );
}

/* ================================================================== */
/* Outbound providers                                                 */
/* ================================================================== */

const EMPTY_PROVIDER_CONFIG: MailProviderConfig = {
  apiKeyRef: "",
  region: "",
  domain: "",
  host: "",
  port: null,
};

/** Config values the backend never received come back null/empty. "not set" is
 *  the honest reading; a dash reads like a value we failed to fetch. */
function configValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "not set";
  }
  return String(value);
}

function configSummary(kind: MailProviderKind, config: MailProviderConfig): string {
  switch (kind) {
    case "ses":
      return `region ${configValue(config.region)} · key ${configValue(config.apiKeyRef)}`;
    case "mailgun":
      return `domain ${configValue(config.domain)} · key ${configValue(config.apiKeyRef)}`;
    case "postmark":
      return `key ${configValue(config.apiKeyRef)}`;
    case "smtp":
      return `host ${configValue(config.host)} · port ${configValue(config.port)}`;
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
      className="panel mb-3 grid gap-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim().length === 0) {
          return;
        }
        onSubmit({ name: name.trim(), kind, config });
      }}
    >
      <PanelTitle>Add outbound provider</PanelTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <AdminField label="Name">
          <AdminInput
            aria-label="Provider name"
            className="w-full"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Primary SES"
          />
        </AdminField>
        <AdminField label="Kind">
          <AdminSelect
            aria-label="Provider kind"
            className="w-full"
            value={kind}
            onChange={(event) => setKind(event.target.value as MailProviderKind)}
          >
            {MAIL_PROVIDER_KINDS.map((value) => (
              <option key={value} value={value}>
                {mailProviderKindLabels[value]}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
      </div>

      {/* Credentials the chosen provider cannot deliver without. They stay in
          the open on purpose: hiding a required field behind a disclosure
          leaves the primary task half-finishable. */}
      {/* A <legend> inside a display:grid <fieldset> lands in the first cell, so
          the grid goes on an inner wrapper instead. */}
      <fieldset>
        <legend className="mb-1 text-[var(--text-3)] [font-size:var(--text-caption)]">
          {`Connection — ${mailProviderKindLabels[kind]}`}
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {kind === "ses" || kind === "mailgun" || kind === "postmark" ? (
            <AdminField label="API key (env ref)">
              <AdminInput
                aria-label="API key env ref"
                className="w-full"
                value={config.apiKeyRef ?? ""}
                onChange={(event) => setField("apiKeyRef", event.target.value)}
                placeholder="env:MAIL_API_KEY"
              />
            </AdminField>
          ) : null}
          {kind === "ses" ? (
            <AdminField label="Region">
              <AdminInput
                aria-label="Region"
                className="w-full"
                value={config.region ?? ""}
                onChange={(event) => setField("region", event.target.value)}
                placeholder="us-east-1"
              />
            </AdminField>
          ) : null}
          {kind === "mailgun" ? (
            <AdminField label="Domain">
              <AdminInput
                aria-label="Mailgun domain"
                className="w-full"
                value={config.domain ?? ""}
                onChange={(event) => setField("domain", event.target.value)}
                placeholder="mg.helix.io"
              />
            </AdminField>
          ) : null}
          {kind === "smtp" ? (
            <AdminField label="Host">
              <AdminInput
                aria-label="SMTP host"
                className="w-full"
                value={config.host ?? ""}
                onChange={(event) => setField("host", event.target.value)}
                placeholder="smtp.relay.example"
              />
            </AdminField>
          ) : null}
        </div>
      </fieldset>

      {/* The relay port is the one field with a safe default (submission, 587),
          so it is the one field an operator can skip. */}
      {kind === "smtp" ? (
        <details className={DISCLOSURE}>
          <summary className={DISCLOSURE_SUMMARY}>
            Advanced relay settings — submission port
          </summary>
          <div className="border-t border-[var(--border)] p-3">
            <AdminField label="Port">
              <AdminInput
                aria-label="SMTP port"
                className="w-full"
                type="number"
                value={config.port ?? ""}
                onChange={(event) => setField("port", event.target.value)}
                placeholder="587"
              />
            </AdminField>
          </div>
        </details>
      ) : null}

      <div className="flex justify-end gap-2">
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

  /* Retry through the query key rather than the observer so every reader of the
     providers list recovers together. */
  const failure = useQueryFailure(providersQuery, () => {
    void invalidate();
  });

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
  const mutationError = createMutation.error ?? defaultMutation.error;
  const showEmptyState =
    failure === null && !providersQuery.isPending && providers.length === 0 && !showForm;

  const providerColumns: readonly AdminColumn<MailProvider>[] = [
    {
      id: "name",
      header: "Name",
      cell: (provider) => (
        <span className="font-medium">
          {provider.name}
          {provider.isDefault ? <span className="chip accent ml-2">Default</span> : null}
        </span>
      ),
    },
    {
      id: "kind",
      header: "Kind",
      width: "130px",
      cell: (provider) => <span className="chip">{mailProviderKindLabels[provider.kind]}</span>,
    },
    {
      id: "config",
      header: "Config",
      cell: (provider) => (
        <span className="mono text-[var(--text-2)] [font-size:var(--text-caption)]">
          {configSummary(provider.kind, provider.config)}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: "110px",
      cell: (provider) => (
        <span className={`chip ${provider.enabled ? "success" : "warning"}`}>
          <span className="chip-dot" />
          {provider.enabled ? "Enabled" : "Disabled"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      headerHidden: true,
      align: "right",
      width: "130px",
      /* The default provider gets no button: the chip beside its name already
         says so, and "Set default" on it would do nothing. */
      cell: (provider) =>
        provider.isDefault ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={defaultMutation.isPending}
            aria-label={`Make ${provider.name} default`}
            onClick={() => defaultMutation.mutate(provider.id)}
          >
            Set default
          </Button>
        ),
    },
  ];

  return (
    <>
      <SubviewHeading
        title="Outbound providers"
        subtitle="Mail-sending providers and the default used for outbound delivery."
        actions={
          /* The empty state carries the only call to action when there is
             nothing to list; two "Add provider" buttons on one screen is one
             too many. */
          showEmptyState ? null : (
            <Button type="button" aria-expanded={showForm} onClick={() => setShowForm((o) => !o)}>
              <Icons.Plus /> Add provider
            </Button>
          )
        }
      />

      {failure ? (
        <QueryFailureBanner
          summary="Outbound providers are unavailable"
          subject="mail providers"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
          retryVariant="default"
        >
          Until this loads, Helix cannot show which provider is sending your mail.
        </QueryFailureBanner>
      ) : null}
      {mutationError ? <StateBanner kind="error">{mutationError.message}</StateBanner> : null}

      {showForm ? (
        <ProviderForm
          pending={createMutation.isPending}
          onCancel={() => setShowForm(false)}
          onSubmit={(input) => createMutation.mutate(input)}
        />
      ) : null}

      {failure !== null ? null : providersQuery.isPending ? (
        <div className="panel">
          <EmptyRow>Loading outbound providers…</EmptyRow>
        </div>
      ) : showEmptyState ? (
        <EmptyState
          icon={<Icons.Send />}
          title="No outbound providers"
          action={
            <Button type="button" onClick={() => setShowForm(true)}>
              <Icons.Plus /> Add provider
            </Button>
          }
        >
          An outbound provider is the service Helix hands mail to on its way out — Amazon SES,
          Mailgun, Postmark, or an SMTP relay. Add one and mark it default to start delivering.
        </EmptyState>
      ) : providers.length === 0 ? null : (
        <div className="panel overflow-hidden">
          <AdminTable
            label="Outbound mail providers"
            columns={providerColumns}
            rows={providers}
            rowKey={(provider) => provider.id}
          />
        </div>
      )}
    </>
  );
}

/* ================================================================== */
/* Deliverability (DMARC)                                             */
/* ================================================================== */

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

const DMARC_COLUMNS: readonly AdminColumn<DmarcReport>[] = [
  { id: "reporter", header: "Reporter", cell: (report) => report.reporter },
  {
    id: "domain",
    header: "Domain",
    cell: (report) => <span className="text-[var(--text-2)]">{report.domain}</span>,
  },
  {
    id: "window",
    header: "Window",
    cell: (report) => (
      <span className="mono text-[var(--text-3)] [font-size:var(--text-caption)]">
        {report.rangeStart} → {report.rangeEnd}
      </span>
    ),
  },
  { id: "total", header: "Messages", align: "right", cell: (report) => report.total },
  {
    id: "pass",
    header: "Pass",
    align: "right",
    cell: (report) => <span className="text-[var(--success)]">{report.passCount}</span>,
  },
  {
    id: "fail",
    header: "Fail",
    align: "right",
    /* Only colour a failure count that is actually non-zero — a red 0 reads as
       a problem the reporter did not report. */
    cell: (report) => (
      <span className={report.failCount > 0 ? "text-[var(--danger)]" : undefined}>
        {report.failCount}
      </span>
    ),
  },
];

function Deliverability() {
  const queryClient = useQueryClient();
  const dmarcQuery = useQuery(mailDmarcQueryOptions());
  const data = dmarcQuery.data;
  const summary = data?.summary;
  const reports = data?.reports ?? [];

  const failure = useQueryFailure(dmarcQuery, () => {
    void queryClient.invalidateQueries({ queryKey: mailAdminQueryKeys.dmarc() });
  });

  const rateCards = useMemo(
    () =>
      /* Per metric, not all-or-nothing. The backend can state the DMARC rate
         today but not the per-mechanism SPF/DKIM rates; dropping only the cards
         it cannot back beats dropping the one it can. A null rate is never
         rendered as 0%. */
      summary
        ? [
            { label: "DMARC pass rate", value: percent(summary.dmarcPassRate) },
            ...(summary.spfPassRate === null
              ? []
              : [{ label: "SPF pass rate", value: percent(summary.spfPassRate) }]),
            ...(summary.dkimPassRate === null
              ? []
              : [{ label: "DKIM pass rate", value: percent(summary.dkimPassRate) }]),
          ]
        : [],
    [summary],
  );

  return (
    <>
      <SubviewHeading
        title="Deliverability"
        subtitle={
          summary
            ? `DMARC aggregate reports over the last ${String(summary.windowDays)} days · ${new Intl.NumberFormat("en-US").format(summary.messagesEvaluated)} messages evaluated.`
            : "DMARC aggregate report summary."
        }
      />

      {failure ? (
        <QueryFailureBanner
          summary="Deliverability reports are unavailable"
          subject="deliverability reports"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
          retryVariant="default"
        >
          Pass rates and per-reporter detail both come from this request.
        </QueryFailureBanner>
      ) : dmarcQuery.isPending ? (
        <StateBanner kind="loading">Loading deliverability summary…</StateBanner>
      ) : null}

      {summary ? (
        <div className="mb-4">
          <AdminStatRow>
            {rateCards.map((card) => (
              <AdminStatTile key={card.label} label={card.label} value={card.value} />
            ))}
          </AdminStatRow>
        </div>
      ) : null}

      {failure !== null || dmarcQuery.isPending ? null : reports.length === 0 ? (
        <div className="panel">
          <EmptyRow>
            No DMARC aggregate reports have arrived yet. Mailbox providers send them once your
            domain publishes a DMARC record that asks for reports.
          </EmptyRow>
        </div>
      ) : (
        /* The three pass rates are the decision on this page; the per-reporter
           rows are the drill-down behind them. */
        <details className={DISCLOSURE}>
          <summary className={DISCLOSURE_SUMMARY}>
            {`Per-reporter aggregate reports (${String(reports.length)}) — reporter, window, and pass/fail counts`}
          </summary>
          <div className="border-t border-[var(--border)]">
            <AdminTable
              label="DMARC reports"
              columns={DMARC_COLUMNS}
              rows={reports}
              rowKey={(report) => report.id}
            />
          </div>
        </details>
      )}
    </>
  );
}

/* ================================================================== */
/* Routing rules                                                      */
/* ================================================================== */

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

  return (
    <form
      className="panel mb-3 grid gap-3 p-4"
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
      <PanelTitle>Add inbound routing rule</PanelTitle>
      <div className="grid gap-3 sm:grid-cols-3">
        <AdminField label="Match pattern">
          <AdminInput
            aria-label="Match pattern"
            className="w-full"
            value={matchPattern}
            onChange={(event) => setMatchPattern(event.target.value)}
            placeholder="*@support.helix.io"
          />
        </AdminField>
        <AdminField label="Action">
          <AdminSelect
            aria-label="Routing action"
            className="w-full"
            value={action}
            onChange={(event) => setAction(event.target.value as RoutingAction)}
          >
            {ROUTING_ACTIONS.map((value) => (
              <option key={value} value={value}>
                {routingActionLabels[value]}
              </option>
            ))}
          </AdminSelect>
        </AdminField>
        <AdminField label="Destination">
          <AdminInput
            aria-label="Destination"
            className="w-full"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="support-team or https://hook"
          />
        </AdminField>
      </div>

      {/* Priority has a working default (100) and only matters once two rules
          can match the same recipient. */}
      <details className={DISCLOSURE}>
        <summary className={DISCLOSURE_SUMMARY}>
          Advanced — match priority when several rules overlap
        </summary>
        <div className="border-t border-[var(--border)] p-3">
          <AdminField label="Priority">
            <AdminInput
              aria-label="Priority"
              className="w-full"
              type="number"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </AdminField>
          <p className="mt-2 mb-0 text-[var(--text-3)] [font-size:var(--text-caption)]">
            Rules are matched in ascending priority order — the lowest number wins.
          </p>
        </div>
      </details>

      <div className="flex justify-end gap-2">
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

/** What deleting this rule costs.
 *
 *  The live/parked branch comes off the rule's own `enabled` flag — telling an
 *  operator that inbound mail stops being routed by a rule that is switched off
 *  would be a consequence that does not exist. */
function routingRuleBlastRadius(rule: RoutingRule): string {
  return rule.enabled
    ? `This rule is active: inbound mail matching ${rule.matchPattern} stops going to ${rule.destination} and falls through to whichever lower-priority rule matches next, if any.`
    : "This rule is switched off, so no inbound mail is being routed by it right now.";
}

function RoutingRules() {
  const queryClient = useQueryClient();
  const rulesQuery = useQuery(routingRulesQueryOptions());
  const [showForm, setShowForm] = useState(false);
  /* Snapshot of the row: the three values below are the only record of this
     rule the console holds, and the list refetches on its own. */
  const [deleteTarget, setDeleteTarget] = useState<RoutingRule | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: mailAdminQueryKeys.routingRules() });

  const failure = useQueryFailure(rulesQuery, () => {
    void invalidate();
  });

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
  const mutationError = createMutation.error ?? patchMutation.error ?? deleteMutation.error;
  const showEmptyState =
    failure === null && !rulesQuery.isPending && rules.length === 0 && !showForm;

  const ruleColumns: readonly AdminColumn<RoutingRule>[] = [
    {
      id: "priority",
      header: "Priority",
      width: "80px",
      align: "right",
      cell: (rule) => (
        <span className="mono text-[var(--text-3)] [font-size:var(--text-caption)]">
          {rule.priority}
        </span>
      ),
    },
    {
      id: "match",
      header: "Match",
      cell: (rule) => (
        <span className="mono [font-size:var(--text-caption)]">{rule.matchPattern}</span>
      ),
    },
    {
      id: "action",
      header: "Action",
      width: "150px",
      cell: (rule) => <span className="chip">{routingActionLabels[rule.action]}</span>,
    },
    {
      id: "destination",
      header: "Destination",
      cell: (rule) => <span className="text-[var(--text-2)]">{rule.destination}</span>,
    },
    {
      id: "status",
      header: "Status",
      width: "100px",
      cell: (rule) => (
        <span className={`chip ${rule.enabled ? "success" : "warning"}`}>
          <span className="chip-dot" />
          {rule.enabled ? "Active" : "Off"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      headerHidden: true,
      align: "right",
      width: "170px",
      cell: (rule) => (
        <div className="flex justify-end gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`${rule.enabled ? "Disable" : "Enable"} rule ${rule.matchPattern}`}
            disabled={patchMutation.isPending}
            onClick={() => patchMutation.mutate({ id: rule.id, enabled: !rule.enabled })}
          >
            {rule.enabled ? "Disable" : "Enable"}
          </Button>
          {/* Stays a glyph — the column holds "Disable" and this together and
              nothing else — but not a grey one: it was indistinguishable from
              the reversible toggle beside it. */}
          <Button
            type="button"
            size="icon-sm"
            variant="destructive"
            title={`Delete rule ${rule.matchPattern}`}
            aria-label={`Delete rule ${rule.matchPattern}`}
            disabled={deleteMutation.isPending}
            onClick={() => setDeleteTarget(rule)}
          >
            <Icons.Trash />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <SubviewHeading
        title="Routing rules"
        subtitle="Inbound mail routing — matched in ascending priority order."
        actions={
          showEmptyState ? null : (
            <Button type="button" aria-expanded={showForm} onClick={() => setShowForm((o) => !o)}>
              <Icons.Plus /> Add rule
            </Button>
          )
        }
      />

      {failure ? (
        <QueryFailureBanner
          summary="Routing rules are unavailable"
          subject="routing rules"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
          retryVariant="default"
        >
          Inbound mail keeps following whatever rules the server already has — this page just cannot
          show or change them.
        </QueryFailureBanner>
      ) : null}
      {mutationError ? <StateBanner kind="error">{mutationError.message}</StateBanner> : null}

      {showForm ? (
        <RoutingForm
          pending={createMutation.isPending}
          onCancel={() => setShowForm(false)}
          onSubmit={(input) => createMutation.mutate(input)}
        />
      ) : null}

      {failure !== null ? null : rulesQuery.isPending ? (
        <div className="panel">
          <EmptyRow>Loading routing rules…</EmptyRow>
        </div>
      ) : showEmptyState ? (
        <EmptyState
          icon={<Icons.Filter />}
          title="No inbound routing rules"
          action={
            <Button type="button" onClick={() => setShowForm(true)}>
              <Icons.Plus /> Add rule
            </Button>
          }
        >
          A routing rule matches inbound mail by recipient pattern and decides what happens to it —
          deliver to a mailbox, forward it, post it to a webhook, or drop it. Rules are matched in
          ascending priority order.
        </EmptyState>
      ) : rules.length === 0 ? null : (
        <div className="panel overflow-hidden">
          <AdminTable
            label="Inbound routing rules"
            columns={ruleColumns}
            rows={rules}
            rowKey={(rule) => rule.id}
          />
        </div>
      )}

      {/* Irreversible from here — a deleted rule's pattern, action and
          destination exist nowhere else in this console — so the dialog is
          where the operator gets one last look at the three values they would
          have to retype. No typed phrase: re-creating a rule is the three-field
          form at the top of this view, not a support ticket. */}
      {deleteTarget === null ? null : (
        <ConfirmDestructive
          open
          onOpenChange={(next) => {
            if (!next) {
              setDeleteTarget(null);
            }
          }}
          title="Delete routing rule"
          blastRadius={routingRuleBlastRadius(deleteTarget)}
          confirmLabel="Delete rule"
          isPending={deleteMutation.isPending}
          onConfirm={() =>
            deleteMutation.mutate(deleteTarget.id, {
              /* Settle, not success: the mutation banner behind this overlay is
                 the only account of a failure. */
              onSettled: () => setDeleteTarget(null),
            })
          }
        >
          Deleting priority {deleteTarget.priority}: <code>{deleteTarget.matchPattern}</code> →{" "}
          {routingActionLabels[deleteTarget.action]} → <code>{deleteTarget.destination}</code>. Copy
          those values now if you might want the rule back — the console keeps no record of a
          deleted rule.
        </ConfirmDestructive>
      )}
    </>
  );
}

/* ================================================================== */
/* Spam filtering                                                     */
/* ================================================================== */

/** The backend omits these when it has nothing to report. "Unknown" says that;
 *  a dash or a zero would read like a value we actually received. */
function knownNumber(value: number | null | undefined, format: (value: number) => string): string {
  return value === null || value === undefined ? "Unknown" : format(value);
}

function SpamFiltering() {
  const queryClient = useQueryClient();
  const spamQuery = useQuery(spamSettingsQueryOptions());
  const settings = spamQuery.data;

  const failure = useQueryFailure(spamQuery, () => {
    void queryClient.invalidateQueries({ queryKey: mailAdminQueryKeys.spam() });
  });

  const daemonVariant =
    settings?.daemonStatus === "running"
      ? "success"
      : settings?.daemonStatus === "stopped"
        ? "danger"
        : "warning";

  const spamdHost =
    settings?.spamd?.host !== undefined && settings.spamd.host !== null
      ? `${settings.spamd.host}${settings.spamd.port !== null ? `:${String(settings.spamd.port)}` : ""}`
      : null;

  return (
    <>
      <SubviewHeading
        title="Spam filtering"
        subtitle="SpamAssassin (spamd) is env-driven and read-only here. Optional AI second-pass is configured under AI providers."
      />

      {failure ? (
        <QueryFailureBanner
          summary="Spam filtering settings are unavailable"
          subject="spam filtering"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
          retryVariant="default"
        >
          Filtering keeps running on the server; this page just cannot read its thresholds. If the
          API is older than this UI, restart Helix so GET /api/admin/mail/spam is registered.
        </QueryFailureBanner>
      ) : spamQuery.isPending ? (
        <StateBanner kind="loading">Loading spam settings…</StateBanner>
      ) : null}

      {settings ? (
        <>
          {!settings.enabled ? (
            <StateBanner kind="info">
              SpamAssassin is off for this process (
              <code className="text-[0.7rem]">MAIL_SPAMD_ENABLED</code> not set). Inbound mail is
              not scored by spamd until that env flag is enabled and a reachable spamd host is
              configured.
            </StateBanner>
          ) : null}

          <div className="panel mb-3 flex flex-wrap items-center gap-3 p-4">
            <span className="text-[var(--text-3)]">
              <Icons.Shield />
            </span>
            <div className="min-w-0 flex-1">
              <PanelTitle size="md">SpamAssassin (spamd)</PanelTitle>
              <div className="text-[var(--text-2)] [font-size:var(--text-meta)]">
                {spamdHost !== null
                  ? `Host ${spamdHost} · ruleset ${settings.rulesetVersion ?? "Unknown"}`
                  : `Ruleset ${settings.rulesetVersion ?? "Unknown"}`}
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

          {settings.aiBeta !== undefined ? (
            <div className="panel mb-3 flex flex-wrap items-center gap-3 p-4">
              <span className="text-[var(--text-3)]">
                <Icons.Sparkles />
              </span>
              <div className="min-w-0 flex-1">
                <PanelTitle size="md">
                  Mail spam AI <span className="font-normal text-[var(--text-3)]">(beta)</span>
                </PanelTitle>
                <div className="text-[var(--text-2)] [font-size:var(--text-meta)]">
                  {settings.aiBeta.enabled
                    ? `Model ${settings.aiBeta.model} · ${settings.aiBeta.apiKeyConfigured ? "API key configured" : "no API key"}`
                    : "Second-pass after spamd is disabled (env or Admin)."}
                </div>
              </div>
              <span className={`chip ${settings.aiBeta.enabled ? "success" : "warning"}`}>
                <span className="chip-dot" />
                {settings.aiBeta.enabled ? "AI beta on" : "AI beta off"}
              </span>
              <Button asChild size="sm" type="button" variant="outline">
                {/* A same-origin anchor here would be a full document reload —
                    entry bundle re-parsed, session re-fetched, every warm query
                    thrown away — to move one section sideways. */}
                <Link to="/admin/$section" params={{ section: "ai-providers" }}>
                  Configure in AI providers
                </Link>
              </Button>
            </div>
          ) : null}

          <div className="mb-3">
            <AdminStatTile
              label="Spam threshold"
              value={settings.threshold.toFixed(1)}
              note="Score above which mail is tagged as spam"
            />
          </div>

          {/* Threshold and daemon state are the decision here; the reject cut-off
              and the volume counters are the detail behind it. */}
          <details className={DISCLOSURE}>
            <summary className={DISCLOSURE_SUMMARY}>
              Advanced detail — reject threshold, ruleset version, and messages tagged in the last
              day
            </summary>
            <div className="border-t border-[var(--border)] p-3">
              <AdminStatRow>
                <AdminStatTile
                  label="Reject threshold"
                  value={knownNumber(settings.rejectThreshold, (value) => value.toFixed(1))}
                  note="Score above which mail is rejected outright"
                />
                <AdminStatTile
                  label="Ruleset version"
                  value={settings.rulesetVersion ?? "Unknown"}
                  note="Rule bundle the daemon is matching against"
                />
                <AdminStatTile
                  label="Tagged (24h)"
                  value={knownNumber(settings.taggedLast24h, (value) =>
                    new Intl.NumberFormat("en-US").format(value),
                  )}
                  note="Messages flagged as spam in the last day"
                />
              </AdminStatRow>
            </div>
          </details>
        </>
      ) : null}
    </>
  );
}

/* ================================================================== */
/* Mail section shell                                                 */
/* ================================================================== */

const MAIL_SUBVIEW_CONTENT: Record<MailSubviewId, () => ReactNode> = {
  providers: MailProviders,
  deliverability: Deliverability,
  routing: RoutingRules,
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
    const nextIndex =
      event.key === "ArrowRight"
        ? (current + 1) % MAIL_SUBVIEWS.length
        : event.key === "ArrowLeft"
          ? (current + last) % MAIL_SUBVIEWS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (nextIndex === null) {
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
    <PageScroll>
      <PageHeading
        title="Mail"
        subtitle="Outbound delivery, deliverability, inbound routing, and spam filtering. Domains live under Domains."
      />

      {/* The console's only second-level nav: sibling views of one section,
          which is what a tab bar is for. The buttons wear the app-wide `.tab`
          look; the bar itself is built here rather than with `.tabs` because
          that class carries a 12px inset that would knock the tabs out of line
          with the heading above them. */}
      <div
        role="tablist"
        aria-label="Mail admin views"
        className="mb-5 flex gap-0.5 border-b border-[var(--border)]"
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
              className={`tab focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)] ${active ? "active" : ""}`.trim()}
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
    </PageScroll>
  );
}
