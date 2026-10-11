import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  Cloud,
  Mail,
  MessageCircle,
  Sparkles,
  Video,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  coreAppsAdminQueryOptions,
  coreAppsQueryKeys,
  setCoreAppEnabled,
  type CoreAppAdminEntry,
  type CoreAppId,
} from "./core-apps-api";
import { APPS } from "@/components/apps";
import { APP_DISABLE_CONSEQUENCE } from "@/features/admin/console/app-settings";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import {
  ErrorNotice,
  LoadingState,
  PageHeading,
  QueryFailureBanner,
} from "@/features/admin/console/primitives";
import { Switch } from "@/features/admin/console/widgets";
interface CoreAppsRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof coreAppsAdminQueryOptions>): Promise<unknown>;
}
export async function prefetchAdminCoreAppsQuery(queryClient: CoreAppsRouteQueryClient) {
  await queryClient.ensureQueryData(coreAppsAdminQueryOptions()).catch(() => undefined);
}
const APP_ICON: Readonly<Record<CoreAppId, LucideIcon>> = {
  mail: Mail,
  chat: MessageCircle,
  drive: Cloud,
  calendar: Calendar,
  meet: Video,
  assistant: Sparkles,
};
const APP_ICON_BG: Readonly<Record<CoreAppId, string>> = {
  mail: "bg-red-500/15 text-red-400",
  chat: "bg-pink-500/15 text-pink-400",
  drive: "bg-violet-500/15 text-violet-400",
  calendar: "bg-orange-500/15 text-orange-400",
  meet: "bg-cyan-500/15 text-cyan-400",
  assistant: "bg-fuchsia-500/15 text-fuchsia-400",
};
/**
 * Admin UI to view and toggle core-app enablement org-wide.
 *
 * Disabling an app removes it from the launcher, rail, and search for every
 * user in the org. Some apps require a restart to fully unregister; the row
 * surfaces a "pending restart" badge until the next deploy cycles the module.
 *
 * The two directions of the switch are not the same action. Enabling is
 * additive and stays one click — confirming it would only teach operators to
 * click through dialogs. Disabling is the console's irreversible/many-affected
 * tier (one toggle, every user in the org), so it confirms with the app named
 * and a blast radius saying what stops working.
 */
