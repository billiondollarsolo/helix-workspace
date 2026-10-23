import type { HelixConfig } from "@helix/sdk-types";
import type postgres from "postgres";
import { MeetLiveTranscriber } from "../platform/meet/live-transcriber.js";
import type { LiveKitOptions } from "../platform/meet/livekit.js";
import type { MeetStore } from "../platform/meet/store.js";
import { registerMeetTranscriptTools } from "../platform/meet/transcript-tools.js";
import type { RuntimeToolRegistry } from "../platform/tool-registry.js";
import { MeetTranscriptStore } from "../platform/meet/transcript-store.js";
import { meetTranscriptionSettings } from "../platform/meet/transcription-settings.js";

/** Meet's live transcriber, transcript store, transcription tools and per-tenant settings. */
export function createMeetTranscription(input: {
  readonly sql: postgres.Sql;
  readonly tools: RuntimeToolRegistry;
  readonly meetings: MeetStore;
  readonly liveKit: LiveKitOptions;
  readonly config: () => HelixConfig;
  readonly features: (orgId: string) => Promise<Readonly<Record<string, unknown>> | undefined>;
  /** Comma-separated speech hosts beyond the default (MEET_TRANSCRIPTION_ALLOWED_HOSTS). */
  readonly allowedHosts: string | undefined;
  readonly onError: (error: unknown) => void;
}) {
  const transcripts = new MeetTranscriptStore(input.sql);
  const allowedHosts = input.allowedHosts
    ?.split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  const settings = async (orgId: string) =>
    meetTranscriptionSettings(input.config(), await input.features(orgId), true, allowedHosts);
  const transcriber = new MeetLiveTranscriber({
    store: transcripts,
    settings,
    liveKit: input.liveKit,
    onError: input.onError,
  });
  registerMeetTranscriptTools(input.tools, {
    meetings: input.meetings,
    transcripts,
    enabled: async (orgId) => (await settings(orgId)).enabled,
    onRequested: (orgId, roomId, enabled) => transcriber.requested(orgId, roomId, enabled),
  });
  return { transcriber, transcripts, settings };
}
