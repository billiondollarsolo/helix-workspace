# Google-faithful UI alignment for Helix Workspace

**Date:** 2026-05-20
**Status:** Approved design — ready for implementation planning
**Scope:** `apps/web` frontend visual alignment to Gmail / Google Drive (dark mode)

## Goal

Make the Helix Workspace web UI look and feel like Google Workspace apps
(Gmail, Drive, Docs, Calendar, Meet). The app already uses Roboto and a
Material-ish token system, but reads as "off" because of a flat near-black
canvas with no surface layering, oversized list rows, and components that
drift from Google's shapes and density.

Work is **foundation-first**: fix shared design tokens and shell chrome so
every page improves at once, then polish Mail and Drive to closely match the
reference screenshots, then sweep the remaining pages for consistency.

## Decisions (from brainstorming)

- **Sequencing:** Foundation first, then all pages — single spec, phased.
- **Theme:** Dark mode is the primary target; light mode stays functional and
  internally consistent but is not pixel-tuned.
- **Fidelity:** Google-faithful, not a clone. Keep Helix branding (the `H`
  mark, "Helix" name). Do not recreate Gmail wordmarks/logos.
- **Top bar:** Keep the current per-page icon + title pattern; restyle only.
- **Drive:** Rebuild the Drive home with Suggested folders + Suggested files,
  pulling data through TanStack Query.
- **Canvas darkness:** Push the canvas dark (near-black, Gmail-screenshot
  feel), but build clearly layered surfaces above it.

## Non-goals

- No backend/API changes. Drive "suggestions" are derived from data the
  client already has (recent / shared / modified items).
- No new runtime dependencies.
- No light-mode pixel tuning (keep it coherent only).
- No functional behavior changes beyond the Drive home restructure.
- No impersonation of Google logos or wordmarks.

## Current state

- `apps/web`: React 19, TanStack Router, Tailwind v4, shadcn + radix-ui,
  lucide-react, Roboto (`@fontsource/roboto`).
- Styling: design tokens as CSS custom properties in `:root` / `:root.dark`
  in `src/styles.css` (~7,660 lines), plus hand-written per-feature class
  blocks (`.top-bar`, `.search-trigger`, `.right-rail`, `.search-page`, etc.).
- Shell: `src/components/shell.tsx` — 16px icon rail, top bar, right icon rail.
- Features: `src/features/{mail,drive,chat,docs,calendar,meet,assistant,
  search,...}` — each a `*-shell.tsx` plus `api.ts` / `queries.ts`.
- Routes: `src/routes/_shell/<feature>/index.tsx` (+ `.lazy.tsx`).

Key gaps vs. the reference screenshots:

1. Flat near-black canvas (`#0b0b0b`) with no surface layering — looks harsh.
2. List rows too tall / wrapped; density well below Google "default".
3. Top bar, search pill, and account chip drift from Google shapes.
4. Drive has a redundant in-content search bar and a plain folder list (no
   Suggested sections).

## Architecture

All changes are CSS-token and component-level. No structural/router changes.

```
styles.css  ──┬─ :root.dark token values   (layered dark palette)
              ├─ shared shell classes       (.top-bar, .search-trigger, …)
              └─ per-feature class blocks   (.mail-*, .drive-*, … restyle)

shell.tsx   ──── top bar restyle, account avatar, density wrappers

features/drive/  ── drive-shell.tsx rebuilt home + queries.ts suggestions
features/mail/   ── mail-shell.tsx dense single-line rows
features/<rest>/ ── inherit foundation; targeted per-page fixes
```

### Design unit boundaries

- **Token layer** (`styles.css` `:root` blocks): the single source of color,
  radius, spacing, and elevation. Every component consumes tokens; no
  component hardcodes a hex value. Changing a token must not break consumers.
- **Shell chrome** (`shell.tsx` + shared classes): top bar, rails, search
  trigger, account control. Self-contained; depends only on tokens.
- **Feature shells**: each `*-shell.tsx` owns its page layout and consumes
  tokens + shared primitives. Independently restyleable.
- **Drive data** (`features/drive/queries.ts`): suggestion derivation is a
  pure transform over already-fetched Drive data, exposed as TanStack Query
  options. Testable without the UI.

## Phase 1 — Foundation: tokens & shell

### 1a. Dark palette — layered surfaces

Replace the flat `:root.dark` surface values with a layered Google dark set.
Canvas stays near-black per the "darker" decision; surfaces step up from it.

| Token | Value | Use |
|---|---|---|
| `--surface` / `--background` | `#0d0d0d` | app canvas |
| `--surface-container-lowest` | `#141414` | content panel base |
| `--surface-container-low` | `#1b1b1b` | rails / sidebar |
| `--surface-container` | `#1e1f20` | cards, raised rows |
| `--surface-container-high` | `#282a2c` | hover targets, chips |
| `--surface-container-highest` | `#37393b` | search / inputs |
| `--outline-variant` (`--border`) | `#444746` | hairline borders |
| `--outline` | `#8e918f` | strong borders / icons |
| `--foreground` | `#e3e3e3` | primary text |
| `--muted-foreground` | `#9aa0a6` | secondary text |
| `--primary` | `#8ab4f8` | accent (kept) |
| `--accent` | `#1f2a44` | selected nav background |
| `--accent-foreground` | `#d3e3fd` | selected nav text |

