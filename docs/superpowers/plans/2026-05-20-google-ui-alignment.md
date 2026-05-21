# Google-faithful UI Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Helix Workspace web UI (`apps/web`) to look and feel like Google Workspace (Gmail / Drive) in dark mode, foundation-first.

**Architecture:** Change shared design tokens in `src/styles.css` so every page improves at once, restyle shell chrome, then polish Mail and rebuild the Drive home, then sweep the remaining pages for consistency. All changes are CSS-token and component-level — no router, API, or dependency changes.

**Tech Stack:** React 19, TanStack Router/Query, Tailwind v4, shadcn + radix-ui, lucide-react, Roboto, Vite. Tests: Vitest. Spec: `docs/superpowers/specs/2026-05-20-google-ui-alignment-design.md`.

> **Repo note:** This workspace is **not a git repository**, so there are no commit steps. Each task ends with a **Checkpoint** step: run lint + typecheck + the relevant tests, and screenshot-compare the affected page against the reference. Treat a green checkpoint as the equivalent of a commit.

> **Verification baseline (run once before Task 1):**
> ```
> cd apps/web && pnpm lint && pnpm typecheck && pnpm test
> ```
> Record the result. Every later checkpoint must be no worse than this baseline.

> **Screenshot loop (used in every checkpoint):** with `pnpm dev` running, use the chrome-devtools MCP to `navigate_page` to the affected route at `resize_page` 1680x950, `take_screenshot`, and visually compare against the Gmail/Drive references and live Google apps. Tune token values where a surface/contrast looks off.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/styles.css` | Design tokens + per-feature class blocks | Modify |
| `src/components/shell.tsx` | Top bar, rails, account control | Modify |
| `src/features/mail/mail-shell.tsx` | Mail list, tabs, compose | Modify |
| `src/features/mail/mail-shell.test.tsx` | Mail tests | Modify if markup changes |
| `src/features/drive/drive-shell.tsx` | Drive home | Modify (rebuild home) |
| `src/features/drive/queries.ts` | Drive data queries | Modify (add suggestions) |
| `src/features/drive/drive-shell.test.tsx` | Drive tests | Modify if markup changes |
| `src/features/{chat,docs,calendar,meet,assistant,search}/*-shell.tsx` | Feature pages | Modify (sweep) |
| `src/routes/_shell/settings/*.tsx`, `src/features/admin/*` | Settings/admin | Modify (sweep) |

---

## Phase 1 — Foundation

### Task 1: Layered dark palette tokens

**Files:**
- Modify: `src/styles.css` — the `:root.dark { … }` block (currently ~lines 131-182)

- [ ] **Step 1: Replace the dark surface + color tokens**

In the `:root.dark` block, set these values (keep all other tokens in the block, e.g. `--md-sys-*`, `chart-*`, `sidebar-*` derived vars):

```css
:root.dark {
  color-scheme: dark;
  --surface: #0d0d0d;
  --surface-dim: #0d0d0d;
  --surface-bright: #282a2c;
  --surface-container-lowest: #141414;
  --surface-container-low: #1b1b1b;
  --surface-container: #1e1f20;
  --surface-container-high: #282a2c;
  --surface-container-highest: #37393b;
  --outline: #8e918f;
  --outline-variant: #444746;
  --background: var(--surface);
  --foreground: #e3e3e3;
  --card: var(--surface-container-lowest);
  --card-foreground: #e3e3e3;
  --popover: var(--surface-container);
  --popover-foreground: #e3e3e3;
  --primary: #8ab4f8;
  --primary-foreground: #062e6f;
  --secondary: #c4c7c5;
  --secondary-foreground: #1e1f20;
  --muted: var(--surface-container-high);
  --muted-foreground: #9aa0a6;
  --accent: #1f2a44;
  --accent-foreground: #d3e3fd;
  --destructive: #f2b8b5;
  --border: var(--outline-variant);
  --input: var(--outline);
  --ring: #8ab4f8;
  --sidebar: var(--surface-container-low);
  --sidebar-foreground: #e3e3e3;
  --sidebar-primary: #8ab4f8;
  --sidebar-primary-foreground: #062e6f;
  --sidebar-accent: #1f2a44;
  --sidebar-accent-foreground: #d3e3fd;
  --sidebar-border: var(--outline-variant);
  --sidebar-ring: #8ab4f8;
  --panel: var(--surface-container-lowest);
  --danger: var(--destructive);
  --md-sys-state-hover: rgb(227 227 227 / 8%);
  --md-sys-state-focus: rgb(227 227 227 / 12%);
  --md-sys-state-pressed: rgb(227 227 227 / 16%);
  --md-sys-elevation-1: 0 1px 2px rgb(0 0 0 / 40%), 0 1px 3px 1px rgb(0 0 0 / 24%);
  --md-sys-elevation-2: 0 1px 2px rgb(0 0 0 / 44%), 0 2px 6px 2px rgb(0 0 0 / 26%);
  --md-sys-elevation-3: 0 4px 8px 3px rgb(0 0 0 / 28%), 0 1px 3px rgb(0 0 0 / 44%);
}
```

- [ ] **Step 2: Run the dark-mode page through verification**

```
cd apps/web && pnpm typecheck && pnpm lint
```
Expected: PASS (no JS/TS touched, but confirm CSS didn't break the build via `pnpm dev`).

- [ ] **Step 3: Checkpoint**

Start `pnpm dev`, screenshot `/mail` and `/drive` in dark mode. Expected: canvas is near-black, the left rail / sidebar / search pill are now visibly distinct layered grays (no longer a flat black field). Run `pnpm test` — expected: no worse than baseline.

---

### Task 2: Density, rhythm & content-panel surface

**Files:**
- Modify: `src/styles.css` — shared layout classes (`.workspace-frame`, `.top-bar`, `.content-frame`, `.main-content`, list/row classes)

- [ ] **Step 1: Tighten the global rhythm**

In `body`, confirm `font-size: 14px; line-height: 1.45;` — change to `font-size: 13px; line-height: 1.4;`. Reduce `.top-bar` vertical padding so its row height is ~64px (currently `8px 16px 10px` with a 72px grid row — change `.workspace-frame` `grid-template-rows` first value `72px` to `64px` and `.top-bar` padding to `8px 16px`).

- [ ] **Step 2: Add the rounded content panel**

The page content (`.main-content` / `.content-frame`) should read as a rounded surface floating on the canvas. Add to `.main-content`:

```css
.main-content {
  /* keep existing layout rules */
  background: var(--surface-container-lowest);
  border-radius: 16px;
  margin: 0 8px 8px 0;
  overflow: hidden;
}
```
(Adjust the selector to whichever element wraps per-page content directly inside `.content-frame`; verify in `shell.tsx`.)

- [ ] **Step 3: Verify**

```
cd apps/web && pnpm lint && pnpm typecheck && pnpm test
```
Expected: PASS, no worse than baseline.

- [ ] **Step 4: Checkpoint**

Screenshot `/mail` and `/drive`. Expected: content sits in a rounded panel on the canvas; overall density is tighter, no overflow or layout shift.

---

### Task 3: Shell chrome — top bar, search, account, rails

**Files:**
- Modify: `src/components/shell.tsx`
- Modify: `src/styles.css` — `.top-bar`, `.search-trigger`, `.account-chip`, `.icon-button`, rail classes
- Test: `src/components/shell.test.tsx`

- [ ] **Step 1: Restyle the search trigger**

In `styles.css` `.search-trigger`: remove the `border`, set `background: var(--surface-container-highest)`; on `:hover` raise to `--md-sys-elevation-1`; on `:focus-visible` add `outline: 2px solid var(--ring)`. Keep the leading search icon and `⌘K` `kbd`.

- [ ] **Step 2: Replace the account chip with an avatar circle**

In `shell.tsx`, find the account control (renders `initials` + `actor.displayName`, class `account-chip`). Replace the visible `displayName` text node with an avatar-only button: a 32px circle showing `initials`, `aria-label={actor.displayName}`. Keep the existing `DropdownMenu` wiring intact. Update `.account-chip` in `styles.css` to a 32px circular button (`width:32px;height:32px;border-radius:50%;padding:0`).

- [ ] **Step 3: Restyle icon buttons and rails**

`.icon-button` / `.right-rail-toggle`: remove `border`, set `background: transparent`, add `:hover { background: var(--md-sys-state-hover); }`, keep 40px circular shape. Left/right rails: background `var(--surface-container-low)`, active rail item gets a circular `var(--accent)` background with `var(--accent-foreground)` icon.

- [ ] **Step 4: Update tests for markup changes**

If Step 2 removed the `displayName` text from the DOM, update `shell.test.tsx` assertions: query the account control by `aria-label` / role `button` instead of by visible name text. Show the changed assertion in the test file.

- [ ] **Step 5: Verify**

```
cd apps/web && pnpm lint && pnpm typecheck && pnpm test
```
Expected: PASS.

- [ ] **Step 6: Checkpoint**

Screenshot `/mail`. Expected: flat top bar, pill search with no border, avatar-only account button, circular icon-button hovers, layered rails. Compare against the Gmail reference.

---

## Phase 2 — Mail

### Task 4: Mail dense single-line rows

**Files:**
- Modify: `src/features/mail/mail-shell.tsx`
- Modify: `src/styles.css` — `.mail-*` row classes
- Test: `src/features/mail/mail-shell.test.tsx`

- [ ] **Step 1: Make rows single-line and dense**

In the mail list row markup, lay each row out as a single 44px-high flex row:
`[checkbox] [star] [sender (fixed ~168px)] [subject — snippet (flex, truncated)] [date (right)]`.
Snippet text uses `var(--muted-foreground)`; subject uses `var(--foreground)`. The row must `white-space: nowrap; overflow: hidden;` so it never wraps. Unread rows: sender + subject `font-weight: 700` and `color: var(--foreground)`; read rows: `font-weight: 400`.

- [ ] **Step 2: Row hover + action reveal**

Row `:hover` background `var(--md-sys-state-hover)`. The date cell and row actions (archive/delete/etc.) share the trailing slot — show the date by default, swap to action icons on row `:hover`/`:focus-within` (CSS `:hover` toggling `display`/`opacity` on two trailing elements; no JS needed).

- [ ] **Step 3: Update tests for markup changes**

Run `pnpm test src/features/mail/mail-shell.test.tsx`. For each failing assertion caused by the row restructure, update the query to match the new DOM (prefer role/label queries over structural ones). Show each changed assertion.

- [ ] **Step 4: Verify**

```
cd apps/web && pnpm lint && pnpm typecheck && pnpm test
```
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Screenshot `/mail`. Expected: dense single-line rows, unread emphasis, hover reveals actions. Compare against the Gmail reference.

---

### Task 5: Mail tabs, "Happening soon" card, compose, toolbar

**Files:**
- Modify: `src/features/mail/mail-shell.tsx`
- Modify: `src/styles.css` — mail tab / card / toolbar / compose classes

- [ ] **Step 1: Gmail-style category tabs**

Restyle the Primary / Promotions / Social / Updates tab strip: equal-width tabs, the active tab has a 3px bottom border in `var(--primary)` and brighter label; inactive tabs use `var(--muted-foreground)`. Count chips ("11 new") become small rounded `var(--surface-container-high)` pills.

- [ ] **Step 2: "Happening soon" card**

Restyle the card: `background: var(--surface-container)`, `border-radius: 16px`, `padding: 12px 16px`, hairline `var(--border)`. The "View order" button is a filled `var(--primary)` pill.

- [ ] **Step 3: Compose button + bulk toolbar**

Compose: an elevated pill — `background: var(--surface-container-highest)` (light in dark mode), `border-radius: 16px`, `box-shadow: var(--md-sys-elevation-1)`, pencil icon + label. The select/refresh/more toolbar above the list: transparent background, 40px circular icon buttons matching Task 3.

- [ ] **Step 4: Verify**

```
cd apps/web && pnpm lint && pnpm typecheck && pnpm test
```
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Screenshot `/mail`. Expected: underlined active tab, refined card, elevated Compose pill. Compare against the Gmail reference.

---

## Phase 3 — Drive

### Task 6: Drive suggestion queries

**Files:**
- Modify: `src/features/drive/queries.ts`
- Test: `src/features/drive/queries.test.ts` (create if absent; otherwise add to the existing drive test file)

- [ ] **Step 1: Write failing tests for suggestion derivation**

Add a pure function `deriveDriveSuggestions(entries: readonly DriveApiEntry[])` that returns `{ folders: DriveApiEntry[]; files: DriveApiEntry[] }` — `folders` = folder-type entries sorted by most-recent activity (limit 5), `files` = non-folder entries sorted by most-recent activity (limit 10). Write tests:

```ts
import { describe, it, expect } from "vitest";
import { deriveDriveSuggestions } from "./queries";

