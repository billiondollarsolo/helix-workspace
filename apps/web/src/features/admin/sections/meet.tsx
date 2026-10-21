/* Admin › Apps › Meet. Meetings run on the configured LiveKit media server; this
 * page shows whether that connection is configured, from the services catalog. */

import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminServicesQueryKey, adminServicesQueryOptions } from "@/features/admin/admin-services";
import { AppStatusPanel, WorkspaceFlagsPanel } from "@/features/admin/console/app-settings";
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
        subtitle="Meetings need a configured LiveKit server, API key and secret."
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
        <WorkspaceFlagsPanel
          title="Capture and AI"
          flags={[
            {
              key: "meet_transcription",
              label: "Speech transcription",
              description:
                "Allow hosts to transcribe meetings after participant consent. Requires the native transcription service and a meet.transcribe AI route. Transcripts are saved in the owner’s Drive and private links are emailed to attendees.",
            },
            {
              key: "meet_ai_recaps",
              label: "AI meeting recaps",
              description:
                "Generate a recap with decisions and action items from saved transcripts, using the meet.summarize AI route and workspace cost limits. Recaps require review for accuracy.",
            },
          ]}
        />
        <Link
          className="btn secondary"
          to="/admin/$section"
          params={{ section: "assistant" }}
          search={{ tab: "models" }}
        >
          Choose meeting providers and models
        </Link>
        <p className="admin-muted">
          Configure transcription and recap providers in AI settings. Speech transcription supports
          endpoints implementing the OpenAI realtime transcription protocol, including compatible
          self-hosted services on the deployment allowlist. Summaries can use any configured text
          provider. Both are off by default; selecting a model does not enable capture.
        </p>
      </div>
    </>
  );
}
