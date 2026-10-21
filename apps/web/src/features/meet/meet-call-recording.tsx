/* In-call recording controls for moderators: a Start/Stop recording button in
   the call toolbar, a confirmation before recording everyone present, and the
   pending/error feedback under the toolbar.

   The server starts and stops LiveKit Egress (`meet.recording.start` /
   `.stop`) and enforces who may record and that everyone present accepted the
   recording notice. LiveKit then marks the room as recording, which is what the
   REC pill and notice follow for every participant (see `useLiveKitCall`). */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useMutation } from "@tanstack/react-query";
import { CircleDot as RecordIcon, Square as StopIcon } from "lucide-react";
import { useState } from "react";
import { startMeetRecording, stopMeetRecording } from "./api";
import { CallControl } from "./meet-call-panels";

type RecordingAction = "start" | "stop";

export interface MeetRecordingControls {
  /** What the button shows: the server's answer until LiveKit's status catches up. */
  readonly recording: boolean;
  readonly pendingAction: RecordingAction | null;
  readonly errorMessage: string | null;
  readonly start: () => void;
  readonly stop: () => void;
}

export function useMeetRecording(roomId: string, recordingActive: boolean): MeetRecordingControls {
  // After a successful start/stop the button follows the server's answer
  // until LiveKit reports a recording change; then LiveKit wins again.
  const [requested, setRequested] = useState<boolean | null>(null);
  const [seenActive, setSeenActive] = useState(recordingActive);
  if (seenActive !== recordingActive) {
    setSeenActive(recordingActive);
    setRequested(null);
  }

  const mutation = useMutation({
    mutationFn: async (action: RecordingAction) => {
      if (action === "start") await startMeetRecording(roomId);
      else await stopMeetRecording(roomId);
      return action;
    },
    onMutate: () => undefined,
    onSuccess: (action) => {
      setRequested(action === "start");
    },
    onError: () => undefined,
  });
  const run = (action: RecordingAction) => {
    if (!mutation.isPending) mutation.mutate(action);
  };

  return {
    recording: requested ?? recordingActive,
    pendingAction: mutation.isPending ? (mutation.variables ?? null) : null,
    errorMessage: mutation.isError
      ? mutation.error instanceof Error && mutation.error.message.length > 0
        ? mutation.error.message
        : "Recording couldn’t be changed. Try again."
      : null,
    start: () => {
      run("start");
    },
    stop: () => {
      run("stop");
    },
  };
}

/** Toolbar control: Start recording (after confirmation) or Stop recording. */
export function RecordingControl({
  controls,
  participantCount,
  disabled,
}: {
  readonly controls: MeetRecordingControls;
  /** Everyone in the call, including you. */
  readonly participantCount: number;
  readonly disabled: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { recording, pendingAction } = controls;
  const label =
    pendingAction === "start"
      ? "Starting recording…"
      : pendingAction === "stop"
        ? "Stopping recording…"
        : recording
          ? "Stop recording"
          : "Start recording";

  return (
    <>
      <CallControl
        label={label}
        danger={recording}
        disabled={disabled}
        busy={pendingAction !== null}
        onClick={() => {
          if (recording) controls.stop();
          else setConfirmOpen(true);
        }}
      >
        {recording ? <StopIcon size={16} /> : <RecordIcon size={16} />}
      </CallControl>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="type-h3">Record this meeting?</AlertDialogTitle>
            <AlertDialogDescription>
              {recordingAudience(participantCount)} Audio, video, and shared content are captured.
              Everyone in the call sees that recording is on, including anyone who joins later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                controls.start();
              }}
            >
              Start recording
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function recordingAudience(participantCount: number): string {
  return participantCount <= 1
    ? "You’re the only one here now; you and anyone who joins will be recorded."
    : `Everyone in this call (${String(participantCount)} people) will be recorded.`;
}

/** Pending status and the server's reason when a start/stop failed. */
export function RecordingFeedback({ controls }: { readonly controls: MeetRecordingControls }) {
  return (
    <>
      <div role="status" className="sr-only">
        {controls.pendingAction === "start"
          ? "Starting recording…"
          : controls.pendingAction === "stop"
            ? "Stopping recording…"
            : ""}
      </div>
      {controls.errorMessage !== null ? (
        <div role="alert" className="[padding:8px_16px] [color:var(--danger)]">
          {controls.errorMessage}
        </div>
      ) : null}
    </>
  );
}
