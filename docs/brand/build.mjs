#!/usr/bin/env node
// Generates the Helix letter marks: one-colour glyphs, coloured tiles and a preview page.
// Run from anywhere: `node docs/brand/build.mjs`. Edit the shapes in LETTERS, then re-run.
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = new URL("./", import.meta.url);
const STROKE = 4.5;
const SAMPLES = 80;

// Centerlines map t in [0, 1] to a point on a 64x64 grid (caps run from y 14 to y 50).
const line = (x0, y0, x1, y1) =>
  Object.assign((t) => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t], { straight: true });
const arc = (cx, cy, r, a0, a1) => (t) => {
  const a = ((a0 + (a1 - a0) * t) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
const round = (n) => Math.round(n * 10) / 10;
// Where a cubic's handles sit (as a share of each half-turn) so it matches a cosine's slope.
const HANDLE = 1 - 2 / Math.PI;
const VERTICAL = [0, 1];
const HORIZONTAL = [1, 0];

/** A plain stroke. */
const s = (d) => [d];

/**
 * One helix: two strands around centerline `c` that start apart and cross `n` times, so
 * both ends stay open. `a` is the distance of each strand from the centerline (`a1`
 * tapers it towards the end). `normal` fixes the offset direction; without it the
 * strands move perpendicular to the centerline.
 */
function hx(c, { a = 5, a1, n = 2, normal } = {}) {
  const amp = (t) => a + ((a1 ?? a) - a) * t;
  const perpendicular = (t) => {
    if (normal) return normal;
    const e = 0.003;
    const p = c(Math.max(t - e, 0));
    const q = c(Math.min(t + e, 1));
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    return [-(q[1] - p[1]) / l, (q[0] - p[0]) / l];
  };
  const at = (t, o) => {
    const [x, y] = c(t);
    const [nx, ny] = perpendicular(t);
    return `${round(x + nx * o)} ${round(y + ny * o)}`;
  };
  // A straight centerline with a fixed offset needs only one cubic per half-turn.
  const curves = (sign) => {
    let d = `M${at(0, sign * a)}`;
    for (let k = 0; k < n; k++) {
      const t0 = k / n;
      const t1 = (k + 1) / n;
      const o0 = sign * a * Math.cos(Math.PI * k);
      const o1 = -o0;
      const h = HANDLE * (t1 - t0);
      d += `C${at(t0 + h, o0)} ${at(t1 - h, o1)} ${at(t1, o1)}`;
    }
    return d;
  };
  if (c.straight && normal && a1 === undefined) return [curves(1), curves(-1)];
  const strand = (sign) => {
    let d = "";
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const [x, y] = c(t);
      const [nx, ny] = perpendicular(t);
      const o = sign * amp(t) * Math.cos(Math.PI * n * t);
      d += `${i ? "L" : "M"}${round(x + nx * o)} ${round(y + ny * o)}`;
    }
    return d;
  };
  return [strand(1), strand(-1)];
}

const ring = hx(arc(32, 32, 16, -90, 270), { n: 4, a: 5.5 });
/** A twisted stem centred on x; its right strand starts at x + 5.5. */
const stem = (x) => hx(line(x, 14, x, 50), { a: 5.5, normal: HORIZONTAL });
const bar = (x0, x1, y, a) => hx(line(x0, y, x1, y), { n: 1, a, normal: VERTICAL });

/** Every letter: plain strokes plus exactly one helix whose open ends land on a stroke. */
const LETTERS = {
  A: [...s("M19 50 32 14 45 50"), ...bar(23.3, 40.7, 38, 6)],
  B: [...stem(18), ...s("M23.5 14H31A9 9 0 0 1 31 32H23.5M23.5 32H33A9 9 0 0 1 33 50H23.5")],
  C: [...s("M44.7 19.3A18 18 0 1 0 44.7 44.7"), ...bar(15, 38, 32, 6)],
  D: [...stem(17), ...s("M22.5 14H27A18 18 0 0 1 27 50H22.5")],
  E: [...s("M42 14H20V50H42"), ...bar(20, 40, 32, 7)],
  F: [...s("M44 14H20V50"), ...bar(20, 40, 32, 7)],
  G: [...s("M44.7 19.3A18 18 0 1 0 49.6 36"), ...bar(32, 49.6, 32, 4)],
  H: [...s("M20 14V50M44 14V50"), ...bar(20, 44, 32, 6)],
  I: [...s("M22 14H42M22 50H42"), ...hx(line(32, 14, 32, 50), { a: 6.5, normal: HORIZONTAL })],
  J: [
    ...hx(line(38, 14, 38, 40), { a: 5.5, normal: HORIZONTAL }),
    ...s("M43.5 40A10.75 10.75 0 0 1 22 40"),
  ],
  K: [...s("M20 14V50"), ...hx(line(22, 32, 44, 32), { n: 1, a: 6, a1: 18, normal: VERTICAL })],
  L: [...stem(21), ...s("M15.5 50H46")],
  M: [...s("M20 50V14M44 50V14"), ...bar(20, 44, 24, 10)],
  N: [...s("M20 50V14M44 50V14"), ...hx(line(20, 24, 44, 40), { n: 1, a: 10, normal: VERTICAL })],
  O: ring,
  P: [...stem(18), ...s("M23.5 14H32A9 9 0 0 1 32 32H23.5")],
  Q: [...ring, ...s("M42 42 53 53")],
  R: [...stem(18), ...s("M23.5 14H32A9 9 0 0 1 32 32H23.5M30 32 44 50")],
  S: [
    ...s("M44 18C41 12 24 11 22 22"),
    ...hx(line(32, 22, 32, 42), { n: 1, a: 10, normal: HORIZONTAL }),
    ...s("M42 42C42 53 25 53 20 46"),
  ],
  T: [...s("M16 14H48"), ...hx(line(32, 14, 32, 50), { a: 6.5, normal: HORIZONTAL })],
  U: [...s("M20 14V34A12 12 0 0 0 44 34V14"), ...bar(20, 44, 28, 6)],
  V: [...s("M14 14 32 50 50 14"), ...bar(21, 43, 28, 6)],
  W: [...s("M20 14V50M44 14V50"), ...bar(20, 44, 40, 10)],
  X: hx(line(32, 14, 32, 50), { n: 1, a: 14, normal: HORIZONTAL }),
  Y: [
    ...s("M18 14 26.5 30M46 14 37.5 30"),
    ...hx(line(32, 30, 32, 50), { n: 1, a: 5.5, normal: HORIZONTAL }),
  ],
  Z: [...s("M18 14H46M18 50H46"), ...hx(line(40.5, 14, 23.5, 50), { a: 5.5, normal: HORIZONTAL })],
};

// Tile hues (OKLCH). H/W keep today's Helix violet and A is Agentspace teal; the rest are
// placeholders spread around the wheel until a product claims the letter.
const ASSIGNED = { H: 290, W: 290, A: 185 };
const hue = (letter, i) => ASSIGNED[letter] ?? Math.round((290 + (i * 360) / 26) % 360);

/**
 * OKLCH to sRGB hex, lowering chroma until the colour fits sRGB so the hue holds. Tiles
 * use hex because favicons, push icons and older renderers do not all read oklch().
 * The stops match the Workspace app tile (`helix-mark.ts`): 72% / 0.18 to 50% / 0.22.
 */
function oklchHex(L, C, h) {
  const toSrgb = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  for (let c = C; c >= 0; c -= 0.001) {
    const a = c * Math.cos((h * Math.PI) / 180);
    const b = c * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const k = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * k,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * k,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * k,
    ];
    if (rgb.every((v) => v >= -0.0005 && v <= 1.0005)) {
      return `#${rgb
        .map((v) =>
          Math.round(toSrgb(Math.min(Math.max(v, 0), 1)) * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`;
    }
  }
  return "#000000";
}

