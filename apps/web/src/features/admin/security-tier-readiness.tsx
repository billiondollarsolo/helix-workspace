/* Admin › Security › Tier readiness.
 *
 * Primary job: show the live tier, pick a target, review gates, apply.
 * Plugins are a second tab — they are not tier gates. Reference control tables
 * and AI cost cards do not live here (Policies / AI cost limits own those).
 *
 * Catalogue, transport, and projection live in `tier-readiness/`.
 * Re-exports keep `TierId` / query options importable from this module. */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, CheckCircle2, CircleDashed, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AdminSecurityRelatedNav } from "@/features/admin/admin-related-nav";
import {
  resolveClosedSearchParam,
  useAdminSectionSearch,
} from "@/features/admin/admin-section-search";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { PageHeading, StateBanner } from "@/features/admin/console/primitives";
import {
  adminPlatformConfigQueryKey,
  adminPlatformConfigQueryOptions,
  adminPluginCatalogQueryKey,
  adminPluginCatalogQueryOptions,
  installPlugin,
  mutatePluginLifecycle,
  updatePlatformTier,
} from "@/features/admin/tier-readiness/api";
import {
  serviceById,
  serviceRequirementKeyById,
  statusText,
  tiers,
} from "@/features/admin/tier-readiness/catalog";
import {
  backendStatusText,
  formatList,
  formatValue,
  titleForTier,
} from "@/features/admin/tier-readiness/format";
import {
  canDisablePlugin,
  canEnablePlugin,
  canUninstallPlugin,
  pluginConfirmationsForSource,
  pluginInstallStatusMessage,
  pluginLifecycleLabel,
  pluginLifecycleStatusMessage,
} from "@/features/admin/tier-readiness/plugins";
import {
  serviceFromBackendRequirement,
  tierGatesForTier,
} from "@/features/admin/tier-readiness/readiness";
import type {
  CheckStatus,
  PlatformConfigStatus,
  PluginCatalogItem,
  PluginCatalogStatus,
  PluginConfirmation,
  PluginInstallResult,
  PluginLifecycleResult,
  PluginSource,
  RenderedReadinessCheck,
  RequirementField,
  TierId,
} from "@/features/admin/tier-readiness/types";

export {
  adminPlatformConfigQueryKey,
  adminPlatformConfigQueryOptions,
  adminPluginCatalogQueryKey,
  adminPluginCatalogQueryOptions,
  prefetchAdminReadinessQueries,
} from "@/features/admin/tier-readiness/api";
export {
  aiCostAuditRowsForTier,
  backendStatusToCheckStatus,
  formatRequirementFields,
  readinessCheckFromBackend,
  serviceFromBackendRequirement,
  serviceStatusFromBackend,
  tierGatesForTier,
} from "@/features/admin/tier-readiness/readiness";
export type { PlatformConfigPatch, TierId } from "@/features/admin/tier-readiness/types";

const TIER_IDS = [
  "personal",
  "business",
  "enterprise",
  "sovereign",
] as const satisfies readonly TierId[];

const TIER_PAGE_TABS = ["readiness", "plugins"] as const;
type TierPageTab = (typeof TIER_PAGE_TABS)[number];
const TIER_PAGE_TAB_LABELS: Record<TierPageTab, string> = {
  readiness: "Readiness",
  plugins: "Plugins",
};

/** Rewrites the cached plugin catalog in place: every plugin `matches` accepts
 *  is replaced by `patch(plugin)`, everything else is left alone. The
 *  `current === undefined` guard lives here so no caller can forget it — with
 *  no catalog cached there is nothing to patch, and writing a synthesised entry
 *  would put a plugin on screen the backend never returned. */
function patchCachedPluginCatalog(
  queryClient: QueryClient,
  matches: (plugin: PluginCatalogItem) => boolean,
  patch: (plugin: PluginCatalogItem) => PluginCatalogItem,
): void {
  queryClient.setQueryData<PluginCatalogStatus | undefined>(
    adminPluginCatalogQueryKey,
    (current) =>
      current === undefined
        ? current
        : {
            ...current,
            plugins: current.plugins.map((plugin) => (matches(plugin) ? patch(plugin) : plugin)),
          },
  );
}

/** Checkbox toggle over a list of acknowledged ids. */
function toggleId(current: readonly string[], id: string): readonly string[] {
  return current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
}

