import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleSlash, LayoutGrid } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  coreAppsAdminQueryOptions,
  coreAppsQueryKeys,
  setCoreAppEnabled,
  type CoreAppAdminEntry,
  type CoreAppId,
} from "./core-apps-api";

interface CoreAppsRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof coreAppsAdminQueryOptions>): Promise<unknown>;
}

export async function prefetchAdminCoreAppsQuery(queryClient: CoreAppsRouteQueryClient) {
  await queryClient.ensureQueryData(coreAppsAdminQueryOptions()).catch(() => undefined);
}

/**
 * Admin UI to view and toggle core-app enablement org-wide.
 *
 * Core apps (mail, chat, drive, ...) are toggleable platform modules. Disabling
 * one stops the platform from registering or serving it. The change is saved to
 * platform config and takes effect on the next deploy/restart, since modules
 * are wired at startup.
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

  const apps = statusQuery.data?.apps ?? [];
  const role = statusQuery.data?.role ?? "all";

  return (
    <div className="grid gap-3" aria-labelledby="core-apps-title">
      <header className="flex items-start gap-2">
        <LayoutGrid aria-hidden="true" className="mt-0.5 size-4 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-medium" id="core-apps-title">
            Core apps
          </h3>
          <p className="text-xs text-muted-foreground">
            Enable or disable platform apps for the whole organization. This deployment boots
            with the <code>{role}</code> role.
          </p>
        </div>
      </header>

      {error !== null ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {statusQuery.isError ? (
        <p className="text-xs text-muted-foreground" role="status">
          Core-app settings are unavailable. You may not have admin access.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">App</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Served here</TableHead>
              <TableHead scope="col">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps.map((app) => (
              <CoreAppRow
                key={app.id}
                app={app}
                pendingRestart={pendingRestart.has(app.id)}
                busy={toggleMutation.isPending}
                onToggle={(enabled) => {
                  toggleMutation.mutate({ appId: app.id, enabled });
                }}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function CoreAppRow({
  app,
  busy,
  pendingRestart,
  onToggle,
}: {
  readonly app: CoreAppAdminEntry;
  readonly busy: boolean;
  readonly pendingRestart: boolean;
  readonly onToggle: (enabled: boolean) => void;
}) {
  const servedLabel = app.registered
    ? "Yes"
    : app.inRole
      ? "No (disabled)"
      : "No (role)";
  return (
    <TableRow>
      <TableCell>
        <div className="grid gap-0.5">
          <strong className="text-sm">{app.name}</strong>
          <span className="text-xs text-muted-foreground">{app.description}</span>
        </div>
      </TableCell>
      <TableCell>
        {app.enabled ? (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
            <CheckCircle2 aria-hidden="true" size={15} /> Enabled
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <CircleSlash aria-hidden="true" size={15} /> Disabled
          </span>
        )}
        {pendingRestart ? (
          <span className="text-xs text-muted-foreground"> · pending restart</span>
        ) : null}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{servedLabel}</TableCell>
      <TableCell>
        <Button
          type="button"
          variant={app.enabled ? "outline" : "default"}
          size="sm"
          disabled={busy}
          aria-label={`${app.enabled ? "Disable" : "Enable"} ${app.name}`}
          onClick={() => {
            onToggle(!app.enabled);
          }}
        >
          {app.enabled ? "Disable" : "Enable"}
        </Button>
      </TableCell>
    </TableRow>
  );
}
