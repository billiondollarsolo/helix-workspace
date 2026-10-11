/* MeetShell — the Meet surface root: the hub, the pre-join screen, or the
   full-bleed call. `/meet?code=…` (Calendar's Join link) opens the pre-join
   screen for that meeting directly. */

import { SurfaceFrame } from "@/components/shell";
import { useQuery } from "@tanstack/react-query";
import { Video as VideoIcon } from "lucide-react";
import { useState } from "react";
import type { MeetControlState } from "./api";
import type { JitsiInitialMedia } from "./jitsi-external-api";
import { MeetCall } from "./meet-call";
import { MeetHub } from "./meet-hub";
import type { MeetJoinTarget } from "./meet-join";
import { MeetPreJoin } from "./meet-prejoin";
import { conferenceFromMetadata } from "@/features/calendar/conference";
import { meetMeetingsQueryOptions, meetTodayEventsQueryOptions } from "./queries";

/** An active call session — a real backend room plus its minted join token. */
export interface MeetCallSession {
  readonly roomId: string;
  readonly roomName: string;
  readonly subject: string;
  readonly code: string;
  readonly jitsiDomain: string;
  /** Minted Jitsi JWT for the embed; null when joining offline-fallback. */
  readonly token: string | null;
  /** Full Jitsi join URL (with `?jwt=`), when minted. */
  readonly joinUrl: string | null;
  /** Live Jibri readiness sampled when the join token was minted. */
  readonly recordingAvailable: boolean;
  /** Server-proven moderator capability; participants never receive a start control. */
  readonly canStartRecording: boolean;
  /** Recording disclosure version accepted before this join token was issued. */
  readonly recordingNoticeVersion: string;
  /** Authoritative server state used to warn late joiners before Jitsi emits an event. */
  readonly recordingActive: boolean;
  readonly controls: MeetControlState;
  readonly canModerate: boolean;
  /** Wall-clock start (epoch ms) for the elapsed timer. */
  readonly startedAtMs: number;
  /** Microphone, camera and devices chosen on the pre-join screen. */
  readonly media: JitsiInitialMedia;
}

export interface MeetShellProps {
  /** Meeting code from the URL; opens its pre-join screen. */
  readonly code?: string | undefined;
  readonly onCodeChange: (code: string | undefined) => void;
  /** Opens the Calendar event editor with video conferencing added. */
  readonly onScheduleInCalendar: () => void;
}

export function MeetShell({ code, onCodeChange, onScheduleInCalendar }: MeetShellProps) {
  const [session, setSession] = useState<MeetCallSession | null>(null);
  const [starting, setStarting] = useState(false);
  const meetings = useQuery(meetMeetingsQueryOptions()).data;
  const events = useQuery(meetTodayEventsQueryOptions()).data;

  const backToHub = () => {
    setSession(null);
    setStarting(false);
    if (code !== undefined) onCodeChange(undefined);
  };

  if (session !== null) {
    return <MeetCall session={session} onLeave={backToHub} />;
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
          onJoined={setSession}
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
