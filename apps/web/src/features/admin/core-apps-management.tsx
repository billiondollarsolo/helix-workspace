import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  Cloud,
  FileText,
  Mail,
  MessageCircle,
  Pencil,
  Sparkles,
  Video,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  coreAppsAdminQueryOptions,
  coreAppsQueryKeys,
  setCoreAppEnabled,
  type CoreAppAdminEntry,
  type CoreAppId,
} from "./core-apps-api";
import { APPS, CORE_WORKSPACE_STORAGE_ONLY } from "@/components/apps";

interface CoreAppsRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof coreAppsAdminQueryOptions>): Promise<unknown>;
}

export async function prefetchAdminCoreAppsQuery(queryClient: CoreAppsRouteQueryClient) {
  await queryClient.ensureQueryData(coreAppsAdminQueryOptions()).catch(() => undefined);
}

const APP_ICON_BG: Readonly<Record<CoreAppId, string>> = {
  mail: "bg-red-500/15 text-red-400",
  chat: "bg-pink-500/15 text-pink-400",
  drive: "bg-violet-500/15 text-violet-400",
  docs: "bg-blue-500/15 text-blue-400",
  calendar: "bg-orange-500/15 text-orange-400",
  meet: "bg-cyan-500/15 text-cyan-400",
  assistant: "bg-fuchsia-500/15 text-fuchsia-400",
  editors: "bg-slate-500/15 text-slate-400",
};

function AppIcon({ id }: { readonly id: CoreAppId }) {
  const cls = "h-5 w-5";
  switch (id) {
    case "mail":
      return <Mail className={cls} />;
    case "chat":
      return <MessageCircle className={cls} />;
    case "drive":
      return <Cloud className={cls} />;
    case "docs":
      return <FileText className={cls} />;
    case "calendar":
      return <Calendar className={cls} />;
    case "meet":
      return <Video className={cls} />;
    case "assistant":
      return <Sparkles className={cls} />;
    case "editors":
      return <Pencil className={cls} />;
  }
}

/**
 * Admin UI to view and toggle core-app enablement org-wide.
 *
 * Disabling an app removes it from the launcher, rail, and search for every
 * user in the org. Some apps require a restart to fully unregister; the row
 * surfaces a "pending restart" badge until the next deploy cycles the module.
 */
export function CoreAppsManagement() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pendingRestart, setPendingRestart] = useState<ReadonlySet<CoreAppId>>(new Set());
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
  });

  const apps = useMemo(() => {
    const configuredApps = statusQuery.data?.apps ?? [];
    return CORE_WORKSPACE_STORAGE_ONLY
      ? configuredApps.filter((app) => APPS.some((workspaceApp) => workspaceApp.id === app.id))
      : configuredApps;
  }, [statusQuery.data?.apps]);
  const role = statusQuery.data?.role ?? "all";
  const enabledCount = useMemo(() => apps.filter((a) => a.enabled).length, [apps]);

  return (
    <section className="grid gap-5" aria-labelledby="core-apps-title">
      <header className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <h2 id="core-apps-title" className="text-lg font-semibold text-[var(--text)]">
            Core apps
          </h2>
          <p className="mt-1 text-sm text-[var(--text-2)] max-w-2xl">
            Turn workspace apps on or off for everyone in your organization. Disabled apps disappear
            from the launcher, rail, and search. This deployment boots with the{" "}
            <code className="text-[var(--text-2)] bg-[var(--surface-2)] px-1 py-0.5 rounded text-xs">
              {role}
            </code>{" "}
            role.
          </p>
        </div>
        {apps.length > 0 ? (
          <div className="text-sm text-[var(--text-2)] shrink-0">
            <span className="font-medium text-[var(--text)]">{enabledCount}</span>
            <span className="text-[var(--text-3)]"> of {apps.length} enabled</span>
          </div>
        ) : null}
      </header>

      {error !== null ? (
        <div
          role="alert"
          className="text-sm text-[var(--danger)] bg-[var(--danger-soft,rgba(239,68,68,0.1))] border border-[var(--danger)]/30 rounded-md px-3 py-2"
        >
          {error}
        </div>
      ) : null}

      {statusQuery.isError ? (
        <p className="text-sm text-[var(--text-2)]" role="status">
          Core-app settings are unavailable. You may not have admin access.
        </p>
      ) : statusQuery.isLoading ? (
        <p className="text-sm text-[var(--text-3)]" role="status">
          Loading core apps…
        </p>
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
                toggleMutation.mutate({ appId: app.id, enabled });
              }}
            />
          ))}
        </div>
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
  return (
    <div
      className={`flex items-center gap-4 px-5 py-4 ${divider ? "border-t border-[var(--border)]" : ""}`}
    >
      <div
        className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${APP_ICON_BG[app.id]}`}
      >
        <AppIcon id={app.id} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-[var(--text)]">{app.name}</span>
          {app.id === "editors" ? <AlphaPill /> : null}
          <StatusPill enabled={app.enabled} />
          {pendingRestart ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-500/15 text-amber-400">
              Pending restart
            </span>
          ) : null}
          {!app.inRole ? (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
              Not served by this role
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-sm text-[var(--text-3)]">
          {app.id === "editors"
            ? "Alpha native Docs, Sheets, Slides, and PDF editing. Disable to keep Drive storage, previews, download, and sharing without editable copies."
            : app.description}
        </p>
      </div>
      <AppToggle
        enabled={app.enabled}
        busy={busy}
        ariaLabel={`${app.enabled ? "Disable" : "Enable"} ${app.name}`}
        onChange={onToggle}
      />
    </div>
  );
}

function AlphaPill() {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-500/10 text-amber-400">
      Alpha
    </span>
  );
}

function StatusPill({ enabled }: { readonly enabled: boolean }) {
  if (enabled) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-emerald-500/10 text-emerald-400">
        <span className="w-1.5 h-1.5 rounded-full bg-current" /> Enabled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-[var(--surface-2)] text-[var(--text-3)]">
      <span className="w-1.5 h-1.5 rounded-full bg-current" /> Disabled
    </span>
  );
}

function AppToggle({
  enabled,
  busy,
  ariaLabel,
  onChange,
}: {
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly ariaLabel: string;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={ariaLabel}
      disabled={busy}
      onClick={() => {
        onChange(!enabled);
      }}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        enabled ? "bg-[var(--accent)]" : "bg-[var(--surface-2)] border border-[var(--border)]"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
          enabled ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
