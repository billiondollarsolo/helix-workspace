/* The Helix brand mark — the DNA double helix — in one place.
 *
 * Three surfaces draw this mark: `HelixLogo` (the violet tile in the rail),
 * `Icons.Helix` (a currentColor glyph), and the favicon in `index.html`. Both
 * component files used to carry their own copy of the path data under a comment
 * promising that all three were "changed together". Two of them were in fact
 * identical; the favicon was a purple square containing a white letter F, left
 * over from a scaffold, and had never matched anything. Nothing failed, because
 * a comment is not an assertion.
 *
 * The components now render from the constants below, and
 * `helix-mark.test.ts` checks the favicon against them — so the promise is
 * enforced rather than merely written down. The favicon is necessarily still a
 * hand-encoded copy: `index.html` is static and cannot import from TypeScript.
 * The test is what closes that gap.
 */

/** The 11 stroked segments of the helix, on a 24×24 grid. */
export const HELIX_MARK_PATHS = [
  "m10 16 1.5 1.5",
  "m14 8-1.5-1.5",
  "M15 2c-1.798 1.998-2.518 3.995-2.807 5.993",
  "m16.5 10.5 1 1",
  "m17 6-2.891-2.891",
  "M2 15c6.667-6 13.333 0 20-6",
  "m20 9 .891.891",
  "M3.109 14.109 4 15",
  "m6.5 12.5 1 1",
  "m7 18 2.891 2.891",
  "M9 22c1.798-1.998 2.518-3.995 2.807-5.993",
] as const;

/** The tile gradient, in the colour space the mark was designed in. */
export const HELIX_MARK_GRADIENT_OKLCH = {
  from: "oklch(72% 0.18 290)",
  to: "oklch(50% 0.22 290)",
} as const;

/**
 * sRGB equivalents of the gradient stops.
 *
 * These are not naive channel clips: `oklch(72% 0.18 290)` falls outside sRGB,
 * and clipping per channel shifts its hue. They were produced by holding
 * lightness and hue and reducing chroma (0.18 → 0.157) until the colour fit,
 * which is why the light stop reads `#a491ff` rather than the `#a58dff` a clip
 * would give.
 */
export const HELIX_MARK_GRADIENT_SRGB = {
  from: "#a491ff",
  to: "#693ad4",
} as const;

/**
 * Favicon stroke colours.
 *
 * The favicon is the bare glyph — no tile — so it has no background of its own
 * and has to hold up against whatever the browser paints behind a tab. It
 * therefore cannot use `stroke="currentColor"` the way `Icons.Helix` does: a
 * favicon inherits no colour from anywhere and `currentColor` resolves to
 * black, which disappears against dark browser chrome.
 *
 * Two fixed colours instead, switched by a `prefers-color-scheme` rule embedded
 * in the SVG itself. `dark` is the gradient's light stop, so the mark stays
 * recognisably the same violet as the rail tile in both directions.
 */
export const HELIX_MARK_FAVICON_STROKE = {
  light: "#6d28d9",
  dark: HELIX_MARK_GRADIENT_SRGB.from,
} as const;

/** Lucide's own stroke weight for this glyph, and what `Icons.Helix` uses. */
export const HELIX_MARK_STROKE_WIDTH = 2;

/**
 * Geometry of the tile the helix sits on, shared so the favicon can reproduce
 * it exactly. The helix is a 24-unit glyph scaled to 62% and centred, leaving
 * even padding inside the 20-unit tile.
 */
export const HELIX_MARK_TILE = {
  rect: { x: 2, y: 2, size: 20, radius: 5 },
  glyphTransform: "translate(4.56 4.56) scale(0.62)",
  /** Scaled up to compensate for the 62% glyph, keeping the drawn weight near
   *  1.7px at 22px. Verified legible down to a 16px favicon; heavier weights
   *  merge the strokes into a blob at that size. */
  strokeWidth: 2.7,
} as const;