export function SecurityTierReadiness() {
  const { search, patchSearch } = useAdminSectionSearch("tier-readiness");
  const [tierConfirmOpen, setTierConfirmOpen] = useState(false);
  const [pluginSource, setPluginSource] = useState<PluginSource>("official");
  const [confirmedPluginRequirements, setConfirmedPluginRequirements] = useState<readonly string[]>(
    [],
  );
  const [pluginInstallStatus, setPluginInstallStatus] = useState<PluginInstallResult | null>(null);
  const [pluginLifecycleStatus, setPluginLifecycleStatus] = useState<PluginLifecycleResult | null>(
    null,
  );
  /* Uninstall is answered by the BACKEND's confirmation requirements, never by
     this client. `uninstallRequirements` holds what the platform said it wants
     acknowledged; `acknowledgedUninstallIds` holds what the operator actually
     ticked, and only those ids are ever sent back. */
  const [uninstallPluginId, setUninstallPluginId] = useState<string | null>(null);
  const [uninstallConfirmOpen, setUninstallConfirmOpen] = useState(false);
  const [uninstallRequirements, setUninstallRequirements] = useState<readonly PluginConfirmation[]>(
    [],
  );
  const [acknowledgedUninstallIds, setAcknowledgedUninstallIds] = useState<readonly string[]>([]);
  const tabRefs = useRef<Partial<Record<TierPageTab, HTMLButtonElement | null>>>({});
  const queryClient = useQueryClient();
  const platformConfigQuery = useQuery(adminPlatformConfigQueryOptions());
  const pluginCatalogQuery = useQuery(adminPluginCatalogQueryOptions());
  const liveTier = platformConfigQuery.data?.config.security.tier;
  /* Deep-link: `?plugin=` without `?tab=` opens Plugins. Otherwise readiness. */
  const activeTab: TierPageTab = resolveClosedSearchParam(
    search.tab,
    TIER_PAGE_TABS,
    search.plugin !== undefined ? "plugins" : "readiness",
  );
  const setActiveTab = (tab: TierPageTab) => {
    patchSearch({
      tab: tab === "readiness" ? undefined : tab,
      ...(tab === "readiness" ? { plugin: undefined } : {}),
    });
  };
  /* Roving tabindex keeps only the selected tab in the document tab order, so
     without this handler the unselected tab (Plugins) was reachable by mouse
     only — no keyboard route to it existed at all. Same ARIA tabs interface as
     the mail admin tab bar: Left/Right wrap, Home/End jump to the ends. */
  const moveTabSelection = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const last = TIER_PAGE_TABS.length - 1;
    const current = TIER_PAGE_TABS.indexOf(activeTab);
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (current + 1) % TIER_PAGE_TABS.length;
        break;
      case "ArrowLeft":
        nextIndex = (current + last) % TIER_PAGE_TABS.length;
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
    const next = TIER_PAGE_TABS[nextIndex];
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    setActiveTab(next);
    tabRefs.current[next]?.focus();
  };

  /* URL `?tier=` wins when present; otherwise follow the live platform tier. */
  const selectedTierId: TierId = resolveClosedSearchParam(
    search.tier,
    TIER_IDS,
    liveTier ?? "business",
  );
  const setSelectedTierId = (tier: TierId) => {
    patchSearch({ tier });
  };
  const selectedPluginId = search.plugin ?? null;
  const setSelectedPluginId = (pluginId: string | null) => {
    patchSearch({
      plugin: pluginId ?? undefined,
      tab: "plugins",
    });
  };
  const tierMutation = useMutation({
    mutationFn: updatePlatformTier,
    onMutate: async (tier) => {
      await queryClient.cancelQueries({ queryKey: adminPlatformConfigQueryKey });
      const previousPlatformConfig = queryClient.getQueryData<PlatformConfigStatus>(
        adminPlatformConfigQueryKey,
      );

      queryClient.setQueryData<PlatformConfigStatus | undefined>(
        adminPlatformConfigQueryKey,
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                config: {
                  ...current.config,
                  security: {
                    ...current.config.security,
                    tier,
                  },
                },
              },
      );

      return { previousPlatformConfig };
    },
    onError: (_error, _tier, context) => {
      if (context?.previousPlatformConfig !== undefined) {
        queryClient.setQueryData(adminPlatformConfigQueryKey, context.previousPlatformConfig);
      }
    },
    onSuccess: (status) => {
      queryClient.setQueryData(adminPlatformConfigQueryKey, status);
      setSelectedTierId(status.config.security.tier);
    },
    onSettled: () => {
      // Closes on failure too — "Could not apply the tier draft." renders in
      // the panel behind the dialog, so an open dialog would hide it.
      setTierConfirmOpen(false);
    },
  });
  const pluginInstallMutation = useMutation({
    mutationFn: installPlugin,
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: adminPluginCatalogQueryKey });
      const previousPluginCatalog = queryClient.getQueryData<PluginCatalogStatus>(
        adminPluginCatalogQueryKey,
      );

      patchCachedPluginCatalog(
        queryClient,
        (plugin) => plugin.id === input.pluginId && plugin.version === input.version,
        (plugin) => ({
          ...plugin,
          install: {
            ...(plugin.install ?? {}),
            optimisticStatus: "installing",
            source: input.source,
          },
        }),
      );

      return { previousPluginCatalog };
    },
    onError: (_error, _input, context) => {
      if (context?.previousPluginCatalog !== undefined) {
        queryClient.setQueryData(adminPluginCatalogQueryKey, context.previousPluginCatalog);
      }
    },
    onSuccess: (result) => {
      setPluginInstallStatus(result);
      if (result.status === "installed" && result.plugin !== undefined) {
        patchCachedPluginCatalog(
          queryClient,
          (plugin) => plugin.id === result.plugin?.id,
          (plugin) => ({
            ...plugin,
            ...result.plugin,
            install: {
              ...(plugin.install ?? {}),
              optimisticStatus: "installed",
              source: result.source,
            },
          }),
        );
      }
      void queryClient.invalidateQueries({ queryKey: adminPluginCatalogQueryKey });
    },
  });
  const pluginLifecycleMutation = useMutation({
    mutationFn: mutatePluginLifecycle,
    onMutate: () => undefined,
    onError: () => {
      setPluginLifecycleStatus(null);
    },
    onSuccess: (result, input) => {
      setPluginLifecycleStatus(result);
      if (input.action === "uninstall") {
        if (result.status === "blocked_confirmation_required") {
          /* The platform refused and named the requirements it wants
             acknowledged. Merge rather than replace: it returns only the
             still-missing ones, so replacing would drop requirements the
             operator has already read and ticked. */
          setUninstallPluginId(input.pluginId);
          setUninstallRequirements((current) =>
            mergeConfirmations(current, result.confirmations ?? []),
          );
        } else if (result.status === "uninstalled") {
          setUninstallPluginId(null);
          setUninstallRequirements([]);
          setAcknowledgedUninstallIds([]);
        }
      }
      if (result.plugin !== undefined && result.lifecycle !== undefined) {
        patchCachedPluginCatalog(
          queryClient,
          (plugin) => plugin.id === result.plugin?.id,
          (plugin) => ({
            ...plugin,
            ...result.plugin,
            lifecycle: result.lifecycle,
          }),
        );
      }
      void queryClient.invalidateQueries({ queryKey: adminPluginCatalogQueryKey });
    },
    onSettled: () => {
      /* Closes on refusal and on failure too: both render behind the dialog —
         the requirement checklist in the plugins panel, the error in the card —
         and an open dialog would cover them. */
      setUninstallConfirmOpen(false);
    },
  });

  const pluginCatalog = pluginCatalogQuery.data?.plugins ?? [];
  const selectedPlugin = useMemo(
    () => pluginCatalog.find((plugin) => plugin.id === selectedPluginId) ?? pluginCatalog[0],
    [pluginCatalog, selectedPluginId],
  );
  const pluginConfirmations = useMemo(
    () =>
      selectedPlugin === undefined
        ? []
        : pluginConfirmationsForSource(selectedPlugin, pluginSource),
    [pluginSource, selectedPlugin],
  );
  const confirmedPluginIds = useMemo(
    () => new Set(confirmedPluginRequirements),
    [confirmedPluginRequirements],
  );
  const allPluginConfirmationsAccepted = pluginConfirmations.every((confirmation) =>
    confirmedPluginIds.has(confirmation.id),
  );
  const uninstallPlugin = useMemo(
    () => pluginCatalog.find((plugin) => plugin.id === uninstallPluginId),
    [pluginCatalog, uninstallPluginId],
  );
  const acknowledgedUninstallSet = useMemo(
    () => new Set(acknowledgedUninstallIds),
    [acknowledgedUninstallIds],
  );
  const outstandingUninstallRequirements = uninstallRequirements.filter(
    (requirement) => !acknowledgedUninstallSet.has(requirement.id),
  );
  /* Opening the flow for a different plugin must not inherit the previous
     plugin's requirements or ticks — those ids unlock a destructive tool. */
  const startUninstall = useCallback(
    (plugin: PluginCatalogItem) => {
      if (plugin.id !== uninstallPluginId) {
        setUninstallRequirements([]);
        setAcknowledgedUninstallIds([]);
      }
      setUninstallPluginId(plugin.id);
      setPluginLifecycleStatus(null);
      setUninstallConfirmOpen(true);
    },
    [uninstallPluginId],
  );

  useEffect(() => {
    setConfirmedPluginRequirements([]);
    setPluginInstallStatus(null);
  }, [pluginSource, selectedPlugin?.id]);

  const selectedTier = tiers.find((tier) => tier.id === selectedTierId) ?? tiers[1];
  if (selectedTier === undefined) {
    throw new Error(`Unknown security tier: ${selectedTierId}`);
  }

  const backendStatus = platformConfigQuery.data;
  /* The platform evaluates readiness for the tier it is RUNNING and for nothing
     else, so this is `undefined` for every other target tier — which is the
     usual case on this screen, since picking a target tier is its point. */
  const measuredRequirements =
    backendStatus !== undefined && backendStatus.config.security.tier === selectedTierId
      ? backendStatus.readiness.requirements
      : undefined;
  /* Three states, and the two unscored ones are NOT the same thing:
     - "unscoreable": the config API gave us nothing usable, so we cannot even
       say which tier is live.
     - "not-evaluated": the platform is live and answering, but the operator is
       looking at a tier it does not run. The catalogue still knows which gates
       that tier requires; nothing knows whether this deployment meets them.
     Neither may produce a score, and both must confirm before applying — but
     "backend unavailable" is the wrong sentence to show an operator whose
     backend is fine and simply has not measured the tier they picked. */
  const readinessMode: "measured" | "not-evaluated" | "unscoreable" =
    platformConfigQuery.isError || backendStatus === undefined
      ? "unscoreable"
      : measuredRequirements === undefined
        ? "not-evaluated"
        : "measured";
  const requiredServiceList = useMemo(() => {
    if (platformConfigQuery.isError) {
      return [];
    }
    return selectedTier.requiredServiceIds
      .map((serviceId) => serviceById.get(serviceId))
      .filter((service) => service !== undefined)
      .map((service) =>
        serviceFromBackendRequirement(
          service,
          measuredRequirements?.find(
            (requirement) => requirement.key === serviceRequirementKeyById[service.id],
          ),
        ),
      );
  }, [measuredRequirements, platformConfigQuery.isError, selectedTier]);
  const tierGates = useMemo(
    () => tierGatesForTier(selectedTierId, measuredRequirements),
    [measuredRequirements, selectedTierId],
  );
  /* Measured gates carry statuses; expectations never do. With no usable config
     we show neither — the screen's job then is to report the outage, not to
     page through catalogue text about a platform it cannot reach. */
  const measuredChecks = readinessMode === "measured" ? tierGates.measured : [];
  const unevaluatedGates = readinessMode === "unscoreable" ? [] : tierGates.unevaluated;
  /* `null` means "we cannot score this", never "nothing is wrong".
   *
   * Scoring covers the gates the platform actually measured and nothing else. A
   * percentage over an empty set is the bug this guards: zero ready divided by
   * zero actionable printed "100%" and "0 blocking" — a clean bill of health for
   * a platform nobody had looked at. Both the config outage and a target tier
   * the platform has not evaluated land there, so both stay unscored.
   *
   * Measured gates that are all `not-required` are different: the platform did
   * look, and Tier 1 legitimately has almost nothing to satisfy. That is 100%. */
  const readiness = useMemo(() => {
    if (readinessMode !== "measured" || measuredChecks.length === 0) {
      return null;
    }
    const actionable = measuredChecks.filter((check) => check.status !== "not-required");
    const ready = actionable.filter((check) => check.status === "ready").length;
    return {
      /* `actionable.length === 0` here is NOT the empty-list bug this file was
         audited for: the guard above already returned null unless the platform
         measured at least one gate. Reaching this line means it looked and
         graded every gate `not_required`, which is genuinely 100% — nothing
         required, nothing blocking. The bug was scoring an unmeasured list. */
      percent: actionable.length === 0 ? 100 : Math.round((ready / actionable.length) * 100),
      blocking: measuredChecks.filter((check) => check.status === "blocked").length,
    };
  }, [measuredChecks, readinessMode]);
  const blockingChecks = useMemo(
    () => measuredChecks.filter((check) => check.status === "blocked"),
    [measuredChecks],
  );
  /* `readiness === null` is "we could not score this platform", and treating it
     as "nothing is blocking" is the same mistake the old 100%-for-no-data score
     made — so an unscored tier confirms too.
     Confirmation is what makes de-emphasising the button safe: the action stays
     reachable for the operator who legitimately stages a tier ahead of its
     gates, it just stops being the page's loudest control. */
  const applyNeedsConfirmation = readiness === null || blockingChecks.length > 0;
  const selectedTierTitle = titleForTier(selectedTierId);
  const currentTierTitle =
    backendStatus === undefined ? "Unavailable" : titleForTier(backendStatus.config.security.tier);
  /* One sentence for the third state, reused by the score's label, the note
     under Apply, and the confirmation's blast radius, so the operator reads the
     same explanation wherever they meet it. */
  const notEvaluatedReason = `${selectedTierTitle} is not the tier this platform runs (${currentTierTitle}), and readiness is only reported for the live tier`;
  const isLiveTierSelected =
    backendStatus !== undefined && backendStatus.config.security.tier === selectedTierId;
  /* One three-way state behind both the score's accessible name and its visible
     caption, so a screen reader and the page cannot end up describing different
     readiness states. */
  const scoreSummary =
    readiness !== null
      ? {
          label: `${readiness.percent}% readiness, ${readiness.blocking} blocking`,
          caption: `${readiness.blocking} blocking`,
        }
      : readinessMode === "not-evaluated"
        ? {
            label: `Readiness for ${selectedTierTitle} not evaluated — ${notEvaluatedReason}`,
            caption: "not evaluated",
          }
        : {
            label: "Readiness unknown — no live platform config",
            caption: "readiness unknown",
          };
  const readinessSummaryText = summariseReadiness({
    isPending: platformConfigQuery.isPending,
    backendStatus,
    readinessMode,
    readiness,
    selectedTierTitle,
  });
  const pluginCatalogColumns = useMemo<ColumnDef<PluginCatalogItem>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Plugin",
        cell: ({ row }) => (
          <>
            <strong>{row.original.name}</strong>
            <span>{row.original.id}</span>
          </>
        ),
      },
      {
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => formatValue(row.original.kind),
      },
      {
        accessorKey: "version",
        header: "Version",
      },
      {
        id: "permissions",
        header: "Permissions",
        cell: ({ row }) => row.original.permissions.scopes.length,
      },
      {
        id: "lifecycle",
        header: "Lifecycle",
        cell: ({ row }) => pluginLifecycleLabel(row.original),
      },
      {
        id: "review",
        header: "Action",
        cell: ({ row }) => {
          const plugin = row.original;
          const pendingPluginId = pluginLifecycleMutation.variables?.pluginId;
          const isPending = pluginLifecycleMutation.isPending && pendingPluginId === plugin.id;
          return (
            <div className="flex flex-wrap gap-2">
              <button
                className="helix-button helix-button-secondary"
                disabled={plugin.id === selectedPlugin?.id}
                onClick={() => setSelectedPluginId(plugin.id)}
                type="button"
              >
                {plugin.id === selectedPlugin?.id ? "Selected" : "Review"}
              </button>
              {canEnablePlugin(plugin) ? (
                <button
                  className="helix-button helix-button-secondary"
                  disabled={isPending}
                  onClick={() =>
                    pluginLifecycleMutation.mutate({ action: "enable", pluginId: plugin.id })
                  }
                  type="button"
                >
                  Enable
                </button>
              ) : null}
              {canDisablePlugin(plugin) ? (
                <button
                  className="helix-button helix-button-secondary"
                  disabled={isPending}
                  onClick={() =>
                    pluginLifecycleMutation.mutate({ action: "disable", pluginId: plugin.id })
                  }
                  type="button"
                >
                  Disable
                </button>
              ) : null}
              {canUninstallPlugin(plugin) ? (
                /* Opens the confirmation rather than firing the tool: uninstall
                   is irreversible and unloads live runtime hooks, and the
                   platform's own acknowledgements are collected from there. */
                <button
                  className="helix-button helix-button-secondary"
                  disabled={isPending}
                  onClick={() => startUninstall(plugin)}
                  type="button"
                >
                  Uninstall
                </button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [pluginLifecycleMutation, selectedPlugin?.id, startUninstall],
  );
  /* `useReactTable` wants a mutable `T[]`, and the query's array is readonly —
     hence the copy. The memo is load-bearing: `pluginCatalogQuery.data.plugins`
     keeps its identity between renders, and handing the table a fresh array
     every render re-renders it every render, which is a live render loop. */
  const pluginCatalogTableData = useMemo<PluginCatalogItem[]>(
    () => [...pluginCatalog],
    [pluginCatalog],
  );
  const pluginCatalogTable = useReactTable({
    columns: pluginCatalogColumns,
    data: pluginCatalogTableData,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  return (
    /* No `role="main"`: SurfaceFrame / PageScroll already own the page shell. */
    <section className="admin-tier-page grid gap-4">
      <PageHeading
        title="Tier readiness"
        subtitle="See the live security tier, pick a target, review gates that block it, and apply when ready. Plugin install lives on its own tab."
        meta={
          <div
            className="admin-tier-score"
            data-unknown={readiness === null ? "" : undefined}
            aria-label={scoreSummary.label}
          >
            <strong>{readiness === null ? "—" : `${readiness.percent}%`}</strong>
            <span>{scoreSummary.caption}</span>
          </div>
        }
      />
      <AdminSecurityRelatedNav current="tier-readiness" />

      <p className="admin-tier-live-status m-0 text-sm text-muted-foreground" role="status">
        {platformConfigQuery.isPending
          ? "Loading platform config"
          : backendStatus !== undefined
            ? `Live platform config connected · live tier ${currentTierTitle}`
            : "Admin config API unavailable or unauthorized"}
      </p>

      <div
        role="tablist"
        aria-label="Tier readiness views"
        className="mb-1 flex gap-0.5 border-b border-[var(--border)]"
        onKeyDown={moveTabSelection}
      >
        {TIER_PAGE_TABS.map((tab) => {
          const active = tab === activeTab;
          return (
            <button
              key={tab}
              id={`tier-tab-${tab}`}
              ref={(node) => {
                tabRefs.current[tab] = node;
              }}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`tier-panel-${tab}`}
              tabIndex={active ? 0 : -1}
              /* Arrow keys move focus programmatically, so the focused tab has
                 to show a ring even though `.tab` only styles hover/selection. */
              className={`tab focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)] ${active ? "active" : ""}`.trim()}
              onClick={() => setActiveTab(tab)}
            >
              {TIER_PAGE_TAB_LABELS[tab]}
            </button>
          );
        })}
      </div>

      {activeTab === "readiness" ? (
        <div
          id="tier-panel-readiness"
          role="tabpanel"
          aria-labelledby="tier-tab-readiness"
          className="grid gap-4"
        >
          <div className="admin-tier-selector" aria-label="Target security tier" role="group">
            {tiers.map((tier) => {
              const isSelected = tier.id === selectedTierId;
              const isLive = liveTier === tier.id;
              return (
                <button
                  className={isSelected ? "selected" : ""}
                  key={tier.id}
                  onClick={() => setSelectedTierId(tier.id)}
                  disabled={tierMutation.isPending}
                  type="button"
                  aria-pressed={isSelected}
                >
                  <span>{tier.shortName}</span>
                  <strong>{tier.title}</strong>
                  <small>{isLive ? "Live on this platform" : tier.target}</small>
                </button>
              );
            })}
          </div>

          {!isLiveTierSelected && backendStatus !== undefined ? (
            <StateBanner kind="info">
              You are reviewing <strong>{selectedTierTitle}</strong>. The platform is running{" "}
              <strong>{currentTierTitle}</strong>, so gates below are catalogue requirements — not
              live measurements — until you apply this tier.
            </StateBanner>
          ) : null}

          <div className="admin-tier-grid">
            <section
              className="admin-tier-panel admin-tier-readiness"
              aria-labelledby="readiness-title"
            >
              <div className="admin-tier-panel-header">
                <div>
                  <p className="admin-tier-kicker">Gates</p>
                  <h2 id="readiness-title">
                    {selectedTier.shortName}: {selectedTier.title}
                  </h2>
                  <p>{selectedTier.serviceSummary}</p>
                </div>
                {readiness === null ? null : (
                  <div className="admin-tier-progress" aria-hidden="true">
                    <span style={{ width: `${readiness.percent}%` }} />
                  </div>
                )}
              </div>

              <div className="admin-check-list">
                {readinessMode === "unscoreable" ? (
                  <p>
                    Readiness gates are unavailable until the admin config API returns a valid
                    response.
                  </p>
                ) : null}
                {measuredChecks.map((check) => (
                  <article className="admin-check-row" data-status={check.status} key={check.id}>
                    <StatusIcon status={check.status} />
                    <div>
                      <h3>{check.title}</h3>
                      {check.detail.length > 0 ? <p>{check.detail}</p> : null}
                      <RequirementFacts check={check} />
                    </div>
                    <span>{statusText[check.status]}</span>
                  </article>
                ))}
                {unevaluatedGates.length === 0 ? null : (
                  <div
                    aria-label={`Gates not evaluated for ${selectedTierTitle}`}
                    className="admin-check-list"
                    role="group"
                  >
                    <p>
                      {readinessMode === "not-evaluated"
                        ? `${notEvaluatedReason}. These are the gates ${selectedTierTitle} requires, from this console's tier catalogue — not measurements of this deployment.`
                        : `The platform reported no result for these gates, so nothing here has evaluated them.`}
                    </p>
                    {unevaluatedGates.map((gate) => (
                      <article className="admin-check-row" data-status="unknown" key={gate.id}>
                        <CircleDashed aria-hidden="true" size={20} />
                        <div>
                          <h3>{gate.title}</h3>
                          {gate.detail.length > 0 ? <p>{gate.detail}</p> : null}
                        </div>
                        <span>
                          {gate.requiredByTier ? "Not evaluated" : "Not required at this tier"}
                        </span>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <aside className="admin-tier-panel admin-tier-summary" aria-labelledby="summary-title">
              <p className="admin-tier-kicker">Apply</p>
              <h2 id="summary-title">{currentTierTitle} platform state</h2>
              <dl>
                <div>
                  <dt>Selected tier</dt>
                  <dd>{selectedTierTitle}</dd>
                </div>
                <div>
                  <dt>Live tier</dt>
                  <dd>{currentTierTitle}</dd>
                </div>
                <div>
                  <dt>Readiness</dt>
                  <dd>{readinessSummaryText}</dd>
                </div>
                <div>
                  <dt>Backend requirements</dt>
                  <dd>
                    {platformConfigQuery.isPending
                      ? "Loading"
                      : backendStatus === undefined
                        ? "Unavailable"
                        : measuredRequirements === undefined
                          ? `Live gates only for ${currentTierTitle}`
                          : `${measuredRequirements.length} live gates`}
                  </dd>
                </div>
              </dl>
              <p className="admin-tier-live-status-row" role="status">
                {platformConfigQuery.isPending ? (
                  <CircleDashed aria-hidden="true" size={16} />
                ) : (
                  <ShieldCheck aria-hidden="true" size={16} />
                )}
                {platformConfigQuery.isPending
                  ? "Loading config API"
                  : backendStatus !== undefined
                    ? "Config API connected"
                    : "Config API unavailable"}
              </p>
              <button
                aria-describedby={applyNeedsConfirmation ? "apply-tier-note" : undefined}
                className={
                  applyNeedsConfirmation ? "helix-button helix-button-secondary" : "helix-button"
                }
                disabled={tierMutation.isPending || backendStatus === undefined}
                onClick={() => {
                  if (applyNeedsConfirmation) {
                    setTierConfirmOpen(true);
                    return;
                  }
                  tierMutation.mutate(selectedTierId);
                }}
                type="button"
              >
                Apply tier draft
              </button>
              {applyNeedsConfirmation ? (
                <p className="admin-tier-apply-note" id="apply-tier-note">
                  {readiness !== null
                    ? `${blockingSummary(blockingChecks.length, selectedTierTitle)}. Applying it asks you to confirm first.`
                    : readinessMode === "not-evaluated"
                      ? `${selectedTierTitle} has not been evaluated on this platform — it reports gates only for ${currentTierTitle}. Applying it asks you to confirm first.`
                      : `Readiness for ${selectedTierTitle} could not be scored. Applying it asks you to confirm first.`}
                </p>
              ) : null}
              <ConfirmDestructive
                open={tierConfirmOpen}
                onOpenChange={setTierConfirmOpen}
                title={`Apply ${selectedTierTitle} tier`}
                blastRadius={
                  blockingChecks.length > 0
                    ? `${blockingSummary(blockingChecks.length, selectedTierTitle)}: ${blockingChecks
                        .map((check) => check.title)
                        .join(", ")}. Applying the tier does not clear them.`
                    : readinessMode === "not-evaluated"
                      ? `Nothing has evaluated this platform against ${selectedTierTitle}: ${notEvaluatedReason}. The ${String(unevaluatedGates.length)} gates listed are what the tier requires, not what was measured here.`
                      : `Readiness for ${selectedTierTitle} could not be scored — the admin config API returned no usable gate data, so nothing has verified that this platform meets the tier.`
                }
                confirmLabel={`Apply ${selectedTierTitle}`}
                isPending={tierMutation.isPending}
                onConfirm={() => tierMutation.mutate(selectedTierId)}
              >
                Sets this deployment&apos;s security tier to {selectedTierTitle}. The configuration
                is applied whether or not the platform currently satisfies the tier&apos;s readiness
                gates.
              </ConfirmDestructive>
              {tierMutation.isError ? <p role="alert">Could not apply the tier draft.</p> : null}
              {platformConfigQuery.isError ? (
                <p role="alert">
                  {platformConfigQuery.error instanceof Error
                    ? platformConfigQuery.error.message
                    : "Admin config API is unavailable or missing admin config scope."}
                </p>
              ) : null}
            </aside>
          </div>

          <section className="admin-tier-panel" aria-labelledby="services-title">
            <div className="admin-tier-panel-header">
              <div>
                <p className="admin-tier-kicker">Services</p>
                <h2 id="services-title">Runtime dependencies for {selectedTier.title}</h2>
                <p>
                  {platformConfigQuery.isPending
                    ? "Loading platform config."
                    : readinessMode === "unscoreable"
                      ? "Connect the admin config API to see backend-managed service health."
                      : readinessMode === "not-evaluated"
                        ? `No service here has been checked against ${selectedTier.title}: gates are reported only for the live tier (${currentTierTitle}).`
                        : "Live readiness gates are reflected for backend-managed services only. Cards without a live gate stay “Not verified”."}
                </p>
              </div>
            </div>
            <div className="admin-service-grid">
              {requiredServiceList.length === 0 ? (
                <p>
                  Service gates are unavailable until the admin config API returns a valid response.
                </p>
              ) : (
                requiredServiceList.map((service) => (
                  <article
                    className="admin-service-card"
                    data-status={service.backendStatus === undefined ? "unknown" : service.status}
                    key={service.id}
                  >
                    <service.icon aria-hidden="true" size={20} />
                    <div>
                      <h3>{service.name}</h3>
                      <p>{service.description}</p>
                    </div>
                    <span>
                      {service.backendStatus === undefined
                        ? "Not verified"
                        : backendStatusText(service.backendStatus)}
                    </span>
                  </article>
                ))
              )}
            </div>
          </section>
        </div>
      ) : (
        <div
          id="tier-panel-plugins"
          role="tabpanel"
          aria-labelledby="tier-tab-plugins"
          className="admin-tier-panel"
        >
          <div className="admin-tier-panel-header">
            <div>
              <p className="admin-tier-kicker">Plugins</p>
              <h2 id="plugins-title">Catalog and install</h2>
              <p>
                Review permissions, install from official or non-official sources, and manage enable
                / disable / uninstall. This is separate from security tier gates.
              </p>
            </div>
          </div>
          <div className="admin-plugin-panel">
            <div className="admin-plugin-picker">
              <label>
                <span>Plugin</span>
                <select
                  aria-label="Plugin to install"
                  disabled={pluginCatalog.length === 0}
                  onChange={(event) => setSelectedPluginId(event.target.value)}
                  value={selectedPlugin?.id ?? ""}
                >
                  {pluginCatalog.map((plugin) => (
                    <option key={plugin.id} value={plugin.id}>
                      {plugin.name} {plugin.version}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Source</span>
                <select
                  aria-label="Plugin source"
                  onChange={(event) => setPluginSource(event.target.value as PluginSource)}
                  value={pluginSource}
                >
                  <option value="official">Official Helix registry</option>
                  <option value="sideload">Sideloaded bundle</option>
                  <option value="self-hosted">Self-hosted registry</option>
                </select>
              </label>
            </div>

            {pluginCatalogQuery.isError ? (
              <p role="alert">Plugin catalog is unavailable or missing admin plugin scope.</p>
            ) : null}
            {pluginCatalog.length === 0 ? null : (
              <Table
                aria-label="Plugin catalog"
                className="admin-tier-table admin-plugin-table"
                role="table"
              >
                <TableHeader>
                  {pluginCatalogTable.getHeaderGroups().map((headerGroup) => (
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
                  {pluginCatalogTable.getRowModel().rows.map((row) => (
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
            )}
            {selectedPlugin === undefined ? (
              <p>No installable plugins were returned by the backend catalog.</p>
            ) : (
              <article className="admin-plugin-card">
                <header>
                  <div>
                    <h3>{selectedPlugin.name}</h3>
                    <p>
                      {selectedPlugin.id} · {selectedPlugin.kind} · {selectedPlugin.version}
                    </p>
                  </div>
                  <span>{pluginConfirmations.length} confirmations</span>
                </header>
                <PluginManifestFacts plugin={selectedPlugin} />
                <div className="admin-plugin-confirmations">
                  {pluginConfirmations.length === 0 ? (
                    <p>Official installs do not require additional source confirmations.</p>
                  ) : (
                    pluginConfirmations.map((confirmation) => (
                      <label key={confirmation.id}>
                        <input
                          checked={confirmedPluginIds.has(confirmation.id)}
                          onChange={() =>
                            setConfirmedPluginRequirements((current) =>
                              toggleId(current, confirmation.id),
                            )
                          }
                          type="checkbox"
                        />
                        <span>
                          <strong>{confirmation.label}</strong>
                          {confirmation.detail}
                        </span>
                      </label>
                    ))
                  )}
                </div>
                <button
                  className="helix-button"
                  disabled={pluginInstallMutation.isPending || !allPluginConfirmationsAccepted}
                  onClick={() =>
                    pluginInstallMutation.mutate({
                      pluginId: selectedPlugin.id,
                      version: selectedPlugin.version,
                      source: pluginSource,
                      confirmations: confirmedPluginRequirements,
                    })
                  }
                  type="button"
                >
                  {pluginInstallMutation.isPending ? (
                    <CircleDashed aria-hidden="true" size={16} />
                  ) : (
                    <ShieldCheck aria-hidden="true" size={16} />
                  )}
                  Install plugin
                </button>
                {pluginInstallMutation.isError ? (
                  <p role="alert">Could not validate the plugin install request.</p>
                ) : null}
                {pluginInstallStatus === null ? null : (
                  <p role="status">{pluginInstallStatusMessage(pluginInstallStatus)}</p>
                )}
                {pluginLifecycleMutation.isError ? (
                  <p role="alert">Could not update the plugin lifecycle state.</p>
                ) : null}
                {pluginLifecycleStatus === null ? null : (
                  <p role="status">{pluginLifecycleStatusMessage(pluginLifecycleStatus)}</p>
                )}
              </article>
            )}

            {uninstallPlugin === undefined ? null : (
              <>
                {uninstallRequirements.length === 0 ? null : (
                  <article className="admin-plugin-card" data-status="warning">
                    <AlertTriangle aria-hidden="true" size={20} />
                    <div>
                      <h3>Uninstall {uninstallPlugin.name}</h3>
                      <p>
                        The platform refused the uninstall and listed{" "}
                        {requirementCount(uninstallRequirements.length)} it requires. Nothing is
                        sent back that you have not ticked.
                      </p>
                      <div className="admin-plugin-confirmations">
                        {uninstallRequirements.map((requirement) => (
                          <label key={requirement.id}>
                            <input
                              checked={acknowledgedUninstallSet.has(requirement.id)}
                              onChange={() =>
                                setAcknowledgedUninstallIds((current) =>
                                  toggleId(current, requirement.id),
                                )
                              }
                              type="checkbox"
                            />
                            <span>
                              <strong>{requirement.label}</strong>
                              {requirement.detail}
                            </span>
                          </label>
                        ))}
                      </div>
                      <Button
                        aria-describedby={
                          outstandingUninstallRequirements.length === 0
                            ? undefined
                            : "uninstall-acknowledgement-note"
                        }
                        disabled={
                          pluginLifecycleMutation.isPending ||
                          outstandingUninstallRequirements.length > 0
                        }
                        onClick={() => setUninstallConfirmOpen(true)}
                        size="sm"
                        type="button"
                        variant="destructive"
                      >
                        Uninstall {uninstallPlugin.name}
                      </Button>
                      {outstandingUninstallRequirements.length === 0 ? null : (
                        <p className="admin-tier-apply-note" id="uninstall-acknowledgement-note">
                          Tick every requirement the platform listed — it refuses the uninstall
                          until all {String(uninstallRequirements.length)} come back acknowledged.
                        </p>
                      )}
                    </div>
                  </article>
                )}
                <ConfirmDestructive
                  open={uninstallConfirmOpen}
                  onOpenChange={setUninstallConfirmOpen}
                  title={`Uninstall ${uninstallPlugin.name}`}
                  blastRadius={uninstallBlastRadius(
                    uninstallPlugin,
                    uninstallRequirements,
                    outstandingUninstallRequirements,
                  )}
                  confirmLabel={`Uninstall ${uninstallPlugin.name}`}
                  isPending={pluginLifecycleMutation.isPending}
                  onConfirm={() =>
                    pluginLifecycleMutation.mutate({
                      action: "uninstall",
                      pluginId: uninstallPlugin.id,
                      confirmations: acknowledgedUninstallIds,
                    })
                  }
                >
                  Removes {uninstallPlugin.id} {uninstallPlugin.version} from this deployment.
                  Installing it again is a fresh install with its own permission confirmations.
                </ConfirmDestructive>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** The summary panel's Readiness line. The three unscored states each get their
 *  own sentence: "Backend unavailable" is not the same as a live platform that
 *  simply has not measured the tier the operator picked, and neither is a tier
 *  the platform measured but reported no gates for. */
function summariseReadiness({
  isPending,
  backendStatus,
  readinessMode,
  readiness,
  selectedTierTitle,
}: {
  readonly isPending: boolean;
  readonly backendStatus: PlatformConfigStatus | undefined;
  readonly readinessMode: "measured" | "not-evaluated" | "unscoreable";
  readonly readiness: { readonly percent: number; readonly blocking: number } | null;
  readonly selectedTierTitle: string;
}): string {
  if (isPending) {
    return "Loading";
  }
  if (backendStatus === undefined || readinessMode === "unscoreable") {
    return "Backend unavailable";
  }
  if (readinessMode === "not-evaluated") {
    return `Not evaluated for ${selectedTierTitle}`;
  }
  if (readiness === null) {
    return "No gates reported";
  }
  return backendStatus.readiness.ready ? "Ready" : `${readiness.blocking} blocking`;
}

/** "1 acknowledgement" / "3 acknowledgements". */
function requirementCount(count: number): string {
  return count === 1 ? "1 acknowledgement" : `${String(count)} acknowledgements`;
}

/** What the operator loses, from the manifest — never a generic "cannot be
 *  undone" — plus where the platform's own confirmation gate currently stands. */
function uninstallBlastRadius(
  plugin: PluginCatalogItem,
  requirements: readonly PluginConfirmation[],
  outstanding: readonly PluginConfirmation[],
): string {
  const provides = plugin.capabilities.provides;
  const consequence =
    provides.length === 0
      ? `Unloads ${plugin.id}'s active runtime hooks; anything relying on this plugin stops until it is installed again.`
      : `Unloads ${plugin.id}'s active runtime hooks, so ${formatList(provides)} stop being served to whatever consumes them.`;
  if (requirements.length === 0) {
    return `${consequence} The platform states the acknowledgements it requires before removing a plugin; this request asks it for them.`;
  }
  if (outstanding.length > 0) {
    return `${consequence} The platform still requires ${outstanding
      .map((requirement) => requirement.label)
      .join(
        ", ",
      )} and refuses the uninstall until ${outstanding.length === 1 ? "it is" : "they are"} acknowledged.`;
  }
  return `${consequence} Sends the ${requirementCount(requirements.length)} the platform required: ${requirements
    .map((requirement) => requirement.label)
    .join(", ")}.`;
}

/** Union by id, keeping what is already on screen first: the backend replies
 *  with only the still-missing requirements, so a plain replace would erase the
 *  ones the operator has already read and ticked. */
function mergeConfirmations(
  current: readonly PluginConfirmation[],
  incoming: readonly PluginConfirmation[],
): readonly PluginConfirmation[] {
  const known = new Set(current.map((confirmation) => confirmation.id));
  return [...current, ...incoming.filter((confirmation) => !known.has(confirmation.id))];
}
/** "2 readiness gates block Enterprise" — the count and the tier in one clause,
 *  reused by the button's caption and the confirmation's blast radius so the
 *  operator reads the same sentence in both places. */
function blockingSummary(count: number, tierTitle: string): string {
  return count === 1
    ? `1 readiness gate blocks ${tierTitle}`
    : `${String(count)} readiness gates block ${tierTitle}`;
}

function PluginManifestFacts({ plugin }: { readonly plugin: PluginCatalogItem }) {
  return (
    <dl className="admin-plugin-facts">
      <div>
        <dt>Scopes</dt>
        <dd>{formatList(plugin.permissions.scopes)}</dd>
      </div>
      <div>
        <dt>Outbound network</dt>
        <dd>{formatList(plugin.permissions["outbound-network"])}</dd>
      </div>
      <div>
        <dt>Provides</dt>
        <dd>{formatList(plugin.capabilities.provides)}</dd>
      </div>
      <div>
        <dt>Consumes</dt>
        <dd>{formatList(plugin.capabilities.consumes)}</dd>
      </div>
    </dl>
  );
}

function StatusIcon({ status }: { readonly status: CheckStatus }) {
  if (status === "ready") {
    return <CheckCircle2 aria-hidden="true" size={20} />;
  }

  if (status === "blocked") {
    return <AlertTriangle aria-hidden="true" size={20} />;
  }

  return <CircleDashed aria-hidden="true" size={20} />;
}

function RequirementFacts({ check }: { readonly check: RenderedReadinessCheck }) {
  if (
    check.expectedFields === undefined &&
    check.observedFields === undefined &&
    check.missing === undefined
  ) {
    return null;
  }

  return (
    <div className="admin-requirement-facts">
      <RequirementFactGroup title="Expected" fields={check.expectedFields} />
      <RequirementFactGroup title="Observed" fields={check.observedFields} />
      {check.missing === undefined ? null : (
        <div className="admin-requirement-fact-group">
          <span>Missing</span>
          <ul>
            {check.missing.map((item) => (
              <li key={item}>{formatValue(item)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RequirementFactGroup({
  title,
  fields,
}: {
  readonly title: string;
  readonly fields: readonly RequirementField[] | undefined;
}) {
  if (fields === undefined || fields.length === 0) {
    return null;
  }

  return (
    <div className="admin-requirement-fact-group">
      <span>{title}</span>
      <dl>
        {fields.map((field) => (
          <div key={field.label}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
