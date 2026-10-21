/* MeetVideoGrid — the LiveKit media stage: one tile per participant camera
   (or their avatar while the camera is off) plus screen shares, with name
   labels, muted and raised-hand indicators and an active-speaker ring. A
   screen share, or the active speaker in speaker layout, is featured with
   the other tiles in a strip. Remote audio plays through hidden elements and
   joins/leaves are announced politely to screen readers. */

import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { Hand as HandIcon, MicOff as MicOffIcon, Volume2 as AudioIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Track } from "livekit-client";
import type { MeetMediaTile, MeetMediaView } from "./livekit-call";

export interface MeetVideoGridProps {
  readonly media: MeetMediaView;
  readonly activeSpeakerId: string | null;
  /** Equal tiles when true; otherwise the active speaker is featured. */
  readonly tileView: boolean;
  readonly label: string;
  readonly onStartAudio: () => void;
}

export function MeetVideoGrid({
  media,
  activeSpeakerId,
  tileView,
  label,
  onStartAudio,
}: MeetVideoGridProps) {
  const featured = featuredTile(media.tiles, activeSpeakerId, tileView);
  const others = featured === null ? media.tiles : media.tiles.filter((tile) => tile !== featured);
  const announcement = useJoinLeaveAnnouncement(media.tiles);

  return (
    <section aria-label={label} className="absolute inset-0 flex flex-col gap-2 p-2">
      {featured !== null ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 md:flex-row">
          <ul className="m-0 flex min-h-0 min-w-0 flex-1 p-0 [list-style:none]">
            <MediaTile tile={featured} activeSpeakerId={activeSpeakerId} featured />
          </ul>
          {others.length > 0 ? (
            <ul
              aria-label="Other participants"
              className="m-0 grid shrink-0 auto-rows-[120px] grid-flow-col gap-2 overflow-x-auto p-0 [list-style:none] md:w-56 md:grid-flow-row md:overflow-x-hidden md:overflow-y-auto"
            >
              {others.map((tile) => (
                <MediaTile key={tile.key} tile={tile} activeSpeakerId={activeSpeakerId} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <ul className="m-0 grid min-h-0 flex-1 auto-rows-fr gap-2 p-0 [list-style:none] [grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))]">
          {media.tiles.map((tile) => (
            <MediaTile key={tile.key} tile={tile} activeSpeakerId={activeSpeakerId} />
          ))}
        </ul>
      )}

      {media.audioTracks.map((audio) => (
        <TrackAudio key={audio.key} track={audio.track} />
      ))}
      {media.audioPlaybackBlocked ? (
        <div className="absolute inset-x-0 bottom-4 flex justify-center">
          <button type="button" className="btn" onClick={onStartAudio}>
            <AudioIcon size={16} aria-hidden="true" /> Turn on call audio
          </button>
        </div>
      ) : null}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </section>
  );
}

/** A screen share always leads; in speaker layout the active speaker does. */
export function featuredTile(
  tiles: readonly MeetMediaTile[],
  activeSpeakerId: string | null,
  tileView: boolean,
): MeetMediaTile | null {
  const screen =
    tiles.find((tile) => tile.isScreenShare && !tile.isLocal) ??
    tiles.find((tile) => tile.isScreenShare);
  if (screen !== undefined) return screen;
  if (tileView || tiles.length < 2) return null;
  return (
    tiles.find((tile) => tile.participantId === activeSpeakerId && !tile.isLocal) ??
    tiles.find((tile) => !tile.isLocal) ??
    null
  );
}

function MediaTile({
  tile,
  activeSpeakerId,
  featured = false,
}: {
  readonly tile: MeetMediaTile;
  readonly activeSpeakerId: string | null;
  readonly featured?: boolean;
}) {
  const name = `${tile.name}${tile.isLocal ? " (you)" : ""}`;
  const label = tile.isScreenShare ? `${name}, screen` : name;
  const speaking = !tile.isScreenShare && (tile.speaking || tile.participantId === activeSpeakerId);
  return (
    <li
      aria-label={label}
      className={cn(
        "relative min-h-0 min-w-0 overflow-hidden rounded-lg bg-[var(--surface-3)]",
        featured ? "flex-1" : "",
        speaking ? "[box-shadow:0_0_0_2px_var(--accent)]" : "",
      )}
    >
      {tile.videoTrack !== null ? (
        <TrackVideo
          track={tile.videoTrack}
          mirrored={tile.isLocal && !tile.isScreenShare}
          contain={tile.isScreenShare}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <Avatar name={tile.name} size={featured ? 72 : 48} />
        </div>
      )}
      <span className="absolute bottom-2 left-2 flex max-w-[calc(100%-16px)] items-center gap-1.5 rounded-md bg-[color-mix(in_srgb,var(--bg)_80%,transparent)] px-2 py-0.5 type-meta text-[var(--text)]">
        {tile.audioMuted && !tile.isScreenShare ? (
          <MicOffIcon size={14} aria-hidden="true" className="shrink-0 text-[var(--danger)]" />
        ) : null}
        {tile.handRaised && !tile.isScreenShare ? (
          <HandIcon size={14} aria-hidden="true" className="shrink-0 text-[var(--accent)]" />
        ) : null}
        <span className="truncate">{label}</span>
        {tile.audioMuted && !tile.isScreenShare ? (
          <span className="sr-only">, microphone off</span>
        ) : null}
        {tile.handRaised && !tile.isScreenShare ? (
          <span className="sr-only">, hand raised</span>
        ) : null}
      </span>
    </li>
  );
}

function TrackVideo({
  track,
  mirrored,
  contain,
}: {
  readonly track: Track;
  readonly mirrored: boolean;
  readonly contain: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      aria-hidden="true"
      className={cn(
        "absolute inset-0 h-full w-full",
        contain ? "object-contain" : "object-cover",
        mirrored ? "[transform:scaleX(-1)]" : "",
      )}
    />
  );
}

function TrackAudio({ track }: { readonly track: Track }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);
  return <audio ref={ref} autoPlay className="hidden" />;
}

/** Announces remote participants joining and leaving, by name. */
function useJoinLeaveAnnouncement(tiles: readonly MeetMediaTile[]): string {
  const [announcement, setAnnouncement] = useState("");
  const previousRef = useRef<ReadonlyMap<string, string> | null>(null);
  const people = new Map(
    tiles
      .filter((tile) => !tile.isLocal && !tile.isScreenShare)
      .map((tile) => [tile.participantId, tile.name]),
  );
  const inCall = tiles.some((tile) => tile.isLocal);
  const signature = `${String(inCall)}\n${[...people.keys()].join("\n")}`;

  useEffect(() => {
    if (!inCall) {
      previousRef.current = null;
      return;
    }
    const previous = previousRef.current;
    previousRef.current = people;
    // The first snapshot is who was already here, not news.
    if (previous === null) return;
    const joined = [...people].filter(([id]) => !previous.has(id)).map(([, name]) => name);
    const left = [...previous].filter(([id]) => !people.has(id)).map(([, name]) => name);
    const parts = [
      ...joined.map((name) => `${name} joined`),
      ...left.map((name) => `${name} left`),
    ];
    if (parts.length > 0) setAnnouncement(parts.join(". "));
    // `people` is rebuilt every render; the id signature is the real input.
  }, [signature]);

  return announcement;
}
