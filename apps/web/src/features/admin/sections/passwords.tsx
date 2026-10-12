/* Admin › Apps › Passwords. The password manager is an optional install: a
 * separate service the deployment may run. This page says whether this server
 * runs one and lets an admin offer it to everyone. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WorkspaceFlagsPanel } from "@/features/admin/console/app-settings";
import {
  LoadingState,
  PageHeading,
  PanelHeading,
  QueryFailureBanner,
  StatusChip,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import { coreAppsQueryKeys, coreAppsShellQueryOptions } from "@/features/admin/core-apps-api";

export { prefetchAdminAppSettingsQueries } from "@/features/admin/console/app-settings";

const PASSWORDS_FLAGS = [
  {
    key: "passwords_app",
    label: "Passwords is on for everyone",
    description:
      "Adds Passwords to the app launcher. People create their own vault account with their work email. Off by default.",
  },
] as const;

export function PasswordsAdminSection() {
  const queryClient = useQueryClient();
  const query = useQuery(coreAppsShellQueryOptions());
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: coreAppsQueryKeys.shell() });
  };
  const failure = useQueryFailure(query, reload);
  const passwords = query.data?.passwords;

  return (
    <>
      <PageHeading title="Passwords" subtitle="A password manager for your organization." />
      <div className="admin-stack">
        <section className="admin-card" aria-labelledby="passwords-server-heading">
          <PanelHeading
            id="passwords-server-heading"
            title="Password manager"
            subtitle="An optional service, installed with the server. Its accounts are separate from workspace accounts."
          />
          {failure !== null ? (
            <QueryFailureBanner
              summary="Password manager status couldn't be loaded"
              subject="app settings"
              error={failure.error}
              isRetrying={failure.isRetrying}
              onRetry={failure.retry}
            />
          ) : query.isPending ? (
            <LoadingState label="Loading password manager status" count={1} />
          ) : passwords?.installed === true ? (
            <dl className="admin-facts">
              <div>
                <dt>This server</dt>
                <dd>
                  <StatusChip tone="success" label="Installed" />
                </dd>
              </div>
            </dl>
          ) : (
            <>
              <dl className="admin-facts">
                <div>
                  <dt>This server</dt>
                  <dd>
                    <StatusChip tone="warning" label="Not installed" />
                  </dd>
                </div>
              </dl>
              <p className="admin-muted">
                Whoever runs this server can add it: see “Optional installs” in the deployment
                guide. Until then there is nothing to turn on here.
              </p>
            </>
          )}
        </section>
        {passwords?.installed === true ? (
          <WorkspaceFlagsPanel title="Availability" flags={PASSWORDS_FLAGS} onSaved={reload} />
        ) : null}
      </div>
    </>
  );
}
