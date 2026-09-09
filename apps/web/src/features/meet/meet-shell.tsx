/* MeetShell — the Meet surface root. Renders the Hub inside the standard
   <SurfaceFrame> chrome, or the dark-themed in-call view (full-bleed, no
   chrome) once a meeting is started or joined. The in-call view is wired to a
   real backend room: a room id + minted Jitsi token carried through here. */

import { useState } from "react";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { MeetHub } from "./meet-hub";
import { MeetCall } from "./meet-call";
import type { MeetControlState } from "./api";

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
}

export function MeetShell() {
  const [session, setSession] = useState<MeetCallSession | null>(null);
  const [search, setSearch] = useState("");

  if (session !== null) {
    return (
      <MeetCall
        session={session}
        onLeave={() => {
          setSession(null);
        }}
      />
    );
  }

  return (
    <SurfaceFrame
      title="Meet"
      icon={<Icons.Video />}
      searchPlaceholder="Search meetings"
      searchValue={search}
      onSearchChange={setSearch}
    >
      <h1 className="sr-only">Meet</h1>
      <MeetHub search={search} onEnterCall={setSession} />
    </SurfaceFrame>
  );
}
