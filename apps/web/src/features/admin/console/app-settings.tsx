/* The "General" settings of one app: whether the app is on for the
 * organization, and the app's workspace switches. Each switch saves as soon as
 * it is flipped and confirms with a snackbar; turning an app off asks first,
 * because it affects everyone. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { notify } from "@/components/ui/toast";
import {
  coreAppsAdminQueryOptions,
  coreAppsQueryKeys,
  setCoreAppEnabled,
  type CoreAppId,
} from "@/features/admin/core-apps-api";
import {
  tenantConfigQueryKeys,
  tenantConfigQueryOptions,
  updateTenantConfig,
} from "@/features/admin/tenant-config-api";
import { ConfirmDestructive } from "./confirm-destructive";
import { LoadingState, PanelHeading, QueryFailureBanner, useQueryFailure } from "./primitives";
import { SettingToggle } from "./widgets";

interface AppSettingsRouteQueryClient {
  ensureQueryData(
    options:
      ReturnType<typeof tenantConfigQueryOptions> | ReturnType<typeof coreAppsAdminQueryOptions>,
  ): Promise<unknown>;
}

/** Warms what an app's General settings read, from the route loader. */
export async function prefetchAdminAppSettingsQueries(queryClient: AppSettingsRouteQueryClient) {
  await Promise.all([
    queryClient.ensureQueryData(tenantConfigQueryOptions()).catch(() => undefined),
    queryClient.ensureQueryData(coreAppsAdminQueryOptions()).catch(() => undefined),
  ]);
}

/** What each app takes away from people when it is turned off. */
export const APP_DISABLE_CONSEQUENCE: Readonly<Record<CoreAppId, string>> = {
  mail: "Everyone loses the inbox, composing, and mail results in search.",
  chat: "Everyone loses chats and spaces, including conversations already in progress.",
  drive: "Everyone loses file browsing, upload, download, and Drive results in search.",
  calendar: "Everyone loses their schedule, event creation, and invitations.",
  meet: "Nobody can start or join a meeting, including meetings already scheduled.",
  assistant: "Everyone loses Assistant answers, summaries, and assisted actions.",
};

/** A workspace switch stored in tenant feature flags. */
export interface WorkspaceFlag {
  readonly key: string;
  readonly label: string;
  readonly description: string;
}

/** Reads and saves one boolean tenant feature flag. */
function useWorkspaceFlag(key: string) {
  const queryClient = useQueryClient();
  const query = useQuery(tenantConfigQueryOptions());
  const mutation = useMutation({
    mutationFn: (enabled: boolean) =>
      updateTenantConfig({ features: { [key]: enabled }, reason: `admin settings update: ${key}` }),
    onMutate: () => undefined,
    onSuccess: (config) => {
      queryClient.setQueryData(tenantConfigQueryKeys.detail(), config);
      notify({ message: "Setting saved" });
    },
    onError: (error: Error) => {
      notify({ message: "Couldn't save the setting", description: error.message, tone: "error" });
    },
  });
  const stored = query.data?.effective.features[key];
  /* While a save is in flight the switch shows where it is going. */
  const checked = mutation.isPending ? mutation.variables : stored === true;
  return {
    query,
    checked,
    saving: mutation.isPending,
    set: (next: boolean) => mutation.mutate(next),
  };
}

function FlagToggle({ flag }: { readonly flag: WorkspaceFlag }) {
  const { query, checked, saving, set } = useWorkspaceFlag(flag.key);
  return (
    <SettingToggle
      label={flag.label}
      description={flag.description}
      checked={checked}
      disabled={saving || query.data === undefined}
      onCheckedChange={set}
    />
  );
}

/** Workspace switches for one app, in a settings card. */
export function WorkspaceFlagsPanel({
  title,
  flags,
}: {
  readonly title: string;
  readonly flags: readonly WorkspaceFlag[];
}) {
  const queryClient = useQueryClient();
  const query = useQuery(tenantConfigQueryOptions());
  const failure = useQueryFailure(query, () => {
    void queryClient.invalidateQueries({ queryKey: tenantConfigQueryKeys.detail() });
  });
  return (
    <section className="admin-card" aria-label={title}>
      <PanelHeading title={title} />
      {failure !== null ? (
        <QueryFailureBanner
          summary="Settings couldn't be loaded"
          subject="workspace settings"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
        />
      ) : query.isPending ? (
        <LoadingState label="Loading settings" count={2} />
      ) : (
        <div className="admin-setting-list">
          {flags.map((flag) => (
            <FlagToggle key={flag.key} flag={flag} />
          ))}
        </div>
      )}
    </section>
  );
}

/** On/off for one app across the organization. */
export function AppStatusPanel({ appId }: { readonly appId: CoreAppId }) {
  const queryClient = useQueryClient();
  const query = useQuery(coreAppsAdminQueryOptions());
  const [confirming, setConfirming] = useState(false);
  const failure = useQueryFailure(query, () => {
    void queryClient.invalidateQueries({ queryKey: coreAppsQueryKeys.admin() });
  });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => setCoreAppEnabled(appId, enabled),
    onMutate: () => undefined,
    onSuccess: async (result) => {
      notify({
        message: `${result.changed.to ? "Turned on" : "Turned off"} for everyone`,
        ...(result.changed.requiresRestart
          ? { description: "The change finishes applying after the next restart." }
          : {}),
      });
      await queryClient.invalidateQueries({ queryKey: coreAppsQueryKeys.admin() });
      await queryClient.invalidateQueries({ queryKey: coreAppsQueryKeys.shell() });
    },
    onError: (error: Error) => {
      notify({ message: "Couldn't change the app", description: error.message, tone: "error" });
    },
    onSettled: () => setConfirming(false),
  });
  const app = query.data?.apps.find((entry) => entry.id === appId);

  return (
    <section className="admin-card" aria-label="Service status">
      <PanelHeading title="Service status" />
      {failure !== null ? (
        <QueryFailureBanner
          summary="App status couldn't be loaded"
          subject="app settings"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
        />
      ) : app === undefined ? (
        <LoadingState label="Loading app status" count={1} />
      ) : (
        <SettingToggle
          label={`${app.name} is on for everyone`}
          description={
            app.inRole
              ? app.description
              : `${app.description} This server does not run ${app.name}, so the setting applies where it does.`
          }
          checked={mutation.isPending ? mutation.variables : app.enabled}
          disabled={mutation.isPending}
          onCheckedChange={(next) => {
            if (next) {
              mutation.mutate(true);
            } else {
              setConfirming(true);
            }
          }}
        />
      )}
      {app === undefined || !confirming ? null : (
        <ConfirmDestructive
          open
          onOpenChange={setConfirming}
          title={`Turn off ${app.name}?`}
          blastRadius={APP_DISABLE_CONSEQUENCE[app.id]}
          confirmLabel={`Turn off ${app.name}`}
          isPending={mutation.isPending}
          onConfirm={() => mutation.mutate(false)}
        >
          {app.name} disappears from the app launcher, navigation, and search for everyone in your
          organization until an admin turns it back on.
        </ConfirmDestructive>
      )}
    </section>
  );
}