const paths = (ds, color) =>
  ds
    .map(
      (d) =>
        `<path d="${d}" fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("");

const glyph = (letter, ds) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Helix ${letter}">${paths(ds, "currentColor")}</svg>\n`;

const tile = (letter, ds, h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Helix ${letter}">` +
  `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="64" y2="64">` +
  `<stop offset="0" stop-color="${oklchHex(0.72, 0.18, h)}"/><stop offset="1" stop-color="${oklchHex(0.5, 0.22, h)}"/>` +
  `</linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#g)"/>` +
  `<g transform="translate(32 32) scale(.8) translate(-32 -32)">${paths(ds, "#fff")}</g></svg>\n`;

mkdirSync(new URL("glyphs/", OUT), { recursive: true });
mkdirSync(new URL("tiles/", OUT), { recursive: true });
Object.entries(LETTERS).forEach(([letter, ds], i) => {
  writeFileSync(new URL(`glyphs/${letter}.svg`, OUT), glyph(letter, ds));
  writeFileSync(new URL(`tiles/${letter}.svg`, OUT), tile(letter, ds, hue(letter, i)));
});

const cards = Object.keys(LETTERS)
  .map(
    (l) =>
      `<figure><img src="tiles/${l}.svg" width="72" height="72" alt="${l} tile"><img class="g" src="glyphs/${l}.svg" width="32" height="32" alt="${l} glyph"><figcaption>${l}</figcaption></figure>`,
  )
  .join("\n");
const strip = (px) =>
  Object.keys(LETTERS)
    .map((l) => `<img src="tiles/${l}.svg" width="${px}" height="${px}" alt="">`)
    .join("");

writeFileSync(
  new URL("index.html", OUT),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Helix letter marks</title>
<style>
body{margin:32px;font:14px/1.5 system-ui,sans-serif;color:#16141f;background:#f6f5fa}
@media (prefers-color-scheme:dark){body{color:#ecebf3;background:#0e0d14}.g{filter:invert(1)}}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px}
figure{margin:0;display:flex;align-items:center;gap:10px;padding:12px;border:1px solid #8884;border-radius:14px}
figcaption{opacity:.6}.strip{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
</style>
</head>
<body>
<h1>Helix letter marks</h1>
<p>Generated by <code>build.mjs</code>. See <code>README.md</code> for the rules.</p>
<div class="grid">
${cards}
</div>
<div class="strip">${strip(24)}</div>
<div class="strip">${strip(16)}</div>
</body>
</html>
`,
);
console.log(`Wrote ${Object.keys(LETTERS).length} glyphs, tiles and index.html`);
