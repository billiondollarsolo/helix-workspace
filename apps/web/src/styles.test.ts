/* Guards against silently-dead CSS classes.
 *
 * Two failure modes bit the admin console, both invisible at build time:
 *
 *  1. Bespoke `admin-*` / `helix-*` classes were referenced in TSX but never
 *     given rules, so Tier readiness / Services / AI observability rendered
 *     as unstyled text.
 *  2. shadcn + Material-3 colour utilities (`bg-card`, `border-border`,
 *     `text-muted-foreground`, `border-outline`, …) were used without a
 *     Tailwind v4 `@theme` entry, so they compiled to nothing and fell back
 *     to `currentColor` — near-black borders and un-muted "muted" text.
 *
 * Neither produces an error, a warning, or a failing build. This test is the
 * only thing standing between a new token and another silently-broken page.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const STYLES = readFileSync(join(SRC, "styles.css"), "utf8");

/** Colour names that only exist because we define them. Anything here used as
 *  a Tailwind utility must have a matching `--color-<name>` in `@theme`. */
const SEMANTIC_COLORS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "muted",
  "muted-foreground",
  "border",
  "input",
  "ring",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "destructive",
  "destructive-foreground",
  "accent",
  "accent-foreground",
  // Material-3 vocabulary used by components/ui/button.tsx
  "outline",
  "outline-variant",
  "surface-container",
  "surface-container-lowest",
] as const;

const COLOR_PREFIXES = ["bg", "text", "border", "ring", "outline", "fill", "stroke", "divide"];

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(path));
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) out.push(path);
  }
  return out;
}

const SOURCES = tsxFiles(SRC).map((path) => {
  const text = readFileSync(path, "utf8");
  return { path, classNames: classNameRegions(text).join(" ") };
});

/** Every `className=` value in a source file.
 *
 *  Scanning the whole file instead would sweep up identifiers that merely look
 *  like class names — a `@keyframes helix-slide-transition-right` inside a
 *  CSS-in-JS string, or the `helix-user-password` demo credential in
 *  routes/login.tsx. Only what reaches the DOM as a class counts. */
function classNameRegions(text: string): string[] {
  const regions: string[] = [];
  const marker = "className=";
  for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + 1)) {
    let cursor = i + marker.length;
    const quote = text[cursor];
    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, cursor + 1);
      if (end === -1) continue;
      regions.push(text.slice(cursor + 1, end));
      continue;
    }
    if (text[cursor] !== "{") continue;
    // Walk to the brace that closes the JSX expression container.
    let depth = 0;
    const start = cursor;
    for (; cursor < text.length; cursor += 1) {
      if (text[cursor] === "{") depth += 1;
      else if (text[cursor] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    regions.push(text.slice(start + 1, cursor));
  }
  return regions;
}

/** `.foo` present as a selector (not as a substring of `.foo-bar`). */
function hasRule(className: string): boolean {
  return new RegExp(`\\.${className}(?![\\w-])`).test(STYLES);
}

function themeDeclares(color: string): boolean {
  return new RegExp(`--color-${color}\\s*:`).test(STYLES);
}

/** Capture group 1 of every match, as a set. */
function captured(text: string, pattern: RegExp): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const value = match[1];
    if (value !== undefined) out.add(value);
  }
  return out;
}

/** Namespaces the app styles itself, rather than with Tailwind utilities.
 *
 *  Every prefix here is a surface that invented its own vocabulary. The guard
 *  covered only `admin`/`helix` at first, which is exactly why 28 phantom
 *  `webhooks-*` classes shipped and rendered that whole section as raw text —
 *  the same failure the guard was written to prevent, one prefix over. Add a
 *  prefix here whenever a surface starts naming its own classes. */
const BESPOKE_CLASS_PREFIXES = [
  "admin",
  "helix",
  "webhooks",
  "auth",
  "landing",
  "onboarding",
  "docs",
  "native-document",
  "collaboration",
] as const;

