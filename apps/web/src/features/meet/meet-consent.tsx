/* The recording notice everyone accepts before joining a meeting, members on
   the pre-join screen and guests on the guest page. Accepting it is recorded
   against MEET_RECORDING_NOTICE_VERSION; change both together. */

import { useId, type Ref } from "react";

export function MeetRecordingConsent({
  checked,
  onChange,
  showError,
  inputRef,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  /** The person tried to join without accepting. */
  readonly showError: boolean;
  readonly inputRef?: Ref<HTMLInputElement>;
}) {
  const consentId = useId();
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start gap-2.5">
        <input
          ref={inputRef}
          id={consentId}
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
          checked={checked}
          aria-invalid={showError && !checked}
          aria-describedby={`${consentId}-notice`}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        <div>
          <label htmlFor={consentId} className="type-body-sm font-medium">
            I consent to recording and transcription
          </label>
          <p id={`${consentId}-notice`} className="m-0 mt-1 type-meta text-muted-foreground">
            Hosts may record audio, video and shared content, or transcribe speech using the
            workspace AI provider. Recordings and transcripts are saved in the owner’s Drive;
            attendees receive private links. AI recaps may also be generated. Capture is shown
            during the meeting.
          </p>
        </div>
      </div>
      {showError && !checked ? (
        <p role="alert" className="m-0 mt-2 type-meta text-destructive">
          Accept the recording notice to join.
        </p>
      ) : null}
    </div>
  );
}
