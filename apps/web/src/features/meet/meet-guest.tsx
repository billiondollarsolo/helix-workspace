/* The public guest page (`/meet/guest#<token>`): someone outside the
   organization enters their name and the invited email, accepts the recording
   notice, and joins. With the lobby on they wait, checking back every few
   seconds, until a host lets them in or turns them away. Once in, the same
   call view runs in guest mode: no session, no host or recording controls. */

import { AuthCard } from "@/features/auth/auth-card";
import { AuthForm, AuthInput, SubmitButton } from "@/features/auth/login-panel";
import { randomId } from "@/lib/random-id";
import { Debouncer } from "@tanstack/pacer";
import { CircleSlash, DoorOpen, Hourglass, TriangleAlert } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { MeetRecordingConsent } from "./meet-consent";
import {
  postMeetGuestJoin,
  type MeetGuestJoin,
  type MeetGuestJoinInput,
  type MeetGuestJoinResult,
} from "./meet-guest-api";
import { meetDeviceId } from "./meet-join";
import { initialMediaFor, readMeetMediaChoice, saveMeetMediaChoice } from "./meet-media";
import type { MeetCallSession } from "./meet-shell";

/* The call view carries the LiveKit client; load it only once let in. */
const MeetCall = lazy(() => import("./meet-call").then((module) => ({ default: module.MeetCall })));

type GuestState =
  | { readonly status: "form"; readonly error: string | null }
  | { readonly status: "joining" }
  | { readonly status: "waiting" }
  | { readonly status: "denied" }
  | { readonly status: "blocked" }
  | { readonly status: "invalid" }
  | { readonly status: "in_call"; readonly session: MeetCallSession }
  | { readonly status: "left" };

export interface MeetGuestPageProps {
  /** The invitation token from the URL fragment. */
  readonly token: string;
  /** Replaced in tests. */
  readonly join?: (input: MeetGuestJoinInput, signal: AbortSignal) => Promise<MeetGuestJoinResult>;
}

const NAME_MAX = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
/** How long to wait before checking back after a failed check. */
const RETRY_AFTER_ERROR_MS = 3_000;

const defaultJoin = (input: MeetGuestJoinInput, signal: AbortSignal) =>
  postMeetGuestJoin(input, undefined, signal);

