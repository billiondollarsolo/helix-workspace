/* The Helix Workspace mark — a twisted W — in one place.
 *
 * The shape comes from the Helix letter system in `docs/brand/` (H = Helix,
 * W = Workspace, A = Agentspace). Copy changes from `docs/brand/glyphs/W.svg`;
 * do not redraw it here.
 *
 * Two surfaces draw this mark: `HelixLogo` (the violet tile in the rail, the
 * landing page and the help menu) and the favicon in `index.html`. The
 * component renders from the constants below, and `helix-mark.test.ts` checks
 * the favicon against them. The favicon is necessarily a hand-encoded copy:
 * `index.html` is static and cannot import from TypeScript.
 */

/** Side of the square grid the paths are drawn on. */
export const HELIX_MARK_GRID = 64;

/** The stroked segments of the W: two stems and the two strands of the twist. */
export const HELIX_MARK_PATHS = [
  "M20 14V50M44 14V50",
  "M20 50C28.7 50 35.3 30 44 30",
  "M20 30C28.7 30 35.3 50 44 50",
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
 * lightness and hue and reducing chroma until the colour fit, which is why the
 * light stop reads `#a491ff` rather than the `#a58dff` a clip would give.
 */
const HELIX_MARK_GRADIENT_SRGB = {
  from: "#a491ff",
  to: "#693ad4",
} as const;

/**
 * Favicon stroke colours.
 *
 * The favicon is the bare glyph — no tile — so it has to hold up against
 * whatever the browser paints behind a tab. `currentColor` would resolve to
 * black and vanish against dark browser chrome, so it uses two fixed colours
 * switched by a `prefers-color-scheme` rule inside the SVG. `dark` is the
 * gradient's light stop, so the mark stays the same violet as the rail tile.
 */
export const HELIX_MARK_FAVICON_STROKE = {
  light: "#6d28d9",
  dark: HELIX_MARK_GRADIENT_SRGB.from,
} as const;

/** Stroke weight on the 64-unit grid, as in `docs/brand/`. */
export const HELIX_MARK_STROKE_WIDTH = 4.5;

/** The tile behind the mark: the full grid, rounded, with the W scaled to 80%. */
export const HELIX_MARK_TILE = {
  rect: { x: 0, y: 0, size: 64, radius: 15 },
  glyphTransform: "translate(6.4 6.4) scale(0.8)",
  strokeWidth: HELIX_MARK_STROKE_WIDTH,
} as const;
