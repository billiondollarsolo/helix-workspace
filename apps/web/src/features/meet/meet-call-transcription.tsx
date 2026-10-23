/* Live transcription in the call: the host's Start/Stop transcription button
   (with a confirmation before starting), its pending/error feedback, the
   one-line notice everyone sees, and the caption overlay with its CC toggle.

   The server (`meet.transcription.set`) decides who may transcribe and checks
   consent. A hidden server participant then sends `state` and `caption`
   packets, which `useLiveKitCall` turns into `transcriptionActive` and
   `captions` for every participant, guests included. */

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
import { cn } from "@/lib/utils";
import { useMutation } from "@tanstack/react-query";
import { Captions as CaptionsIcon, CaptionsOff as CaptionsOffIcon, FileText } from "lucide-react";
import { useState } from "react";
import { setMeetTranscription } from "./api";
import type { MeetCaption } from "./meet-call-controls";
import { CallControl } from "./meet-call-panels";

type TranscriptionAction = "start" | "stop";

export interface MeetTranscriptionControls {
  /** What the button shows: the server's answer until a `state` packet catches up. */
  readonly transcribing: boolean;
  readonly pendingAction: TranscriptionAction | null;
  readonly errorMessage: string | null;
  readonly start: () => void;
  readonly stop: () => void;
}

export function useMeetTranscription(roomId: string, active: boolean): MeetTranscriptionControls {
  // After a successful change the button follows the server's answer until
  // the call reports a transcription change; then the call wins again.
  const [requested, setRequested] = useState<boolean | null>(null);
  const [seenActive, setSeenActive] = useState(active);
  if (seenActive !== active) {
    setSeenActive(active);
    setRequested(null);
  }

  const mutation = useMutation({
    mutationFn: async (action: TranscriptionAction) => {
      await setMeetTranscription(roomId, action === "start");
      return action;
    },
    onMutate: () => undefined,
    onSuccess: (action) => {
      setRequested(action === "start");
    },
    onError: () => undefined,
  });
  const run = (action: TranscriptionAction) => {
    if (!mutation.isPending) mutation.mutate(action);
  };

  return {
    transcribing: requested ?? active,
    pendingAction: mutation.isPending ? (mutation.variables ?? null) : null,
    errorMessage: mutation.isError
      ? mutation.error instanceof Error && mutation.error.message.length > 0
        ? mutation.error.message
        : "Transcription couldn’t be changed. Try again."
      : null,
    start: () => {
      run("start");
    },
    stop: () => {
      run("stop");
    },
  };
}

/** Host toolbar control: Start transcription (after confirmation) or Stop. */
export function TranscriptionControl({
  controls,
  disabled,
}: {
  readonly controls: MeetTranscriptionControls;
  readonly disabled: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { transcribing, pendingAction } = controls;
  const label =
    pendingAction === "start"
      ? "Starting transcription…"
      : pendingAction === "stop"
        ? "Stopping transcription…"
        : transcribing
          ? "Stop transcription"
          : "Start transcription";

  return (
    <>
      <CallControl
        label={label}
        active={transcribing}
        disabled={disabled}
        busy={pendingAction !== null}
        onClick={() => {
          if (transcribing) controls.stop();
          else setConfirmOpen(true);
        }}
      >
        <FileText size={16} />
      </CallControl>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="type-h3">Transcribe this meeting?</AlertDialogTitle>
            <AlertDialogDescription>
              What people say is turned into live captions and a transcript. Everyone in the call
              sees that transcription is on, including anyone who joins later. The transcript is
              saved to the meeting owner’s Drive, and attendees get a link to it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                controls.start();
              }}
            >
              Start transcription
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Pending status and the server's reason when a start/stop failed. */
export function TranscriptionFeedback({
  controls,
}: {
  readonly controls: MeetTranscriptionControls;
}) {
  return (
    <>
      <div role="status" className="sr-only">
        {controls.pendingAction === "start"
          ? "Starting transcription…"
          : controls.pendingAction === "stop"
            ? "Stopping transcription…"
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

export function TranscriptionNotice({ active }: { readonly active: boolean }) {
  if (!active) return null;
  return (
    <div
      role="status"
      className="[padding:6px_16px] bg-[var(--info-soft)] text-[var(--text)] type-body-sm text-center"
    >
      Transcription is on — what people say is captioned and saved to a transcript.
    </div>
  );
}

/** Toolbar CC button: shows or hides the caption overlay. */
export function CaptionsToggle({
  shown,
  onToggle,
}: {
  readonly shown: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <CallControl
      label={shown ? "Hide captions" : "Show captions"}
      active={shown}
      onClick={onToggle}
    >
      {shown ? <CaptionsIcon size={16} /> : <CaptionsOffIcon size={16} />}
    </CallControl>
  );
}

/** Caption lines over the bottom of the video stage. Screen readers hear
    only final lines, through a polite live region. */
export function CaptionsOverlay({ captions }: { readonly captions: readonly MeetCaption[] }) {
  const finals = captions.filter((caption) => caption.final);
  return (
    <>
      <div
        aria-live="polite"
        aria-atomic="false"
        data-testid="meet-captions-live"
        className="sr-only"
      >
        {finals.map((caption) => (
          <p key={caption.itemId}>{`${caption.speakerName}: ${caption.text}`}</p>
        ))}
      </div>
      {captions.length > 0 ? (
        <div
          aria-hidden="true"
          data-testid="meet-captions"
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 w-[min(720px,calc(100%-24px))] grid gap-1 rounded-lg [padding:8px_12px] [background:color-mix(in_srgb,black_72%,transparent)] text-white type-body-sm pointer-events-none"
        >
          {captions.map((caption) => (
            <p
              key={caption.itemId}
              data-final={caption.final}
              className={cn("m-0 line-clamp-2", caption.final ? "" : "[opacity:0.7]")}
            >
              <span className="font-semibold">{caption.speakerName}:</span> {caption.text}
            </p>
          ))}
        </div>
      ) : null}
    </>
  );
}
