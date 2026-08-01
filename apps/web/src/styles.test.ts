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
