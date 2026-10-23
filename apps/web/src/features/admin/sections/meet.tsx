/* Admin › Apps › Meet. Meetings run on the configured LiveKit media server; this
 * page shows whether that connection is configured, from the services catalog. */

import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminServicesQueryKey, adminServicesQueryOptions } from "@/features/admin/admin-services";
import { AppStatusPanel, WorkspaceFlagsPanel } from "@/features/admin/console/app-settings";
import { AdminSelect } from "@/features/admin/console/controls";
import {
  tenantConfigQueryKeys,
  tenantConfigQueryOptions,
  updateTenantConfig,
} from "@/features/admin/tenant-config-api";
import { notify } from "@/components/ui/toast";
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

const CAPTION_LANGUAGES: readonly (readonly [string, string])[] = [
  ["", "Detect automatically"],
  ["en", "English"],
  ["sl", "Slovenian"],
  ["hr", "Croatian"],
  ["sr", "Serbian"],
  ["de", "German"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["cs", "Czech"],
  ["hu", "Hungarian"],
  ["uk", "Ukrainian"],
  ["ja", "Japanese"],
  ["zh", "Chinese"],
];

/** The language captions are transcribed in; a hint that improves accuracy. */
function CaptionLanguageSetting() {
  const queryClient = useQueryClient();
  const query = useQuery(tenantConfigQueryOptions());
  const mutation = useMutation({
    mutationFn: (language: string) =>
      updateTenantConfig({
        features: { meet_transcription_language: language },
        reason: "admin settings update: meet_transcription_language",
      }),
    onMutate: () => undefined,
    onSuccess: (config) => {
      queryClient.setQueryData(tenantConfigQueryKeys.detail(), config);
      notify({ message: "Setting saved" });
    },
    onError: (error: Error) => {
      notify({ message: "Couldn't save the setting", description: error.message, tone: "error" });
    },
  });
  const stored = query.data?.effective.features.meet_transcription_language;
  const value = mutation.isPending ? mutation.variables : typeof stored === "string" ? stored : "";
  return (
    <div className="admin-setting">
      <div className="admin-setting-text">
        <label htmlFor="meet-caption-language" className="admin-setting-label">
          Caption language
        </label>
        <span className="admin-setting-description">
          The language people usually speak in meetings. Choosing one makes captions more accurate.
        </span>
      </div>
      <AdminSelect
        id="meet-caption-language"
        value={value}
        disabled={query.data === undefined || mutation.isPending}
        onChange={(event) => {
          mutation.mutate(event.target.value);
        }}
      >
        {CAPTION_LANGUAGES.map(([code, label]) => (
          <option key={code} value={code}>
            {label}
          </option>
        ))}
      </AdminSelect>
    </div>
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
                "Let hosts turn on live captions and a transcript after everyone in the call has accepted the capture notice. Needs a meet.transcribe AI route. Transcripts are saved in the meeting owner’s Drive and attendees are emailed a private link.",
            },
            {
              key: "meet_ai_recaps",
              label: "AI meeting recaps",
              description:
                "Generate a recap with decisions and action items from saved transcripts, using the meet.summarize AI route and workspace cost limits. Recaps require review for accuracy.",
            },
          ]}
        >
          <CaptionLanguageSetting />
        </WorkspaceFlagsPanel>
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
