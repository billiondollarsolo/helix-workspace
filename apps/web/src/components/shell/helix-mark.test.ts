/* Keeps the favicon honest.
 *
 * `index.html` is static: it cannot import `helix-mark.ts`, so its copy of the
 * mark is necessarily hand-generated. That is exactly how the previous copy
 * drifted — the favicon was a violet square containing a white letter F, a
 * scaffold leftover, while two separate source comments claimed it shared its
 * path data with the components and that all three were "changed together".
 * Nothing enforced it, so nobody found out.
 *
 * These assertions are that enforcement. The components consume the constants
 * directly, so the type system covers them; only the HTML needs a test.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HELIX_MARK_FAVICON_STROKE, HELIX_MARK_PATHS, HELIX_MARK_STROKE_WIDTH } from "./helix-mark";

const indexHtml = readFileSync(
  fileURLToPath(new URL("../../../index.html", import.meta.url)),
  "utf8",
);

/** The favicon's `href`, still percent-encoded.
 *
 *  Matched across newlines because Prettier wraps the attributes of a `<link>`
 *  whose href is a ~950-character data URI onto separate lines — a single-line
 *  pattern passes until the next format run and then fails for a reason that
 *  has nothing to do with the mark. */
function faviconHref(): string {
  const match = /rel="icon"\s+href="([^"]+)"/.exec(indexHtml);
  if (match?.[1] === undefined) {
    throw new Error('No <link rel="icon"> with a double-quoted href in index.html.');
  }
  return match[1];
}

/** Percent-decoded, so assertions can be written in plain SVG. */
function faviconSvg(): string {
  return decodeURIComponent(faviconHref().replace(/^data:image\/svg\+xml,/, ""));
}

describe("the favicon", () => {
  it("draws every segment of the shared Helix mark", () => {
    const svg = faviconSvg();
    // Each path individually, so a failure names the segment that drifted
    // rather than reporting that two long strings differ somewhere.
    for (const d of HELIX_MARK_PATHS) {
      expect(svg).toContain(`d='${d}'`);
    }
  });

  it("draws only that mark, and nothing left over", () => {
    const svg = faviconSvg();
    const drawn = [...svg.matchAll(/<path d='([^']+)'/g)].map((match) => match[1]);
    /* An extra path is the failure this test exists for: the placeholder was a
       single `<path>` spelling out an F. Comparing the whole set catches
       leftovers that a per-segment check would walk straight past. */
    expect(drawn).toEqual([...HELIX_MARK_PATHS]);
  });

  it("strokes the glyph at Lucide's weight", () => {
    const svg = faviconSvg();
    expect(svg).toContain(`stroke-width='${String(HELIX_MARK_STROKE_WIDTH)}'`);
    expect(svg).toContain("fill='none'");
  });

  it("carries a colour for both tab themes, and never currentColor", () => {
    const svg = faviconSvg();
    /* A favicon inherits no colour, so `currentColor` resolves to black and the
       mark all but vanishes against dark browser chrome. Both schemes get an
       explicit stroke, switched by a rule inside the SVG itself — there is no
       outer document to carry a media query for it. */
    expect(svg).not.toContain("currentColor");
    expect(svg).toContain(`stroke='${HELIX_MARK_FAVICON_STROKE.light}'`);
    expect(svg).toContain("@media(prefers-color-scheme:dark)");
    expect(svg).toContain(`stroke:${HELIX_MARK_FAVICON_STROKE.dark}`);
  });

  it("stays self-contained", () => {
    // No public/ directory exists to serve an icon file from, and a favicon
    // that reaches for a URL is a favicon that can fail to load.
    expect(faviconHref().startsWith("data:image/svg+xml,")).toBe(true);
    expect(faviconSvg()).not.toMatch(/href|xlink:href|url\(https?:/);
  });
});
