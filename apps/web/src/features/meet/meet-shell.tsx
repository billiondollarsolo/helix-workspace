/* MeetShell — the Meet surface root: the hub, the pre-join screen, or the
   full-bleed call. `/meet?code=…` (Calendar's Join link) opens the pre-join
   screen for that meeting directly. */

import { SurfaceFrame } from "@/components/shell";
import { EmptyState } from "@/components/ui/empty-state";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { VideoOff, Video as VideoIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { MeetControlState } from "./api";
import type { MeetInitialMedia } from "./meet-call-controls";
import { MeetHub } from "./meet-hub";
import type { MeetJoinTarget } from "./meet-join";
import { MeetPreJoin } from "./meet-prejoin";
import { conferenceFromMetadata } from "@/features/calendar/conference";
import {
  meetMeetingsQueryOptions,
  meetQueryKeys,
  meetStatusQueryOptions,
  meetTodayEventsQueryOptions,
} from "./queries";

/** An active call session — a real backend room plus its minted join token. */
export interface MeetCallSession {
  readonly roomId: string;
  readonly roomName: string;
  readonly subject: string;
  readonly code: string;
  /** Bare LiveKit websocket origin; null when the server returned none. */
  readonly serverUrl: string | null;
  /** LiveKit access token; null until one was minted. */
  readonly token: string | null;
  /** Recorder readiness sampled when the join token was minted. */
  readonly recordingAvailable: boolean;
  /** Server-proven moderator capability; participants never receive a start control. */
  readonly canStartRecording: boolean;
  /** Recording disclosure version accepted before this join token was issued. */
  readonly recordingNoticeVersion: string;
  /** Authoritative server state used to warn late joiners as soon as they join. */
  readonly recordingActive: boolean;
  /** Hosts/co-hosts only: transcription can be turned on. Missing means false. */
  readonly transcriptionAvailable?: boolean;
  /** Transcription was on when the token was minted. Missing means false. */
  readonly transcriptionActive?: boolean;
  readonly controls: MeetControlState;
  readonly canModerate: boolean;
  /** Wall-clock start (epoch ms) for the elapsed timer. */
  readonly startedAtMs: number;
  /** Microphone, camera and devices chosen on the pre-join screen. */
  readonly media: MeetInitialMedia;
}

/* The call view carries the LiveKit client; load it only when joining. */
const MeetCall = lazy(() => import("./meet-call").then((module) => ({ default: module.MeetCall })));

export interface MeetShellProps {
  /** Meeting code from the URL; opens its pre-join screen. */
  readonly code?: string | undefined;
  readonly onCodeChange: (code: string | undefined) => void;
  /** Opens the Calendar event editor with video conferencing added. */
  readonly onScheduleInCalendar: () => void;
}

export function MeetShell({ code, onCodeChange, onScheduleInCalendar }: MeetShellProps) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<MeetCallSession | null>(null);
  const [starting, setStarting] = useState(false);
  const status = useQuery(meetStatusQueryOptions()).data;
  const meetings = useQuery(meetMeetingsQueryOptions()).data;
  const events = useQuery(meetTodayEventsQueryOptions()).data;

  const backToHub = () => {
    setSession(null);
    setStarting(false);
    void queryClient.invalidateQueries({ queryKey: meetQueryKeys.all });
    if (code !== undefined) onCodeChange(undefined);
  };

  if (session !== null) {
    return (
      <Suspense
        fallback={
          <div role="status" className="flex-1 grid place-items-center type-body-sm">
            Opening the meeting…
          </div>
        }
      >
        <MeetCall session={session} onLeave={backToHub} />
      </Suspense>
    );
  }

  if (status?.available === false) {
    return (
      <SurfaceFrame title="Meet" icon={<VideoIcon size={16} />}>
        <div role="status">
          <EmptyState
            icon={<VideoOff />}
            title="Meet is unavailable"
            body={
              status.message ??
              "Video meetings aren't set up for this workspace yet. Ask your administrator."
            }
          />
        </div>
      </SurfaceFrame>
    );
  }

  const target: MeetJoinTarget | null =
    code !== undefined
      ? {
          kind: "code",
          code,
          title:
            meetings?.meetings.find((meeting) => meeting.code === code)?.title ??
            events?.find((event) => conferenceFromMetadata(event.metadata)?.joinCode === code)
              ?.title ??
            null,
        }
      : starting
        ? { kind: "start", subject: "Instant meeting" }
        : null;

  return (
    <SurfaceFrame title="Meet" icon={<VideoIcon size={16} />}>
      {target !== null ? (
        <MeetPreJoin
          key={target.kind === "code" ? target.code : target.kind}
          target={target}
          onJoined={(joined) => {
            setSession(joined);
            setStarting(false);
            if (code !== joined.code) onCodeChange(joined.code);
          }}
          onCancel={backToHub}
        />
      ) : (
        <MeetHub
          onStartInstant={() => {
            setStarting(true);
          }}
          onOpenCode={onCodeChange}
          onScheduleInCalendar={onScheduleInCalendar}
        />
      )}
    </SurfaceFrame>
  );
}
