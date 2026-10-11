/* Avatar — deterministic label colour + initials from a name.
   No external image fetch: every avatar is a label-palette token with
   up-to-two initials in `--label-on`, readable in light and dark. */

import type { CSSProperties } from "react";

/** Label-palette names; each fill keeps 4.5:1 with `--label-on`. */
const AVATAR_COLORS: readonly string[] = [
  "violet",
  "cyan",
  "emerald",
  "red",
  "orange",
  "sky",
  "purple",
  "lime",
  "pink",
  "slate",
];

/** Deterministic, stable hash → index in [0, mod). Shared utility. */
function hashIdx(value: string, mod: number): number {
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
  /** Display name — drives both the colour and the initials. */
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
  const color = AVATAR_COLORS[hashIdx(name, AVATAR_COLORS.length)] ?? "violet";

  const style: CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.max(9, Math.round(size * 0.42)),
    background: src ? `center / cover no-repeat url("${src}")` : `var(--label-${color})`,
  };

  return (
    <div
      className={className ? `avatar ${className}` : "avatar"}
      style={style}
      role="img"
      /* `role="img"` with no name announces as an unlabelled image, which is
         worse than no role at all. `alt ?? name` was undefined whenever a
         caller passed neither — the case axe flagged. The fallback is generic
         on purpose: it is honest about being a placeholder rather than
         inventing an identity for whoever this depicts. */
      /* `||`, not `??`: `name` defaults to `""`, which is not nullish, so a
         nullish fallback never fires and the label stays empty — an empty
         aria-label is no accessible name at all, which is the defect. */
      aria-label={alt || name || "User avatar"}
    >
      {src ? null : initials}
    </div>
  );
}
