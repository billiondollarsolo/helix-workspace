/* Admin › Apps › Meet. Meetings run on the configured Jitsi deployment; this
 * page shows whether that connection is configured, from the services catalog. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminServicesQueryKey, adminServicesQueryOptions } from "@/features/admin/admin-services";
import { AppStatusPanel } from "@/features/admin/console/app-settings";
import {
  LoadingState,
  PageHeading,
  PanelHeading,
  QueryFailureBanner,
  StatusChip,
  useQueryFailure,
} from "@/features/admin/console/primitives";

export { prefetchAdminAppSettingsQueries } from "@/features/admin/console/app-settings";

function MeetingServerPanel() {
  const queryClient = useQueryClient();
  const query = useQuery(adminServicesQueryOptions());
  const failure = useQueryFailure(query, () => {
    void queryClient.invalidateQueries({ queryKey: adminServicesQueryKey });
  });
  const meet = query.data?.services.find((service) => service.id === "meet");

  return (
    <section className="admin-card" aria-labelledby="meet-server-heading">
      <PanelHeading
        id="meet-server-heading"
        title="Meeting server"
        subtitle="Meetings need a configured Jitsi domain and signing secret."
      />
      {failure !== null ? (
        <QueryFailureBanner
          summary="Meeting server status couldn't be loaded"
          subject="service status"
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
        />
      ) : query.isPending ? (
        <LoadingState label="Loading meeting server status" count={2} />
      ) : meet === undefined ? (
        <p className="admin-muted">This server doesn't report a meeting service.</p>
      ) : (
        <dl className="admin-facts">
          {meet.configuration.map((item) => (
            <div key={item.key}>
              <dt>{item.label}</dt>
              <dd>
                <StatusChip
                  tone={item.configured ? "success" : "warning"}
                  label={item.configured ? "Configured" : "Not configured"}
                />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function MeetAdminSection() {
  return (
    <>
      <PageHeading title="Meet" subtitle="Video meetings for your organization." />
      <div className="admin-stack">
        <AppStatusPanel appId="meet" />
        <MeetingServerPanel />
      </div>
    </>
  );
}
