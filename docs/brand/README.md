# Helix letter marks

A logo system for the Helix product family. Every product gets a letter, drawn with the
same rule, on the same rounded tile, in its own colour.

- **H**: Helix, the parent brand (website, docs, sign-in).
- **W**: Helix Workspace.
- **A**: Helix Agentspace (formerly Helix Bot). Its repository folder is `helix-agentspace`.
- Any future product takes its own letter.

Open `index.html` in a browser to see all 26 letters.

## The rule

Each letter is plain strokes plus **exactly one helix**: two strands that start apart, cross,
and leave open space inside every loop.

1. **The ends stay open.** Strands never pinch together to a point. They always land on
   another stroke: a stem, a bar, a bowl or a curve.
2. **The helix replaces the stroke that ties the letter together.**
   - Crossbar letters twist the crossbar: A, C, E, F, G, H, K, M, N, U, V and W. V is an
     upside-down A, and W is an upside-down M.
   - Stem letters twist the stem: B, D, I, J, L, P, R, T and Y.
   - S twists its middle. Z twists its diagonal between the two bars. X is two crossing
     strands.
   - O and Q are a twisted ring, which has no ends.
3. **Open space must show** at the sizes the mark is used. Keep the strand offset at 4 or
   more on the 64-unit grid (about one stroke width of gap).

Weakest letters: C (the bar makes it look a bit like a €), X and Y (short stem). Avoid them
for a main product mark if you can.

## Files

| Path             | What                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------- |
| `glyphs/<L>.svg` | One-colour mark, `currentColor` stroke. Use for icons, monochrome print and favicons. |
| `tiles/<L>.svg`  | App icon: white mark on a gradient tile.                                              |
| `index.html`     | Preview sheet (generated).                                                            |
| `build.mjs`      | The source of truth for every shape. Regenerates everything above.                    |
| `explorations/`  | The 10 logo directions that led here, kept for reference. Not for production use.     |

## Specs

- Grid: 64 × 64. Caps run from y 14 to y 50. Stroke 4.5, round caps and joins.
- Tile: corner radius 15. The mark is scaled to 80% inside the tile. Gradient runs top-left
  to bottom-right, from `oklch(72% 0.18 h)` to `oklch(50% 0.22 h)` (the Workspace app tile),
  written as sRGB hex so favicons and push icons render everywhere.
- Colours: H and W use Helix violet (hue 290: `#a491ff` → `#693ad4`); A uses Agentspace teal
  (hue 185: `#00beaf` → `#00736a`). Other hues are placeholders until a product claims the
  letter. Set them in `ASSIGNED` in `build.mjs`.
- Small sizes: at 16 px the loops start to fill in. For favicons, use the glyph with a
  thinner stroke (about 3.5), or the tile at 24 px or more.

## Changing a letter

Edit its entry in `LETTERS` in `build.mjs`, then run:

```sh
node docs/brand/build.mjs
```

Do not hand-edit the SVGs; the next build overwrites them.

## Where the marks are used

- **Workspace (W):** `apps/web/src/components/shell/helix-mark.ts` holds the W path data,
  shared by `HelixLogo` and the inline favicon in `apps/web/index.html`;
  `helix-mark.test.ts` fails if the favicon drifts. After changing W here, copy its paths
  from `glyphs/W.svg` into that file and update the favicon.
- **Agentspace (A):** `helix-agentspace/apps/web/logo.svg` is a copy of `tiles/A.svg` (app mark,
  favicon and push icon). See `helix-agentspace/docs/assets/logo.md`.