export function CoreAppsManagement() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pendingRestart, setPendingRestart] = useState<ReadonlySet<CoreAppId>>(new Set());
  const [disableTargetId, setDisableTargetId] = useState<CoreAppId | null>(null);
  const statusQuery = useQuery(coreAppsAdminQueryOptions());
  const toggleMutation = useMutation({
    mutationFn: (input: { readonly appId: CoreAppId; readonly enabled: boolean }) =>
      setCoreAppEnabled(input.appId, input.enabled),
    onMutate: () => {
      setError(null);
    },
    onError: (mutationError: unknown) => {
      setError(mutationError instanceof Error ? mutationError.message : "Failed to update app.");
    },
    onSuccess: async (result) => {
      if (result.changed.requiresRestart) {
        setPendingRestart((current) => new Set(current).add(result.changed.appId));
      }
      await queryClient.invalidateQueries({ queryKey: coreAppsQueryKeys.admin() });
      await queryClient.invalidateQueries({ queryKey: coreAppsQueryKeys.shell() });
    },
    onSettled: () => {
      // Closes on failure too: the error banner lives on the page behind the
      // dialog, so leaving it open would hide the reason nothing happened.
      setDisableTargetId(null);
    },
  });
  const apps = useMemo(() => {
    const configuredApps = statusQuery.data?.apps ?? [];
    return configuredApps.filter((app) => APPS.some((workspaceApp) => workspaceApp.id === app.id));
  }, [statusQuery.data?.apps]);
  const enabledCount = useMemo(() => apps.filter((a) => a.enabled).length, [apps]);
  /* Derived from the live list rather than held as a snapshot: if a refetch
       drops the app, the dialog must not keep offering to disable something that
       is no longer there. */
  const disableTarget = apps.find((app) => app.id === disableTargetId) ?? null;
  return (
    <section className="grid gap-5">
      {/* Uses the console's shared PageHeading so this section's title is an
              h1 like every other `/admin/<section>` page — it rendered an h2 here
              and an h3 in tenant settings purely by accident of authorship. */}
      <PageHeading
        title="All apps"
        subtitle="Turn apps on or off for everyone in your organization."
        meta={
          apps.length > 0 ? (
            <span className="ml-auto shrink-0 text-sm text-[var(--text-2)]">
              <span className="font-medium text-[var(--text)]">{enabledCount}</span>
              <span className="text-[var(--text-3)]"> of {apps.length} enabled</span>
            </span>
          ) : undefined
        }
      />

      {error !== null ? <ErrorNotice>{error}</ErrorNotice> : null}

      {statusQuery.isError ? (
        <QueryFailureBanner
          summary="App settings couldn't be loaded"
          subject="app settings"
          error={statusQuery.error}
          isRetrying={statusQuery.isFetching}
          onRetry={() => {
            void queryClient.invalidateQueries({ queryKey: coreAppsQueryKeys.admin() });
          }}
        />
      ) : statusQuery.isLoading ? (
        <LoadingState label="Loading apps" variant="row" count={6} />
      ) : (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
          {apps.map((app, idx) => (
            <CoreAppRow
              key={app.id}
              app={app}
              divider={idx > 0}
              pendingRestart={pendingRestart.has(app.id)}
              busy={toggleMutation.isPending}
              onToggle={(enabled) => {
                if (enabled) {
                  toggleMutation.mutate({ appId: app.id, enabled: true });
                  return;
                }
                setDisableTargetId(app.id);
              }}
            />
          ))}
        </div>
      )}

      {disableTarget === null ? null : (
        <ConfirmDestructive
          open
          onOpenChange={(next) => {
            if (!next) {
              setDisableTargetId(null);
            }
          }}
          title={`Disable ${disableTarget.name}`}
          blastRadius={APP_DISABLE_CONSEQUENCE[disableTarget.id]}
          confirmLabel={`Disable ${disableTarget.name}`}
          isPending={toggleMutation.isPending}
          onConfirm={() => {
            toggleMutation.mutate({ appId: disableTarget.id, enabled: false });
          }}
        >
          Turns {disableTarget.name} off for everyone in your organization, not just you. It
          disappears from the launcher, rail, and search until an admin turns it back on.
        </ConfirmDestructive>
      )}
    </section>
  );
}
function CoreAppRow({
  app,
  busy,
  divider,
  pendingRestart,
  onToggle,
}: {
  readonly app: CoreAppAdminEntry;
  readonly busy: boolean;
  readonly divider: boolean;
  readonly pendingRestart: boolean;
  readonly onToggle: (enabled: boolean) => void;
}) {
  const Icon = APP_ICON[app.id];
  return (
    <div
      className={`flex items-center gap-4 px-5 py-4 ${divider ? "border-t border-[var(--border)]" : ""}`}
    >
      <div
        className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${APP_ICON_BG[app.id]}`}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-[var(--text)]">{app.name}</span>

          {/* No Enabled/Disabled pill: the switch on this row already reports
          that state, and two readouts for one value invite the reader to
          wonder which is authoritative. State the switch can't convey —
          pending restart, not served by this role — still gets a badge. */}
          {pendingRestart ? <Pill background="bg-amber-500/15">Pending restart</Pill> : null}
          {!app.inRole ? (
            <span className="type-chip font-semibold uppercase tracking-wide text-[var(--text-3)]">
              Not served by this role
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-sm text-[var(--text-3)]">{app.description}</p>
      </div>
      <Switch
        checked={app.enabled}
        disabled={busy}
        label={`${app.name} on for everyone`}
        onCheckedChange={onToggle}
      />
    </div>
  );
}
/* One badge shape for the row's amber annotations — they differ only in wording
   and in how loud the fill is, so a second copy of the class list would drift. */
function Pill({
  background,
  children,
}: {
  readonly background: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded type-chip font-semibold uppercase tracking-wide ${background} text-amber-400`}
    >
      {children}
    </span>
  );
}
