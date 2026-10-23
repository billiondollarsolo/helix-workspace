import { MeetTranscriptWorker } from "../platform/meet/transcript-worker.js";
import type { installTools } from "./tools.js";

/** Leader-only Meet capture workers: the live transcriber's sweep and transcript processing. */
export function installMeetCapture(context: Awaited<ReturnType<typeof installTools>>): void {
  const { app, meetStore, bootEnv, meetTranscription } = context;
  if (meetTranscription === undefined) return;
  const { transcriber, transcripts: meetTranscripts, settings } = meetTranscription;
  context.leaderGatedWorkers.push({ name: "meet-live-transcription", worker: transcriber });
  context.leaderGatedWorkers.push({
    name: "meet-transcripts",
    worker: new MeetTranscriptWorker({
      store: meetTranscripts,
      meetings: meetStore,
      drive: context.driveStore,
      ai: context.assistantAi,
      mail: context.mailStore,
      baseUrl: bootEnv.HELIX_PUBLIC_URL ?? bootEnv.PUBLIC_BASE_URL ?? "http://localhost:3000",
      summarizeEnabled: async (orgId) => (await settings(orgId)).summarize,
      onError: (error) => {
        app.log.error({ error }, "Meet artifact processing failed");
      },
    }),
  });
}