describe("styles.css covers every class the app actually uses", () => {
  it("defines every bespoke namespaced class referenced in TSX", () => {
    const pattern = new RegExp(
      `\\b((?:${BESPOKE_CLASS_PREFIXES.join("|")})-[a-z0-9]+(?:-[a-z0-9]+)*)\\b`,
      "g",
    );
    const used = new Set<string>();
    for (const { classNames } of SOURCES) {
      for (const cls of captured(classNames, pattern)) used.add(cls);
    }
    expect(used.size).toBeGreaterThan(0);

    const undefinedClasses = [...used].filter((cls) => !hasRule(cls)).sort();
    expect(undefinedClasses, "referenced in TSX but never styled").toEqual([]);
  });

  it("bridges every semantic colour utility into the Tailwind @theme block", () => {
    // Longest-first so `card-foreground` wins over `card`.
    const names = [...SEMANTIC_COLORS].sort((a, b) => b.length - a.length);
    const pattern = new RegExp(
      `\\b(?:${COLOR_PREFIXES.join("|")})-(${names.join("|")})(?![\\w-])`,
      "g",
    );

    const used = new Set<string>();
    for (const { classNames } of SOURCES) {
      for (const color of captured(classNames, pattern)) used.add(color);
    }
    expect(used.size).toBeGreaterThan(0);

    const unbridged = [...used].filter((color) => !themeDeclares(color)).sort();
    expect(unbridged, "used as a utility but missing from @theme").toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("design tokens", () => {
  const defined = captured(STYLES, /(--[\w-]+)\s*:/g);

  it("defines every custom property the app reads", () => {
    const used = new Set<string>();
    for (const path of sourceFiles(SRC)) {
      // `--label-${name}` style templates end in "-" and are checked below.
      for (const name of captured(readFileSync(path, "utf8"), /var\((--[\w-]+)(?=[),\s])/g)) {
        if (!name.startsWith("--radix-")) used.add(name);
      }
    }
    expect([...used].filter((name) => !defined.has(name)).sort()).toEqual([]);
  });

  it("ships a 24-colour label palette with soft variants", () => {
    const labels = [...defined].filter(
      (name) => /^--label-[a-z]{2,}$/.test(name) && name !== "--label-on",
    );
    expect(labels).toHaveLength(24);
    for (const label of labels) expect(defined.has(`${label}-soft`), label).toBe(true);
  });

  it("names the density modes and collapses motion for reduced-motion users", () => {
    expect(STYLES).toMatch(/\[data-density="default"\]/);
    expect(STYLES).toMatch(/\[data-density="comfortable"\]/);
    expect(STYLES).toMatch(/\[data-density="compact"\]/);
    const reduced = extractAllMediaBlocks(STYLES, "(prefers-reduced-motion: reduce)").join("\n");
    expect(reduced).toMatch(/--motion-duration-base:\s*0ms/);
    for (const token of ["--focus-ring", "--star", "--cal-now", "--motion-ease-standard"]) {
      expect(defined.has(token), token).toBe(true);
    }
  });
});

/**
 * Shell responsive contract used by the mobile (390×844) e2e.
 * Phones swap the desktop rail for a bottom navigation bar under the workspace.
 * (styles.css has multiple `@media (max-width: 760px)` sections; we join them all.)
 */
describe("mobile shell responsive CSS (viewport ≤760 / 390 design width)", () => {
  const mobileCss = extractAllMediaBlocks(STYLES, "(max-width: 760px)").join("\n");
  const narrowTopbarCss = extractAllMediaBlocks(STYLES, "(max-width: 520px)").join("\n");

  it("swaps the rail for a bottom navigation row with 56px targets", () => {
    expect(mobileCss.length).toBeGreaterThan(0);
    expect(mobileCss).toMatch(
      /\.app\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/s,
    );
    expect(mobileCss).toMatch(/\.app > \.rail,\s*\.launcher\s*\{[^}]*display:\s*none/s);
    expect(mobileCss).toMatch(/\.app > \.bottom-nav\s*\{[^}]*grid-row:\s*3/s);
    expect(mobileCss).toMatch(/\.app > \.bottom-nav\s*\{[^}]*safe-area-inset-bottom/s);
    expect(mobileCss).toMatch(/\.bottom-nav-item\s*\{[^}]*min-height:\s*56px/s);
    expect(mobileCss).toMatch(/\.workspace\s*\{[^}]*grid-row:\s*2/s);
    expect(mobileCss).toMatch(/\.side-panel-rail\s*\{[^}]*display:\s*none/s);
  });

  it("keeps compose above the bottom bar and top-bar targets at 40px", () => {
    expect(mobileCss).toMatch(/\.compose\s*\{[^}]*bottom:\s*calc\(56px/s);
    expect(mobileCss).toMatch(/\.topbar-actions\s+\.icon-btn\s*\{[^}]*min-width:\s*40px/s);
  });

  it("keeps the app title at 520px and drops secondary chrome instead", () => {
    expect(narrowTopbarCss.length).toBeGreaterThan(0);
    expect(narrowTopbarCss).not.toMatch(/\.topbar-title\s*\{[^}]*display:\s*none/s);
    expect(narrowTopbarCss).toMatch(/\.topbar-quick-settings\s*\{[^}]*display:\s*none/s);
  });
});

/** Return bodies of every `@media <query> { … }` block (brace-balanced). */
function extractAllMediaBlocks(css: string, query: string): string[] {
  const marker = `@media ${query}`;
  const blocks: string[] = [];
  let from = 0;
  while (from < css.length) {
    const start = css.indexOf(marker, from);
    if (start === -1) {
      break;
    }
    const openBrace = css.indexOf("{", start);
    if (openBrace === -1) {
      break;
    }
    let depth = 0;
    let end = -1;
    for (let i = openBrace; i < css.length; i += 1) {
      const ch = css[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      break;
    }
    blocks.push(css.slice(openBrace + 1, end));
    from = end + 1;
  }
  return blocks;
}
