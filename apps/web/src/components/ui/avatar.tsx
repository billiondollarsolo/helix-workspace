/* Avatar — deterministic gradient + initials from a name.
   Ported from the design handoff (components.jsx). No external image fetch:
   every avatar is a CSS gradient with up-to-two initials. */

import type { CSSProperties } from "react";

/** Stable, branded avatar gradient pairs. */
const AVATAR_COLORS: ReadonlyArray<readonly [string, string]> = [
  ["#7c3aed", "#a78bfa"],
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

/** Deterministic, stable hash → index in [0, mod). Shared utility. */
export function hashIdx(value: string, mod: number): number {
  let h = 0;
  const s = value || "";
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % mod;
}

function initialsFromName(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

export interface AvatarProps {
  /** Display name — drives both the gradient and the initials. */
  name?: string;
  /** Diameter in pixels. Defaults to 22. */
  size?: number;
  /** Optional image URL. When set, the photo replaces the initials. */
  src?: string;
  /** Optional alt text for the photo (defaults to the name). */
  alt?: string;
  className?: string;
}

export function Avatar({ name = "", size = 22, src, alt, className }: AvatarProps) {
  const initials = initialsFromName(name);
  const [c1, c2] = AVATAR_COLORS[hashIdx(name, AVATAR_COLORS.length)] ?? [
    "#7c3aed",
    "#a78bfa",
  ];

  const style: CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.max(9, Math.round(size * 0.42)),
    background: src
      ? `center / cover no-repeat url("${src}")`
      : `linear-gradient(135deg, ${c1}, ${c2})`,
  };

  return (
    <div
      className={className ? `avatar ${className}` : "avatar"}
      style={style}
      role="img"
      aria-label={alt ?? name}
    >
      {src ? null : initials}
    </div>
  );
}