Hover/state tokens use translucent light overlays so they read correctly on
every surface layer:

- `--md-sys-state-hover: rgb(227 227 227 / 8%)`
- `--md-sys-state-focus: rgb(227 227 227 / 12%)`
- `--md-sys-state-pressed: rgb(227 227 227 / 16%)`

Light mode (`:root`) keeps its existing `#1a73e8` / white set; adjust only
shared tokens that would otherwise regress.

Implementation will be tuned by screenshotting against the references and
sampling pixels where a value looks off.

### 1b. Density & rhythm

- Base on an 8px spacing grid; body text 13–14px Roboto, line-height ~1.4.
- List rows: mail `~44px`, drive `~40px` — single line, no wrap.
- Reduce oversized paddings in `.top-bar`, feature headers, and toolbars.
- Icon buttons: 40px touch target with a circular hover halo.

### 1c. Shell chrome (`shell.tsx` + shared classes)

- **Top bar:** keep per-page icon + title; flatten background to `--surface`,
  remove heavy borders, tighten height.
- **Search trigger:** pill on `--surface-container-highest`, no border in
  rest state, subtle ring on focus; leading search icon; `⌘K` hint kept.
- **Account control:** replace the `"LU Local User"` chip with a plain 32px
  avatar circle (initials), opening the existing dropdown.
- **Rails:** left icon rail and right icon rail keep structure; restyle to
  new surface tokens with circular active/hover states.
- **Content panel:** wrap page content in a rounded surface
  (`--surface-container-lowest`, `16px` radius) sitting on the canvas — the
  Gmail/Drive "floating panel" look.

## Phase 2 — Mail polish (`features/mail/mail-shell.tsx`)

- Single-line dense rows:
  `[checkbox] [star] [sender] [subject — snippet] [date]`.
- Unread rows: brighter text + bolder sender; read rows muted.
- Row hover: `--md-sys-state-hover` background; reveal row actions on hover.
- Category tabs (Primary / Promotions / Social / Updates): Gmail-style
  underlined active tab with count chips.
- "Happening soon" card: tighten to Google card spec (radius, padding).
- Compose: keep as an elevated white/light pill with pencil icon.
- Selection + bulk-action toolbar restyled to the new tokens.

## Phase 3 — Drive home rebuild (`features/drive/`)

- Remove the redundant in-content "Search files" bar (top bar searches).
- **Suggested folders:** horizontal row of cards (folder icon, name,
  location), derived from recent/shared folders.
- **Suggested files:** table with columns
  `Name · Reason suggested · Owner · Location`, plus a list/grid view toggle.
- File-type icons in Google colors (folder, doc, sheet, slide).
- **Data:** add suggestion query options to `features/drive/queries.ts`;
  suggestions are a pure transform over existing Drive data (recent / shared /
  modified). Render explicit loading, empty, and backend-offline states.
- Keep the left Drive sidebar (My Drive / Shared / Recent / Starred / Trash /
  Storage) — restyle only.

## Phase 4 — Sweep remaining pages

Apply the foundation, then targeted per-page fixes. Each page gets its own
implementation-plan checklist; fixes are limited to density, surfaces,
headers, and control styling — no redesigns.

- **chat** — message density, composer, room list surfaces.
- **docs** — editor chrome, doc list rows.
- **calendar** — grid lines, event chips, header controls.
- **meet** — tiles, controls bar, right rail.
- **assistant** — message/tool-card surfaces, right-rail panel.
- **search** — results table density, filter chips.
- **settings / admin** — section cards, form controls, headers.

## Error & edge handling

- Drive backend offline: keep the existing offline banner; Suggested sections
  show an empty state rather than erroring.
- Empty data (no suggestions, empty inbox): Google-style empty states.
- Light mode: must remain legible and consistent after token changes — verify
  visually, no regressions, even though it is not pixel-tuned.
- No layout shift / overflow at the existing supported viewport widths.

## Testing & verification

- Existing Vitest suites (`mail-shell.test.tsx`, `drive-shell.test.tsx`,
  `shell.test.tsx`, etc.) must still pass; update assertions only where markup
  intentionally changed.
- `pnpm lint` and `pnpm typecheck` clean.
- `pnpm audit:a11y` — no new accessibility regressions (contrast in
  particular, given the darker palette).
- Visual verification: screenshot each page via the dev server and compare
  against the reference screenshots / Google apps at each phase.

## Risks

- **Contrast on dark palette:** near-black canvas + muted text can fail
  contrast. Mitigate by checking `audit:a11y` and tuning `--foreground` /
  `--muted-foreground`.
- **Large `styles.css`:** per-feature class sprawl makes the sweep tedious.
  Mitigate by changing tokens centrally and restyling feature blocks in place.
- **Test coupling to markup:** dense-row restructure in Mail/Drive may break
  DOM-coupled tests; budget time to update them alongside the components.

## Notes

- The repo is not a git repository, so this design document cannot be
  committed; it lives at
  `docs/superpowers/specs/2026-05-20-google-ui-alignment-design.md`.
