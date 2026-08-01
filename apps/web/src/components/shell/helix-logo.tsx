/* Helix logo — the DNA double-helix mark on a rounded violet-gradient tile.
 *
 * The tile stays: this sits in the always-dark rail, where a bare
 * currentColor stroke would read as one more nav glyph rather than the product
 * mark. The helix itself is drawn in white on the gradient.
 *
 * Path data is shared with `Icons.Helix` and the `index.html` favicon — change
 * all three together. */

export interface HelixLogoProps {
  size?: number;
}

export function HelixLogo({ size = 22 }: HelixLogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Helix">
      <defs>
        <linearGradient id="hx-grad" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0" stopColor="oklch(72% 0.18 290)" />
          <stop offset="1" stopColor="oklch(50% 0.22 290)" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="5" fill="url(#hx-grad)" />
      {/* The helix is a 24-unit glyph; scale it to 62% and centre it so it sits
          inside the 20-unit tile with even padding. Stroke width is scaled up
          to compensate, keeping the drawn weight near 1.7px at 22px. */}
      <g
        transform="translate(4.56 4.56) scale(0.62)"
        stroke="#fff"
        strokeWidth="2.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m10 16 1.5 1.5" />
        <path d="m14 8-1.5-1.5" />
        <path d="M15 2c-1.798 1.998-2.518 3.995-2.807 5.993" />
        <path d="m16.5 10.5 1 1" />
        <path d="m17 6-2.891-2.891" />
        <path d="M2 15c6.667-6 13.333 0 20-6" />
        <path d="m20 9 .891.891" />
        <path d="M3.109 14.109 4 15" />
        <path d="m6.5 12.5 1 1" />
        <path d="m7 18 2.891 2.891" />
        <path d="M9 22c1.798-1.998 2.518-3.995 2.807-5.993" />
      </g>
    </svg>
  );
}
