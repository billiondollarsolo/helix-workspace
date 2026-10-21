/* MeetPreJoin — the check-yourself screen before entering a call: camera and
   microphone preview with toggles and device pickers, who you are joining as,
   the meeting title or code, the recording notice to accept, and Join now. */

import { Avatar } from "@/components/ui/avatar";
import { InlineError } from "@/components/ui/inline-error";
import { sessionUserQueryOptions } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft as BackIcon,
  Mic as MicIcon,
  MicOff as MicOffIcon,
  Video as CamIcon,
  VideoOff as CamOffIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MeetRecordingConsent } from "./meet-consent";
import {
  joinMeetTarget,
  meetJoinTargetCode,
  meetJoinTargetTitle,
  type MeetJoinTarget,
} from "./meet-join";
import {
  initialMediaFor,
  readMeetMediaChoice,
  saveMeetMediaChoice,
  useMeetMediaPreview,
  type MeetMediaChoice,
  type MeetPreviewProblem,
} from "./meet-media";
import type { MeetCallSession } from "./meet-shell";

export interface MeetPreJoinProps {
  readonly target: MeetJoinTarget;
  readonly onJoined: (session: MeetCallSession) => void;
  readonly onCancel: () => void;
}

export function MeetPreJoin({ target, onJoined, onCancel }: MeetPreJoinProps) {
  const user = useQuery(sessionUserQueryOptions()).data;
  const displayName = user?.name.trim() || user?.email || "You";
  const [choice, setChoice] = useState<MeetMediaChoice>(readMeetMediaChoice);
  const [consented, setConsented] = useState(false);
  const [consentError, setConsentError] = useState(false);
  const preview = useMeetMediaPreview(choice);
  const consentRef = useRef<HTMLInputElement>(null);
  const title = meetJoinTargetTitle(target);
  const code = meetJoinTargetCode(target);

  const update = (next: Partial<MeetMediaChoice>) => {
    setChoice((current) => {
      const merged = { ...current, ...next };
      saveMeetMediaChoice(merged);
      return merged;
    });
  };

  const join = useMutation({
    mutationFn: () => joinMeetTarget(target, initialMediaFor(choice)),
    onMutate: () => undefined,
    onSuccess: onJoined,
    onError: () => undefined,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!consented) {
      setConsentError(true);
      consentRef.current?.focus();
      return;
    }
    join.mutate();
  }

  const microphones = preview.devices.filter((device) => device.kind === "audioinput");
  const cameras = preview.devices.filter((device) => device.kind === "videoinput");

  return (
    <div className="flex-1 overflow-y-auto bg-background">
      <div className="mx-auto grid max-w-260 items-center gap-8 px-4 py-6 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] md:px-8 md:py-12">
        <section aria-label="Camera and microphone preview" className="min-w-0">
          <div className="relative aspect-video overflow-hidden rounded-xl bg-[var(--surface-3)]">
            {preview.stream !== null && choice.camOn ? (
              <PreviewVideo stream={preview.stream} />
            ) : (
              <div className="absolute inset-0 grid place-items-center">
                <div className="flex flex-col items-center gap-2 px-4 pb-14 text-center sm:gap-3">
                  <Avatar name={displayName} size={56} />
                  <p className="m-0 type-body-sm text-[var(--text-2)]">
                    {previewMessage(choice, preview.problem)}
                  </p>
                </div>
              </div>
            )}
            <span className="absolute top-3 left-3 rounded-md bg-[color-mix(in_srgb,var(--bg)_80%,transparent)] px-2 py-1 type-meta text-foreground">
              {displayName}
            </span>
            <div className="absolute inset-x-0 bottom-3 flex justify-center gap-3">
              <MediaToggle
                on={choice.micOn}
                onLabel="Turn off microphone"
                offLabel="Turn on microphone"
                onClick={() => {
                  update({ micOn: !choice.micOn });
                }}
              >
                {choice.micOn ? <MicIcon size={20} /> : <MicOffIcon size={20} />}
              </MediaToggle>
              <MediaToggle
                on={choice.camOn}
                onLabel="Turn off camera"
                offLabel="Turn on camera"
                onClick={() => {
                  update({ camOn: !choice.camOn });
                }}
              >
                {choice.camOn ? <CamIcon size={20} /> : <CamOffIcon size={20} />}
              </MediaToggle>
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <DevicePicker
              label="Microphone"
              icon={<MicIcon size={16} aria-hidden="true" />}
              devices={microphones}
              value={choice.audioInputId}
              onChange={(audioInputId) => {
                update({ audioInputId });
              }}
            />
            <DevicePicker
              label="Camera"
              icon={<CamIcon size={16} aria-hidden="true" />}
              devices={cameras}
              value={choice.videoInputId}
              onChange={(videoInputId) => {
                update({ videoInputId });
              }}
            />
          </div>
        </section>

        <form className="flex min-w-0 flex-col gap-4" onSubmit={submit} noValidate>
          <div>
            <h1 className="m-0 type-h1 font-semibold">Ready to join?</h1>
            <p className="m-0 mt-1 type-body text-foreground">{title}</p>
            {code !== null ? (
              <p className="m-0 mt-0.5 mono type-meta text-muted-foreground">{code}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2.5">
            <Avatar name={displayName} size={32} />
            <div className="min-w-0">
              <p className="m-0 type-caption text-muted-foreground">Joining as</p>
              <p className="m-0 truncate type-body-sm font-medium">{displayName}</p>
            </div>
          </div>
          <MeetRecordingConsent
            checked={consented}
            showError={consentError}
            inputRef={consentRef}
            onChange={(checked) => {
              setConsented(checked);
              setConsentError(false);
            }}
          />
          {join.isError ? (
            <InlineError
              variant="compact"
              title="Couldn't join the meeting"
              message={join.error instanceof Error ? join.error.message : "Try again."}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn primary lg" type="submit" disabled={join.isPending}>
              {join.isPending ? "Joining…" : "Join now"}
            </button>
            <button className="btn ghost lg" type="button" onClick={onCancel}>
              <BackIcon size={16} aria-hidden="true" /> Back to Meet
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function previewMessage(choice: MeetMediaChoice, problem: MeetPreviewProblem): string {
  if (problem === "blocked")
    return "Camera and microphone are blocked. Allow access in your browser.";
  if (problem === "unavailable") return "No camera or microphone found.";
  if (!choice.camOn) return "Camera is off";
  return "Starting camera…";
}

function PreviewVideo({ stream }: { readonly stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current !== null) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      aria-label="Your camera preview"
      className="absolute inset-0 size-full object-cover [transform:scaleX(-1)]"
    />
  );
}

function MediaToggle({
  on,
  onLabel,
  offLabel,
  onClick,
  children,
}: {
  readonly on: boolean;
  readonly onLabel: string;
  readonly offLabel: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={on ? onLabel : offLabel}
      aria-pressed={!on}
      onClick={onClick}
      className={cn(
        "focus-ring grid size-12 place-items-center rounded-full border",
        on
          ? "border-[var(--border-2)] bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] text-foreground"
          : "border-transparent bg-[var(--label-red)] text-[var(--label-on)]",
      )}
    >
      {children}
    </button>
  );
}

function DevicePicker({
  label,
  icon,
  devices,
  value,
  onChange,
}: {
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly devices: readonly MediaDeviceInfo[];
  readonly value: string | null;
  readonly onChange: (deviceId: string | null) => void;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-muted-foreground">
      {icon}
      <select
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent type-meta text-foreground outline-none"
        value={value ?? ""}
        disabled={devices.length === 0}
        onChange={(event) => {
          onChange(event.target.value === "" ? null : event.target.value);
        }}
      >
        <option value="">{`Default ${label.toLowerCase()}`}</option>
        {devices.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || `${label} ${String(index + 1)}`}
          </option>
        ))}
      </select>
    </label>
  );
}