describe("deriveDriveSuggestions", () => {
  it("splits folders from files and limits counts", () => {
    const entries = makeEntries(8 /* folders */, 14 /* files */);
    const out = deriveDriveSuggestions(entries);
    expect(out.folders).toHaveLength(5);
    expect(out.files).toHaveLength(10);
  });

  it("sorts each group by most-recent activity descending", () => {
    const out = deriveDriveSuggestions([
      makeEntry({ kind: "file", name: "old", modifiedAt: "2026-01-01" }),
      makeEntry({ kind: "file", name: "new", modifiedAt: "2026-05-01" }),
    ]);
    expect(out.files[0].name).toBe("new");
  });
});
```
(Define `makeEntry` / `makeEntries` helpers matching the real `DriveApiEntry` shape — check `features/drive/api.ts` for the exact fields and the timestamp property name; adjust `modifiedAt` above to the real field.)

- [ ] **Step 2: Run tests to verify they fail**

```
cd apps/web && pnpm test src/features/drive/queries.test.ts
```
Expected: FAIL — `deriveDriveSuggestions` is not exported.

- [ ] **Step 3: Implement `deriveDriveSuggestions` + query options**

Add to `queries.ts`: the `deriveDriveSuggestions` pure function (sort by the real timestamp field, partition by folder kind, slice 5 / 10), and `driveSuggestionsQueryOptions()` — a `queryOptions` that reuses the existing `listDrive` fetch (root folder) and maps the result through `deriveDriveSuggestions`. Add a `suggestions` key to `driveQueryKeys`.

- [ ] **Step 4: Run tests to verify they pass**

```
cd apps/web && pnpm test src/features/drive/queries.test.ts
```
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```
cd apps/web && pnpm lint && pnpm typecheck && pnpm test
```
Expected: PASS, no worse than baseline.

---

### Task 7: Drive home rebuild

**Files:**
- Modify: `src/features/drive/drive-shell.tsx`
- Modify: `src/styles.css` — add `.drive-suggested-*` classes
- Test: `src/features/drive/drive-shell.test.tsx`

- [ ] **Step 1: Remove the redundant in-content search bar**

Delete the in-content "Search files" input block from `drive-shell.tsx` (the top-bar search already covers Drive). Keep the `3 items` / Trash / view-toggle controls row.

- [ ] **Step 2: Add the Suggested folders row**

When viewing the Drive home (root, no active search/scope), render a "Suggested folders" section: a horizontal row of cards consuming `driveSuggestionsQueryOptions()` via `useQuery`/`useSuspenseQuery`. Each card: folder icon, name, `in <location>` subtitle, `var(--surface-container)` background, `12px` radius, hover elevation.

- [ ] **Step 3: Add the Suggested files table**

Below it, a "Suggested files" table with columns `Name · Reason suggested · Owner · Location`. Reuse the existing TanStack Table setup pattern from the current list. Render explicit loading (skeleton rows), empty ("No suggestions yet"), and backend-offline states — the offline state shows the existing offline banner, not an error.

- [ ] **Step 4: Keep the regular folder/file list**

Below the suggested sections, keep the existing folder/file listing (restyled in Task 8) so navigation into folders still works.

- [ ] **Step 5: Update tests for markup changes**

Run `pnpm test src/features/drive/drive-shell.test.tsx`; update assertions broken by the removed search bar and new sections. Show each changed assertion. Add a test asserting the "Suggested folders" and "Suggested files" headings render on the Drive home.

- [ ] **Step 6: Verify**

```
cd apps/web && pnpm lint && pnpm typecheck && pnpm test
```
Expected: PASS.

- [ ] **Step 7: Checkpoint**

Screenshot `/drive`. Expected: no in-content search bar, Suggested folders cards row + Suggested files table, then the folder list. Compare against the Drive reference.

---

### Task 8: Drive file-type icons, view toggle, sidebar restyle

**Files:**
- Modify: `src/features/drive/drive-shell.tsx`
- Modify: `src/styles.css` — `.drive-*` list/sidebar classes

- [ ] **Step 1: File-type icons in Google colors**

Map entry kind → lucide icon + color: folder `#8ab4f8`, doc (`FileText`) `#4285f4`, sheet (`Sheet`/`Table`) `#34a853`, slide (`Presentation`) `#fbbc04`, generic file `var(--muted-foreground)`. Apply in both list rows and suggested sections.