export function MeetGuestPage({ token, join = defaultJoin }: MeetGuestPageProps) {
  const [state, setState] = useState<GuestState>(
    token.length === 0 ? { status: "invalid" } : { status: "form", error: null },
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [consented, setConsented] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [media, setMedia] = useState(readMeetMediaChoice);
  const attemptRef = useRef<{ controller: AbortController; retry: Debouncer<() => void> } | null>(
    null,
  );

  const stop = useCallback(() => {
    const attempt = attemptRef.current;
    if (attempt === null) return;
    attempt.controller.abort();
    attempt.retry.cancel();
    attemptRef.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  const nameInvalid = trimmedName.length === 0 || trimmedName.length > NAME_MAX;
  const emailInvalid = !EMAIL_PATTERN.test(trimmedEmail);

  const start = () => {
    setShowErrors(true);
    if (nameInvalid || emailInvalid || !consented) return;
    stop();
    const controller = new AbortController();
    let retryAfterMs = RETRY_AFTER_ERROR_MS;
    // Scheduled through Pacer (house rule); `wait` re-reads the server's delay.
    const retry = new Debouncer(
      () => {
        check();
      },
      { wait: () => retryAfterMs },
    );
    attemptRef.current = { controller, retry };
    // One grant per join attempt; reusing it while waiting is fine.
    const input: MeetGuestJoinInput = {
      token,
      email: trimmedEmail,
      name: trimmedName,
      deviceId: meetDeviceId(),
      joinGrantId: randomId(),
    };
    const startMedia = initialMediaFor(media);
    let waited = false;

    const check = () => {
      join(input, controller.signal).then(
        (result) => {
          if (controller.signal.aborted) return;
          if (result.kind === "waiting") {
            waited = true;
            setState({ status: "waiting" });
            retryAfterMs = result.retryAfterMs;
            retry.maybeExecute();
            return;
          }
          attemptRef.current = null;
          setState(nextState(result, startMedia));
        },
        () => {
          if (controller.signal.aborted) return;
          if (waited) {
            // A dropped check while waiting: keep our place and try again.
            retryAfterMs = RETRY_AFTER_ERROR_MS;
            retry.maybeExecute();
            return;
          }
          attemptRef.current = null;
          setState({ status: "form", error: "Couldn’t reach the meeting. Try again." });
        },
      );
    };
    setState({ status: "joining" });
    check();
  };

  if (state.status === "in_call") {
    return (
      <div className="h-dvh">
        <Suspense
          fallback={
            <div role="status" className="grid h-full place-items-center type-body-sm">
              Opening the meeting…
            </div>
          }
        >
          <MeetCall
            session={state.session}
            guestName={trimmedName}
            onLeave={() => {
              setState({ status: "left" });
            }}
          />
        </Suspense>
      </div>
    );
  }

  if (state.status === "waiting") {
    return (
      <AuthCard
        title="Waiting for the host to let you in…"
        subtitle="Keep this page open. You’ll join as soon as the host admits you."
        status={{ tone: "success", icon: <Hourglass size={22} /> }}
      >
        <div role="status" className="sr-only">
          Waiting for the host to let you in…
        </div>
        <button
          type="button"
          className="btn auth-submit"
          onClick={() => {
            stop();
            setState({ status: "left" });
          }}
        >
          Leave
        </button>
      </AuthCard>
    );
  }

  if (state.status === "left") {
    return (
      <AuthCard
        title="You left the meeting"
        status={{ tone: "success", icon: <DoorOpen size={22} /> }}
      >
        <button
          type="button"
          className="btn auth-submit"
          onClick={() => {
            setState({ status: "form", error: null });
          }}
        >
          Join again
        </button>
      </AuthCard>
    );
  }

  if (state.status === "denied") {
    return (
      <AuthCard
        title="The host didn’t let you in."
        status={{ tone: "danger", icon: <CircleSlash size={22} /> }}
      />
    );
  }

  if (state.status === "blocked") {
    return (
      <AuthCard
        title="You can’t join this meeting right now."
        subtitle="The meeting may be locked. Ask the host for help."
        status={{ tone: "danger", icon: <CircleSlash size={22} /> }}
      />
    );
  }

  if (state.status === "invalid") {
    return (
      <AuthCard
        title="This invitation isn’t valid or has expired."
        subtitle="Ask the host for a new link."
        status={{ tone: "danger", icon: <TriangleAlert size={22} /> }}
      />
    );
  }

  const updateMedia = (next: Partial<typeof media>) => {
    setMedia((current) => {
      const merged = { ...current, ...next };
      saveMeetMediaChoice(merged);
      return merged;
    });
  };

  return (
    <AuthCard
      title="Join the meeting"
      subtitle="Use the email address your invitation was sent to."
    >
      <AuthForm legend="Join as a guest" onSubmit={start}>
        <AuthInput
          label="Your name"
          name="name"
          autoComplete="name"
          value={name}
          onChange={setName}
          autoFocus
          invalid={showErrors && nameInvalid}
        />
        <AuthInput
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          invalid={showErrors && emailInvalid}
        />
        {showErrors && (nameInvalid || emailInvalid) ? (
          <p role="alert" className="m-0 type-meta text-destructive">
            {nameInvalid ? "Enter your name." : "Enter your email address."}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-4 type-body-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={media.micOn}
              onChange={(event) => {
                updateMedia({ micOn: event.target.checked });
              }}
            />
            Microphone on
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={media.camOn}
              onChange={(event) => {
                updateMedia({ camOn: event.target.checked });
              }}
            />
            Camera on
          </label>
        </div>
        <MeetRecordingConsent checked={consented} showError={showErrors} onChange={setConsented} />
        {state.status === "form" && state.error !== null ? (
          <p role="alert" className="m-0 type-meta text-destructive">
            {state.error}
          </p>
        ) : null}
        <SubmitButton busy={state.status === "joining"}>
          {state.status === "joining" ? "Joining…" : "Join"}
        </SubmitButton>
      </AuthForm>
    </AuthCard>
  );
}

function nextState(
  result: Exclude<MeetGuestJoinResult, { kind: "waiting" }>,
  media: MeetCallSession["media"],
): GuestState {
  switch (result.kind) {
    case "joined":
      return { status: "in_call", session: guestSession(result.join, media) };
    case "denied":
      return { status: "denied" };
    case "blocked":
      return { status: "blocked" };
    case "invalid":
      return { status: "invalid" };
    case "error":
      return { status: "form", error: result.message };
  }
}

export function guestSession(
  join: MeetGuestJoin,
  media: MeetCallSession["media"],
): MeetCallSession {
  return {
    roomId: join.roomId,
    roomName: join.roomName,
    subject: "Meeting",
    code: "",
    serverUrl:
      typeof join.serverUrl === "string" && join.serverUrl.length > 0 ? join.serverUrl : null,
    token: join.token,
    recordingAvailable: false,
    canStartRecording: false,
    recordingNoticeVersion: join.recordingNoticeVersion,
    recordingActive: join.recordingActive,
    controls: join.controls,
    canModerate: false,
    startedAtMs: Date.now(),
    media,
  };
}
