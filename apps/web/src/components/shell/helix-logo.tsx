/* Helix logo — the DNA double-helix mark on a rounded violet-gradient tile.
 *
 * The tile stays: this sits in the always-dark rail, where a bare
 * currentColor stroke would read as one more nav glyph rather than the product
 * mark. The helix itself is drawn in white on the gradient.
 *
 * Path data, tile geometry and gradient come from `./helix-mark`, which
 * `Icons.Helix` and the `index.html` favicon also follow. See that file for why
 * they are shared rather than copied. */

import { HELIX_MARK_GRADIENT_OKLCH, HELIX_MARK_PATHS, HELIX_MARK_TILE } from "./helix-mark";

export interface HelixLogoProps {
  size?: number;
}

export function HelixLogo({ size = 22 }: HelixLogoProps) {
  const { rect, glyphTransform, strokeWidth } = HELIX_MARK_TILE;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Helix">
      <defs>
        {/* `gradientUnits="userSpaceOnUse"` is load-bearing. Without it these
            coordinates are read as objectBoundingBox *fractions* (0–1), so
            x2/y2 of 24 put the gradient vector 24× outside the tile and only
            the first sliver of the ramp landed on it — the mark rendered as a
            near-flat light violet, never reaching the dark stop. */}
        <linearGradient id="hx-grad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0" stopColor={HELIX_MARK_GRADIENT_OKLCH.from} />
          <stop offset="1" stopColor={HELIX_MARK_GRADIENT_OKLCH.to} />
        </linearGradient>
      </defs>
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.size}
        height={rect.size}
        rx={rect.radius}
        fill="url(#hx-grad)"
      />
      <g
        transform={glyphTransform}
        stroke="#fff"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {HELIX_MARK_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}
