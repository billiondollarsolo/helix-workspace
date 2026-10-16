import { loadEffectiveTenantConfig } from "../platform/tenancy/effective-config.js";
import { MeetTranscriptStore } from "../platform/meet/transcript-store.js";
import { MeetTranscriptWorker } from "../platform/meet/transcript-worker.js";
import { registerMeetTranscriptionRoutes } from "../platform/meet/transcription.js";
import { meetTranscriptionSettings } from "../platform/meet/transcription-settings.js";
import type { installTools } from "./tools.js";

export async function installMeetCapture(
  context: Awaited<ReturnType<typeof installTools>>,
  webhookSecret: string,
): Promise<void> {
  const { app, sql, meetStore, bootEnv } = context;
  if (bootEnv.MEET_TRANSCRIPTION_PROXY_URL) {
    const transcripts = new MeetTranscriptStore(sql);
    const settings = async (orgId: string) =>
      meetTranscriptionSettings(
        context.runtimeConfiguration.current,
        (await loadEffectiveTenantConfig({ orgs: context.orgStore }, orgId))?.features,
        true,
        bootEnv.MEET_TRANSCRIPTION_ALLOWED_HOSTS?.split(",")
          .map((host) => host.trim())
          .filter(Boolean),
      );
    await registerMeetTranscriptionRoutes(app, {
      store: transcripts,
      secret: webhookSecret,
      proxyUrl: bootEnv.MEET_TRANSCRIPTION_PROXY_URL,
      settings,
      onError: (error) => {
        app.log.error({ error }, "Meet transcription connection failed");
      },
    });
    context.leaderGatedWorkers.push({
      name: "meet-transcripts",
      worker: new MeetTranscriptWorker({
        store: transcripts,
        meetings: meetStore,
        drive: context.driveStore,
        ai: context.assistantAi,
        mail: context.mailStore,
        baseUrl: bootEnv.PUBLIC_BASE_URL ?? "http://localhost:3000",
        summarizeEnabled: async (orgId) => (await settings(orgId)).summarize,
        onError: (error) => {
          app.log.error({ error }, "Meet artifact processing failed");
        },
      }),
    });
  }
}