- [ ] **Step 2: List/grid view toggle**

Restyle the existing list/grid toggle as a segmented control: two icon buttons in a `var(--surface-container-high)` rounded container, the active one filled `var(--accent)`.

- [ ] **Step 3: Sidebar restyle**

Drive left sidebar (My Drive / Shared with me / Recent / Starred / Trash / Storage): item rows 40px tall, active item a full-width pill `var(--accent)` with `var(--accent-foreground)`, hover `var(--md-sys-state-hover)`. Restyle the "New doc" / "Upload" buttons to match Drive's "New" elevated button (one elevated pill; keep both actions).

- [ ] **Step 4: Verify**

```
cd apps/web && pnpm lint && pnpm typecheck && pnpm test
```
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Screenshot `/drive`. Expected: colored file-type icons, segmented view toggle, pill-style sidebar. Compare against the Drive reference.

---

## Phase 4 — Sweep remaining pages

Each sweep task applies the foundation and fixes only density, surfaces, headers, and control styling — no redesigns. For each: screenshot before and after, compare against the matching Google app.

### Task 9: Sweep chat & docs

**Files:**
- Modify: `src/features/chat/chat-shell.tsx`, `src/features/docs/*` page/shell, `src/styles.css` (`.chat-*`, docs classes)

- [ ] **Step 1: Chat** — message rows dense (no oversized padding), composer as a rounded `var(--surface-container-highest)` bar, room list items as 40px pills matching the Drive sidebar.
- [ ] **Step 2: Docs** — editor chrome flattened to new surfaces, doc-list rows dense and single-line like Mail.
- [ ] **Step 3: Verify** — `cd apps/web && pnpm lint && pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 4: Checkpoint** — screenshot `/chat` and `/docs`; confirm consistency with Mail/Drive.

### Task 10: Sweep calendar & meet

**Files:**
- Modify: `src/features/calendar/calendar-shell.tsx`, `src/features/meet/meet-shell.tsx`, `src/styles.css`

- [ ] **Step 1: Calendar** — grid hairlines `var(--border)`, event chips rounded with `var(--primary)`/category colors, header controls as circular icon buttons.
- [ ] **Step 2: Meet** — tiles on `var(--surface-container)`, controls bar as a centered rounded bar, right rail matching shell tokens.
- [ ] **Step 3: Verify** — `cd apps/web && pnpm lint && pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 4: Checkpoint** — screenshot `/calendar` and `/meet`.

