/* MeetCallTile — a single participant tile in the in-call stage.
   Camera-on tiles render a radial-gradient avatar silhouette; camera-off tiles
   render a solid <Avatar>. The active speaker gets a 2px accent border + glow.
   The name pill (bottom-left) shows a mic-off icon when muted; a raised hand
   renders an amber badge top-right. */

import type { CSSProperties } from "react";
import { Icons } from "@/components/icons";
import { Avatar, hashIdx } from "@/components/ui/avatar";
import type { MeetCallParticipant } from "./meet-seed";

/* Silhouette gradient pairs — mirrors the handoff AVATAR_COLORS palette so a
   participant's camera-on tile glows in the same hue as their solid avatar. */
const SILHOUETTE_FALLBACK: readonly [string, string] = ["#7c3aed", "#a78bfa"];

const SILHOUETTE_COLORS: ReadonlyArray<readonly [string, string]> = [
  SILHOUETTE_FALLBACK,
  ["#0891b2", "#22d3ee"],
  ["#059669", "#34d399"],
  ["#dc2626", "#f87171"],
  ["#ea580c", "#fb923c"],
  ["#0284c7", "#38bdf8"],
  ["#9333ea", "#c084fc"],
  ["#65a30d", "#a3e635"],
  ["#db2777", "#f472b6"],
  ["#475569", "#94a3b8"],
];

export interface MeetCallTileProps {
  readonly participant: MeetCallParticipant;
  /** Speaker tile (16:9) vs. rail tile (4:3). */
  readonly big?: boolean;
}

export function MeetCallTile({ participant, big = false }: MeetCallTileProps) {
  const [c1, c2] =
    SILHOUETTE_COLORS[hashIdx(participant.name, SILHOUETTE_COLORS.length)] ??
    SILHOUETTE_FALLBACK;

  const tileStyle: CSSProperties = {
    position: "relative",
    background: participant.video ? "#000" : "#111",
    borderRadius: 8,
    overflow: "hidden",
    aspectRatio: big ? "16 / 9" : "4 / 3",
    border: participant.speaking
      ? "2px solid var(--accent)"
      : "2px solid transparent",
    boxShadow: participant.speaking
      ? "0 0 0 4px color-mix(in oklch, var(--accent) 30%, transparent)"
      : "none",
    transition: "border 0.15s",
  };

  return (
    <div style={tileStyle} data-speaking={participant.speaking || undefined}>
      {participant.video ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(circle at 30% 40%, ${c1}90, ${c2}40 60%, #000)`,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "55%",
              transform: "translate(-50%, -50%)",
              width: "30%",
              aspectRatio: "1",
              borderRadius: "50%",
              background: `radial-gradient(circle, ${c1}60, transparent 70%)`,
            }}
          />
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
          }}
        >
          <Avatar name={participant.name} size={big ? 80 : 56} />
        </div>
      )}

      <div
        style={{
          position: "absolute",
          left: 8,
          bottom: 8,
          background: "rgba(0,0,0,0.6)",
          color: "white",
          padding: "3px 8px",
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 500,
          display: "flex",
          alignItems: "center",
          gap: 6,
          backdropFilter: "blur(8px)",
        }}
      >
        {participant.muted ? (
          <Icons.MicOff size={12} aria-label="Muted" />
        ) : null}
        <span>
          {participant.name}
          {participant.you ? " (you)" : ""}
        </span>
      </div>

      {participant.hand ? (
        <div
          style={{
            position: "absolute",
            right: 8,
            top: 8,
            background: "#fbbf24",
            color: "#1c1917",
            borderRadius: 999,
            width: 26,
            height: 26,
            display: "grid",
            placeItems: "center",
          }}
          aria-label={`${participant.name} raised their hand`}
        >
          <Icons.Hand size={14} />
        </div>
      ) : null}
    </div>
  );
}
