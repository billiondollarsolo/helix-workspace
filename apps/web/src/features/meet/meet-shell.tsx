/* MeetShell — the Meet surface root. Renders the Hub inside the standard
   <SurfaceFrame> chrome, or the dark-themed in-call view (full-bleed, no
   chrome) once a meeting is started or joined. The in-call view is wired to a
   real backend room: a room id + minted Jitsi token carried through here. */

import { useState } from "react";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { MeetHub } from "./meet-hub";
import { MeetCall } from "./meet-call";

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
      <MeetHub search={search} onEnterCall={setSession} />
    </SurfaceFrame>
  );
}