### Task 11: Sweep assistant & search

**Files:**
- Modify: `src/features/assistant/assistant-shell.tsx`, `assistant-right-rail-panel.tsx`, `src/styles.css` (`.search-page`, `.command-*`, assistant classes)

- [ ] **Step 1: Assistant** — message bubbles / tool cards on layered surfaces, right-rail panel matching shell.
- [ ] **Step 2: Search** — `.search-page` results table dense like Mail rows, `.search-type-filters` as rounded chips, header tightened.
- [ ] **Step 3: Verify** — `cd apps/web && pnpm lint && pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 4: Checkpoint** — screenshot `/assistant` and `/search`.

### Task 12: Sweep settings & admin

**Files:**
- Modify: `src/routes/_shell/settings/index.tsx` + `admin.tsx`, `src/features/admin/*`, `src/styles.css`

- [ ] **Step 1: Settings** — section cards on `var(--surface-container-lowest)` with `16px` radius, form controls (inputs, switches) on new tokens, headers tightened.
- [ ] **Step 2: Admin** — tables dense, cards consistent with Settings.
- [ ] **Step 3: Verify** — `cd apps/web && pnpm lint && pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 4: Checkpoint** — screenshot `/settings` and `/admin`.

---

## Task 13: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full check**

```
cd apps/web && pnpm lint && pnpm typecheck && pnpm test
```
Expected: PASS, no worse than the recorded baseline.

- [ ] **Step 2: Accessibility audit**

```
cd apps/web && pnpm audit:a11y
```
Expected: no new violations vs. baseline — pay attention to text-contrast failures introduced by the darker palette. If any appear, tune `--foreground` / `--muted-foreground` in `styles.css` and re-run.

- [ ] **Step 3: Light-mode sanity pass**

Toggle to light mode; screenshot `/mail`, `/drive`, `/settings`. Expected: legible, no broken contrast, no flat/unstyled regions. Fix any shared-token regressions.

- [ ] **Step 4: Full visual sweep**

With `pnpm dev` running, screenshot every route (`/mail`, `/chat`, `/drive`, `/docs`, `/calendar`, `/meet`, `/assistant`, `/search`, `/settings`, `/admin`) in dark mode at 1680x950. Confirm: consistent layered surfaces, consistent density, no overflow/layout shift. Compare Mail and Drive against the reference screenshots.

---

## Self-Review

- **Spec coverage:** Palette → Task 1; density + content panel → Task 2; shell chrome → Task 3; Mail rows/tabs/compose → Tasks 4-5; Drive queries → Task 6; Drive home rebuild → Task 7; Drive icons/toggle/sidebar → Task 8; sweep of all 8 remaining pages → Tasks 9-12; tests + a11y + light-mode + visual sweep → Task 13. All spec sections mapped.
- **Placeholders:** none — token values, class targets, and verification commands are concrete. Component-level steps describe exact layout/token targets; final hex tuning against screenshots is an explicit, intended part of each checkpoint, not a placeholder.
- **Type consistency:** `deriveDriveSuggestions` and `driveSuggestionsQueryOptions` (Task 6) are the only new symbols; both are consumed in Task 7 under the same names. `DriveApiEntry` is the existing type from `features/drive/api.ts` — the implementer confirms its real timestamp field in Task 6 Step 1.
