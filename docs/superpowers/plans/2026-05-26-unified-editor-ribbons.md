# Unified Editor Ribbons (Docs / Sheets / Slides) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three divergent editor chromes (Docs / Sheets / Slides) with one unified, Google-Workspace-style shell: app bar + menu bar + ribbon + collapsible tabbed side panel. Build the primitives once in `helix-editors/packages/ui-kit` and consume them from `helix-workspace/apps/web` to align with ADR-0006.

**Architecture:** Headless-ish React components shipped from `@helix/editors-ui`. Built on Radix UI primitives (already used in helix-workspace), styled with Tailwind v4 classes + the existing `--surface`, `--accent`, `--border`, etc. CSS variables. Each editor composes the same atoms (`EditorAppBar`, `EditorMenuBar`, `EditorRibbon`, `EditorSidePanel`, `EditorWorkspace`) but supplies its own menu items, ribbon groups, and side panel tabs.

**Tech Stack:** React 19 (consumer) / 18.x peer-dep ui-kit · Radix UI · Tailwind v4 · `class-variance-authority` · `lucide-react` · `cmdk` · TypeScript 5.7 · Vitest · Ladle (ui-kit dev surface).

---

## Background — Why this exists

Audited 2026-05-26:

| Aspect | Docs | Sheets | Slides |
|---|---|---|---|
| Chrome layers above content | Shell header (L750 native-document-shell.tsx) + card-style format toolbar (L1129 native-document-editor.tsx) | 3 stacked rows: title/tabs/exports + flex-wrap toolbar + viewport nav | Single header row only (back, title, presence, theme, present, exports) |
| Toolbar visual | `border 1px var(--border); border-radius 6; padding 10; background var(--surface-2)` (card) | `TOOLBAR_SELECT_STYLE: {height: 32, border 1px var(--border), background var(--surface), padding 0 8px}` (flat) | **No toolbar at all** |
| Side area | 5 always-visible stacked panels (Inspector / Ask / Suggestions / Versions / Comments) | ~10 stacked sections (Assists, Charts, Pivots, Named Ranges, Frozen, Filter Views, Validation, Conditional, Merged, Protected, Comments) | Left thumbnail rail + form-style shape inspector + right comments column |
| Where chrome is rendered | Split: shell + editor | Editor only | Editor only |
| Styling system | Inline `style={...}` with CSS vars | Inline `style={...}` with CSS vars | Inline `style={...}` with CSS vars |
| Rest of helix-workspace | — | — | — | uses Tailwind classes + shadcn + Radix, **not** inline styles |

Three different paradigms, three different styling approaches, three different right-rail mental models. The unification is well overdue.

---

## File Structure

### New (in `helix-editors/packages/ui-kit/`)

```
packages/ui-kit/
├── package.json                         (modified — add deps)
├── tailwind.config.ts                   (new — for ladle preview only)
├── src/
│   ├── index.ts                         (modified — export new components)
│   ├── types.ts                         (existing)
│   ├── lib/
│   │   └── cn.ts                        (new — local cn() helper)
│   ├── tokens.css                       (new — mirror of helix-workspace tokens, for standalone consumers)
│   ├── editor-app-bar/
│   │   ├── editor-app-bar.tsx
│   │   ├── editor-app-bar.test.tsx
│   │   └── editor-app-bar.stories.tsx
│   ├── editor-menu-bar/
│   │   ├── editor-menu-bar.tsx
│   │   ├── editor-menu-bar.test.tsx
│   │   ├── editor-menu-bar.stories.tsx
│   │   └── types.ts                     (MenuItem, MenuGroup, MenuBarSchema)
│   ├── editor-ribbon/
│   │   ├── editor-ribbon.tsx            (container)
│   │   ├── ribbon-group.tsx
│   │   ├── ribbon-button.tsx            (icon button, optional label)
│   │   ├── ribbon-toggle.tsx            (sticky pressed state)
│   │   ├── ribbon-select.tsx            (dropdown)
│   │   ├── ribbon-color-picker.tsx      (swatch grid + custom)
│   │   ├── ribbon-divider.tsx
│   │   ├── editor-ribbon.test.tsx
│   │   └── editor-ribbon.stories.tsx
│   ├── editor-side-panel/
│   │   ├── editor-side-panel.tsx        (collapsible, tabbed, resizable)
│   │   ├── side-panel-tab.tsx
│   │   ├── editor-side-panel.test.tsx
│   │   └── editor-side-panel.stories.tsx
│   └── editor-workspace/
│       ├── editor-workspace.tsx         (grid layout: optional left rail / canvas / side panel)
│       ├── editor-workspace.test.tsx
│       └── editor-workspace.stories.tsx
```

### Modified (in `helix-workspace/apps/web/`)

```
apps/web/
├── package.json                                                       (add @helix/editors-ui dep)
├── tailwind / vite config                                             (add ui-kit dist to content)
└── src/features/
    ├── docs/
    │   ├── native-document-shell.tsx       (refactor — use EditorAppBar/MenuBar/Ribbon)
    │   ├── native-document-editor.tsx      (refactor — drop NativeDocumentFormattingToolbar, FORMAT_TOOLBAR_STYLE, EDITOR_HEADER_STYLE)
    │   ├── native-document-comments-rail.tsx     (refactor — render inside EditorSidePanel as a tab)
    │   ├── native-document-suggestions-rail.tsx  (refactor — tab)
    │   ├── native-document-versions-rail.tsx     (refactor — tab)
    │   └── *.test.tsx                       (update)
    ├── sheets/
    │   ├── sheets-shell.tsx                 (refactor — use shared chrome)
    │   ├── native-spreadsheet-editor.tsx    (refactor — replace toolbar + right rail)
    │   └── *.test.tsx                       (update)
    └── slides/
        ├── slides-shell.tsx                 (refactor)
        ├── native-presentation-editor.tsx   (refactor — ADD ribbon; move inspector to side panel)
        └── *.test.tsx                       (update)
```

---

## Component contracts (defined once here, referenced by all tasks)

```ts
// editor-app-bar
export interface EditorAppBarProps {
  onBack?: () => void;
  title: string;
  onTitleChange?: (next: string) => void;
  status?: { kind: "saving" | "saved" | "live" | "offline" | "error"; label?: string };
  presence?: Array<{ id: string; name: string; color: string; avatarUrl?: string }>;
  // toggles the side panel; controlled
  sidePanelOpen?: boolean;
  onSidePanelToggle?: () => void;
  // editor-specific action buttons rendered before the menu cluster
  actions?: React.ReactNode;
}

// editor-menu-bar
export type MenuCommand = {
  id: string;
  label: string;
  keybinding?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  onSelect: () => void;
};
export type MenuSeparator = { kind: "separator" };
export type MenuSubmenu = { id: string; label: string; items: MenuItem[] };
export type MenuItem = MenuCommand | MenuSeparator | MenuSubmenu;
export interface MenuBarMenu {
  id: string;          // "file" | "edit" | "view" | "insert" | "format" | "tools" | "help" | "ai" | "share"
  label: string;
  items: MenuItem[];
}
export interface EditorMenuBarProps { menus: MenuBarMenu[] }

// editor-ribbon
export interface EditorRibbonProps {
  children: React.ReactNode;   // RibbonGroup[]
  ariaLabel?: string;
}
export interface RibbonGroupProps {
  children: React.ReactNode;
  label?: string;              // small label under group (optional, off by default)
}
export interface RibbonButtonProps {
  icon: React.ReactNode;
  label: string;                // for tooltip + aria-label
  onClick: () => void;
  pressed?: boolean;            // for toggles
  disabled?: boolean;
  keybinding?: string;          // shows in tooltip
}
export interface RibbonSelectProps<T> {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string; icon?: React.ReactNode }>;
  label?: string;               // aria
  width?: number;
}

// editor-side-panel
export interface SidePanelTab {
  id: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;               // unread/comment count
  content: React.ReactNode;
}
export interface EditorSidePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: SidePanelTab[];
  activeTabId: string;
  onActiveTabChange: (id: string) => void;
  width?: number;               // default 320; clamp 280-480
}

// editor-workspace
export interface EditorWorkspaceProps {
  leftRail?: React.ReactNode;   // slides thumbnails; null for docs/sheets
  leftRailWidth?: number;       // default 280
  children: React.ReactNode;    // canvas
  sidePanel?: React.ReactNode;  // <EditorSidePanel ... />
}
```

These types live in `packages/ui-kit/src/<component>/*.tsx`. Reference them from every Phase 2/3/4 task.

---

## Phase 0 — Cross-repo plumbing

### Task 0.1: Add @helix/editors-ui to helix-workspace web app

**Files:**
- Modify: `helix-workspace/apps/web/package.json`
- Modify: `helix-editors/packages/ui-kit/package.json` (add proper deps)
- Modify: `helix-editors/packages/ui-kit/src/index.ts` (placeholder exports)

- [ ] **Step 1: Add dependency in apps/web/package.json**

Add to `dependencies`:
```json
"@helix/editors-ui": "file:../../../helix-editors/packages/ui-kit"
```
(Matches the pattern already used by `helix-editors/packages/core-app/package.json:devDependencies` for `@helix/sdk-types`.)

- [ ] **Step 2: Add runtime deps to ui-kit/package.json**

Add to `dependencies`:
```json
"class-variance-authority": "^0.7.1",
"clsx": "^2.1.1",
"lucide-react": "^1.16.0",
"radix-ui": "^1.4.3",
"tailwind-merge": "^3.6.0"
```

- [ ] **Step 3: Build ui-kit and link**

```bash
cd /Users/mj/mjcode/helix-all/helix-editors/packages/ui-kit
pnpm install
pnpm build
cd /Users/mj/mjcode/helix-all/helix-workspace
pnpm install
```

Expected: `apps/web/node_modules/@helix/editors-ui` resolves to the file: target.

- [ ] **Step 4: Verify import works from web**

In `apps/web/src/components/devtools.tsx` (or another safe file), add a temporary import:
```ts
import type { EditorShellState } from "@helix/editors-ui";
```
Run `pnpm --filter @helix/web typecheck`. Expected: passes. Remove the test import.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json
cd ../helix-editors && git add packages/ui-kit/package.json packages/ui-kit/src/index.ts
git commit -m "chore: wire @helix/editors-ui into apps/web"
```

### Task 0.2: Add Tailwind content path for ui-kit + tokens.css

**Files:**
- Create: `helix-editors/packages/ui-kit/src/tokens.css`
- Modify: `helix-workspace/apps/web/src/styles.css` (or wherever Tailwind v4 `@source` declarations live)

- [ ] **Step 1: Create tokens.css mirror**

Copy the `:root { ... }` and `:root.dark { ... }` blocks from `apps/web/src/styles.css` (the `--bg`, `--surface*`, `--text*`, `--accent*`, `--shadow*`, `--row-h`, `--radius` set) into `helix-editors/packages/ui-kit/src/tokens.css`. This file is for standalone consumers (the future editor-shell-dev app) — helix-workspace doesn't import it, since it already defines the same vars.

- [ ] **Step 2: Tell Tailwind v4 to scan ui-kit dist**

In `apps/web/src/styles.css` (Tailwind v4 uses `@source` in CSS, not a JS config):
```css
@source "../../../helix-editors/packages/ui-kit/dist/**/*.{js,jsx}";
```

- [ ] **Step 3: Verify**

Run `pnpm --filter @helix/web dev`. Expected: dev server starts, no Tailwind warnings about unscanned ui-kit classes.

- [ ] **Step 4: Commit**

```bash
git commit -am "chore: scan @helix/editors-ui for Tailwind classes"
```

---

## Phase 1 — Shared chrome primitives

> All Phase 1 work happens in `helix-editors/packages/ui-kit/`. Each task: write tests + Ladle story + implementation, run vitest + ladle build, commit.

### Task 1.1: cn() helper + base setup

- [ ] Create `src/lib/cn.ts`:
```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
```
- [ ] Add `vitest.config.ts` if not present (jsdom env, react plugin).
- [ ] Commit `chore(ui-kit): add cn() helper`.

### Task 1.2: EditorAppBar

**Visual contract:** height 48px, `bg-[var(--surface)] border-b border-[var(--border)] flex items-center gap-2 px-3`.

- [ ] Test `editor-app-bar.test.tsx`: renders title, calls onBack, shows status icon for each kind, renders presence avatars, calls onSidePanelToggle when icon clicked.
- [ ] Implement: editable title becomes `<input>` on click (autofocus + select-all, blur to commit, Enter to commit, Esc to revert). Status uses `lucide-react` icons (`Loader2 animate-spin` saving, `CloudCheck` saved, `Users` live, `CloudOff` offline, `AlertCircle` error). Presence: stacked avatars (max 4 visible, `+N` more chip). Right cluster: `actions` slot, then comments-toggle icon-button.
- [ ] Ladle story with three variants: idle / saving / collab.
- [ ] Commit `feat(ui-kit): EditorAppBar`.

### Task 1.3: EditorMenuBar

**Visual contract:** height 28px, `flex items-center gap-1 px-2 bg-[var(--surface)] border-b border-[var(--border)] text-sm`.

- [ ] Test: each menu opens a Radix DropdownMenu on click and on hover-after-open (mouse-glide between menus). Keybinding text right-aligned in items. Submenus open right. Separators render. Disabled items don't fire. AI and Share menus are just menus with different `id`s.
- [ ] Implement using `radix-ui` `DropdownMenu` primitive. State: which menu is open (single source of truth across all menus enables glide).
- [ ] Ladle story: full File/Edit/View/Insert/Format/Tools/Help + AI + Share with stub commands.
- [ ] Commit `feat(ui-kit): EditorMenuBar`.

### Task 1.4: EditorRibbon + atoms

**Visual contract:** ribbon height 44px, `flex items-center gap-1 px-2 bg-[var(--surface)] border-b border-[var(--border)]`.

Atoms:
- **RibbonGroup**: `flex items-center gap-0.5` + optional 24px-tall right divider; min-width auto.
- **RibbonButton**: 32px square (`size-8`), `rounded-md hover:bg-[var(--surface-2)] data-[pressed=true]:bg-[var(--accent-soft)] data-[pressed=true]:text-[var(--accent)] aria-disabled:opacity-50`. Tooltip via Radix Tooltip with label + keybinding.
- **RibbonToggle**: same as button but tracks `pressed` via aria-pressed.
- **RibbonSelect**: 32px tall, `rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm flex items-center gap-1`. Opens Radix DropdownMenu listing options.
- **RibbonColorPicker**: trigger is a 32px button with a colored underline; opens a popover with a 6-col swatch grid + "Custom" input.
- **RibbonDivider**: 1px × 24px `bg-[var(--border)]` with `mx-1`.

- [ ] Test each atom in isolation (clicks fire, pressed state shows, tooltips render, disabled state, swatches select).
- [ ] Test container: wraps with horizontal scroll on overflow (no wrap — Google Docs behavior). `overflow-x-auto scrollbar-thin`.
- [ ] Ladle stories: rich story showing all atoms grouped like the Docs target.
- [ ] Commit `feat(ui-kit): EditorRibbon + atoms`.

### Task 1.5: EditorSidePanel

**Visual contract:** width 320px (clamp 280–480), `border-l border-[var(--border)] bg-[var(--surface)] flex flex-col`. Tab strip at top: `h-10 border-b border-[var(--border)] flex items-center gap-0.5 px-1`. Active tab: `bg-[var(--surface-2)] text-[var(--text)]`. Inactive: `text-[var(--text-2)] hover:bg-[var(--surface-2)]`. Body: `flex-1 overflow-y-auto`.

- [ ] Test: open/close toggling collapses to width 0 (animated). Active tab content renders, others lazy-skip. Badge dot on tab when content has unread state. Drag-handle on left edge resizes (mouse + keyboard arrow keys for a11y).
- [ ] Implement using Radix Tabs primitive for state management + accessibility.
- [ ] Ladle story with 4 tabs: Comments, Suggestions, Versions, Outline.
- [ ] Commit `feat(ui-kit): EditorSidePanel`.

### Task 1.6: EditorWorkspace

**Visual contract:** grid with three optional columns. When leftRail present and sidePanel present: `grid-cols-[280px_minmax(0,1fr)_var(--side-panel-w)]`. When side panel closed: collapses to `grid-cols-[280px_minmax(0,1fr)]`. When leftRail absent: `grid-cols-[minmax(0,1fr)_var(--side-panel-w)]`. Sets `--side-panel-w` CSS variable from the EditorSidePanel via context (or parent prop).

- [ ] Test: renders all three configurations correctly. Resize updates grid.
- [ ] Implement layout component + a `EditorChromeProvider` context that holds `sidePanelOpen`, `sidePanelWidth`, `activeTabId`, etc., so AppBar's toggle + SidePanel + Workspace stay in sync.
- [ ] Ladle story shows the docs layout (no left rail) and the slides layout (with left rail).
- [ ] Commit `feat(ui-kit): EditorWorkspace + chrome context`.

### Task 1.7: Export, build, integration smoke

- [ ] Update `src/index.ts` to re-export all new components + types.
- [ ] Run `pnpm --filter @helix/editors-ui build`. Confirm `dist/` populated.
- [ ] In `helix-workspace`, write a throwaway file `apps/web/src/features/_smoke-ui-kit.tsx` that renders `<EditorAppBar>` and `<EditorRibbon>` to verify Tailwind classes apply and types resolve. Visually check via `pnpm --filter @helix/web dev`. Delete the file when satisfied.
- [ ] Commit `chore(ui-kit): export public surface`.

---

## Phase 2 — Refactor Docs editor

> Read `apps/web/src/features/docs/native-document-shell.tsx` and `native-document-editor.tsx` in full before starting. The existing chrome is at `native-document-shell.tsx:737-763` (TOOLBAR_STYLE) and `native-document-editor.tsx:777-782` + `:1129-:1159` + `:2306` (FORMAT_TOOLBAR_STYLE).

### Task 2.1: Define Docs menus + ribbon schema

**Files:**
- Create: `apps/web/src/features/docs/native-document-chrome.tsx`

A schema file that exports two functions:
```ts
export function buildDocsMenus(ctx: DocsChromeContext): MenuBarMenu[] { ... }
export function buildDocsRibbon(ctx: DocsChromeContext): React.ReactNode { ... }
```

`DocsChromeContext` carries the TipTap editor instance + callbacks (toggleHeading, insertEquation, openFindReplace, exportAsPDF, etc.) so the chrome stays declarative.

**Docs menu contents (full population required):**

- **File**: New document · Open (recent submenu) · — · Make a copy · Move to folder · Move to trash · — · Import (.docx/.md) · Download (PDF/DOCX/Markdown/HTML) · — · Print · Version history
- **Edit**: Undo (⌘Z) · Redo (⌘⇧Z) · — · Cut · Copy · Paste · Paste without formatting · — · Find & replace (⌘F) · — · Select all · Delete
- **View**: Show outline · Show comments · Show suggestions · Show versions · — · Compact mode · Full screen · — · Zoom in / out / reset
- **Insert**: Image (upload / from Drive / from URL) · Table · Horizontal line · Page break · — · Link (⌘K) · Comment (⌘⌥M) · Footnote · — · Equation · Table of contents · — · Special characters
- **Format**: Text (B/I/U/S, sub/super) · Paragraph styles (Normal/H1-H6) · Align & indent · Line spacing · Lists (bullets/numbered/checklist) · — · Clear formatting · — · Borders & shading
- **Tools**: Spelling & grammar · Word count · — · Dictionary · Translate document · — · Preferences · Accessibility check
- **Help**: Docs help · Keyboard shortcuts (⌘/) · — · Report a problem · About Helix Docs
- **AI**: Ask this document · Summarize · Rewrite tone (Professional/Friendly/Concise submenu) · Suggest title · Draft from prompt · — · AI settings
- **Share**: Share with people · Get link · — · Publish to web · Permissions · Audit log

**Docs ribbon groups (left to right):**

1. **Undo** (RibbonGroup): ↶ Undo, ↷ Redo
2. **Style** (RibbonGroup): Paragraph style Select (Normal/H1/H2/H3/Quote/Code), Font family Select (system / serif / mono), Font size Select (8–72)
3. **Text** (RibbonGroup): B / I / U / S Toggles, Color picker, Highlight picker
4. **Align** (RibbonGroup): Left / Center / Right / Justify Toggles, Line-spacing Select
5. **List** (RibbonGroup): Bulleted, Numbered, Checklist, Decrease/Increase indent
6. **Insert** (RibbonGroup): Link, Image, Table, Equation, Footnote, Comment
7. **Tools** (RibbonGroup): TOC, Find/Replace, Word count

- [ ] Write the schema file with all menus + ribbon fully populated. Wire each command to either an existing TipTap command (`editor.chain().focus().toggleBold().run()`) or a callback prop.
- [ ] Add `native-document-chrome.test.tsx` covering: menu emits onSelect; ribbon B/I/U toggles map to editor state; disabled state respects editor `canUndo`.
- [ ] Commit `feat(docs): chrome schema`.

### Task 2.2: Wire chrome into native-document-shell.tsx

- [ ] Replace `TOOLBAR_STYLE` header and `NativeDocumentFrame` chrome with:
```tsx
<EditorAppBar title={title} onTitleChange={renameDocument} status={status} presence={collaborators}
  onSidePanelToggle={toggleSidePanel} sidePanelOpen={sidePanelOpen}
  actions={<ShareButton /> /* present button only for slides */} />
<EditorMenuBar menus={buildDocsMenus(ctx)} />
<EditorRibbon>{buildDocsRibbon(ctx)}</EditorRibbon>
```
- [ ] Wrap the article + side rail in `<EditorWorkspace sidePanel={<EditorSidePanel ... />}>`.
- [ ] Remove `EDITOR_HEADER_STYLE`, `FORMAT_TOOLBAR_STYLE`, `NativeDocumentFormattingToolbar`, `EDITOR_STATUS_STYLE`, `SIDE_RAIL_STYLE`, and the inline equation / find-replace forms from `native-document-editor.tsx`. The find/replace + equation become **menu-launched modals** (Insert > Equation; Edit > Find & replace).
- [ ] Update `native-document-shell.test.tsx` + `native-document-editor.test.tsx` to match new query targets (`role="menubar"`, `role="toolbar"` for ribbon, `role="tab"` for side panel tabs).
- [ ] Commit `refactor(docs): adopt unified editor chrome`.

### Task 2.3: Port comments / suggestions / versions rails into side panel tabs

- [ ] In `native-document-shell.tsx`, build the `tabs: SidePanelTab[]` array:
```tsx
const tabs: SidePanelTab[] = [
  { id: "comments", label: "Comments", icon: <MessageSquare />, badge: unresolvedCommentCount,
    content: <NativeDocumentCommentsRail .../> },
  { id: "suggestions", label: "Suggestions", icon: <Edit3 />, badge: openSuggestionCount,
    content: <NativeDocumentSuggestionsRail .../> },
  { id: "versions", label: "Versions", icon: <History />, content: <NativeDocumentVersionsRail .../> },
  { id: "outline", label: "Outline", icon: <List />, content: <DocumentInspector .../> },
  { id: "ask", label: "Ask", icon: <Sparkles />, content: <NativeDocumentAskPanel .../> },
];
```
- [ ] Drop the wrapper `aside` + `SIDE_RAIL_STYLE` from native-document-shell.tsx — each rail component should now render edge-to-edge inside the panel body. May need minor padding adjustments in each child component.
- [ ] Update tests in `native-document-comments-rail.test.tsx`, `native-document-suggestions-rail.test.tsx`, `native-document-versions-rail.test.tsx` — they previously mounted the rails directly; now they should still work because the rails render the same content, just inside a tab container.
- [ ] Commit `refactor(docs): rails → side panel tabs`.

### Task 2.4: Visual + a11y check

- [ ] `pnpm --filter @helix/web dev`, navigate to a doc, verify:
  - Title editable inline
  - All menus open, items fire, keybindings shown
  - Ribbon toggles reflect editor state (place caret in bold text → B is pressed)
  - Side panel toggles open/closed; tabs switch
- [ ] `pnpm --filter @helix/web audit:a11y` against the docs route; resolve any new violations.
- [ ] Commit any tweaks `fix(docs): polish chrome a11y`.

### Task 2.5: Update TaskList

```bash
TaskUpdate Phase 2 → completed
```

---

## Phase 3 — Refactor Sheets editor

> Read `apps/web/src/features/sheets/native-spreadsheet-editor.tsx` lines 2250-4210 (toolbar block) and 3176+ (side panel) before starting. The file is 325KB — many controls.

### Task 3.1: Define Sheets menus + ribbon schema

**Files:**
- Create: `apps/web/src/features/sheets/native-spreadsheet-chrome.tsx`

**Sheets menu contents:**

- **File**: New sheet · Open · Make a copy · Move/Trash · Import (XLSX/CSV/TSV/ODS) · Download (XLSX/CSV/TSV/ODS/PDF) · Print · Version history
- **Edit**: Undo/Redo · Cut/Copy/Paste/Paste-special (values/formulas/format) · Find & replace · — · Delete row/column/cells · Clear formatting/values · Select all
- **View**: Show formula bar · Show gridlines · Show formulas · — · Freeze (none/1row/2rows/1col/2cols/upto cursor) · Group/Ungroup · — · Full screen
- **Insert**: Cells above/below/left/right · Row above/below · Column left/right · — · Chart · Pivot table · Image · Drawing · Function (submenu of categories) · Link · Comment · Note · Checkbox · Dropdown · — · Sheet (new tab)
- **Format**: Number (Plain/Number/Currency/Percent/Date/Time/Duration/Custom) · Text (B/I/U/S/sub/super) · Alignment (h/v/wrap) · Borders · Colors · — · Merge cells · Conditional formatting · Alternating colors · Clear formatting
- **Data**: Sort range A→Z / Z→A · Sort sheet by column · — · Create filter · Filter views (list submenu) · — · Data validation · Protected ranges · Named ranges · Slicer · — · Remove duplicates · Trim whitespace
- **Tools**: Spelling · — · Macros (Record / Manage) · Preferences · Accessibility
- **Help**: Sheets help · Keyboard shortcuts · Function list · Report a problem · About
- **AI**: Ask this sheet · Suggest formula · Explain selection · Summarize range · Generate chart · Fill from pattern · — · AI settings
- **Share**: Share with people · Get link · Publish to web · Permissions

**Sheets ribbon groups (left to right):**

1. **Undo**: ↶ ↷
2. **Format Painter** (single button)
3. **Font**: Font family Select, Font size Select (currently missing — ADD)
4. **Text**: B / I / U (ADD) / S (ADD), Text color picker, Fill color picker
5. **Number**: Number format Select (existing list), Decrease/Increase decimals, % $
6. **Align**: H-align (L/C/R), V-align (T/M/B), Wrap (overflow/wrap/clip), Merge (ADD as button), Rotation
7. **Borders**: Borders picker (8 presets + style + color)
8. **Data**: Sort A-Z, Sort Z-A, Filter toggle
9. **Insert**: Chart, Pivot, Image, Function dropdown
10. **Cell**: Insert row above/below, Insert col left/right, Delete row, Delete col (existing primitives)

The **formula bar** (`fx [    formula input    ]`) goes **below the ribbon**, above the grid — it's a separate strip, not part of the ribbon. Add it as a sibling element in `native-spreadsheet-editor.tsx`'s layout, height 32, `flex items-center gap-2 px-2 bg-[var(--surface)] border-b border-[var(--border)]`.

- [ ] Write schema, wire commands to existing spreadsheet ops.
- [ ] Write `native-spreadsheet-chrome.test.tsx`.
- [ ] Commit `feat(sheets): chrome schema`.

### Task 3.2: Wire chrome into native-spreadsheet-editor.tsx

- [ ] Identify and delete:
  - The title+tabs+exports row (currently rolled into one)
  - The flex-wrap formatting toolbar (lines 2400-2850)
  - The viewport navigation toolbar (line 2997, VIEWPORT_TOOLBAR_STYLE) — replace with keyboard-only navigation; alternatively keep as a tiny "go to row" input in the status bar at the bottom
- [ ] Replace with `<EditorAppBar><EditorMenuBar><EditorRibbon><FormulaBar><GridContainer>`.
- [ ] Sheet tabs (currently in the top row) move to a **bottom tab strip** like real Sheets/Excel: 32px tall, `border-t border-[var(--border)] bg-[var(--surface-2)]`, sheet pills + "+" button + sheet navigation arrows.
- [ ] Commit `refactor(sheets): adopt unified editor chrome + bottom sheet tabs`.

### Task 3.3: Port the 10+ stacked right rail sections into side panel tabs

Map current sections → side panel tabs:

| Current section | Side panel tab |
|---|---|
| Comments | Comments |
| Charts | Charts |
| Pivot Tables | Pivots |
| Named Ranges | Names |
| Merged Cells | (merge to Cells tab — group with Frozen, Validation, Conditional) |
| Frozen Panes | Cells |
| Saved Filter Views | Filters |
| Protected Ranges | Permissions |
| Data Validation | (merge to Cells tab) |
| Conditional Formatting | (merge to Cells tab) |
| Assists | AI |

Resulting tabs (in order): **Comments · Charts · Pivots · AI · Cells · Filters · Names · Permissions**.

- [ ] Implement the `tabs: SidePanelTab[]` array. Each tab's content is the existing section markup, lifted out of the stacked rail wrapper. Light restyling to remove the section header (now the tab label) and the section divider (now the tab boundary).
- [ ] Update sheet tests.
- [ ] Commit `refactor(sheets): right rail → side panel tabs`.

### Task 3.4: Add the missing ribbon controls

Today Sheets has **no font picker, no font size, no underline/strikethrough, no merge button in the ribbon**. Add them now since the schema already declares them.

- [ ] Wire font/size to a cell-style field (may require adding `fontFamily` and `fontSize` to the sheets model if not present — check `apps/web/src/features/sheets/model.ts`).
- [ ] Wire underline/strikethrough to existing text-style cell attributes (may also be missing).
- [ ] Wire merge button to existing merge ops.
- [ ] Add tests for each new control.
- [ ] Commit `feat(sheets): add font/size/underline/strikethrough/merge ribbon controls`.

### Task 3.5: Visual + a11y check, mark Phase 3 done.

---

## Phase 4 — Refactor Slides editor

> Read `apps/web/src/features/slides/native-presentation-editor.tsx` HEADER_STYLE / BODY_STYLE / INSPECTOR_STYLE blocks (~lines 7300, 7360, 3774, 7700, 7430) before starting.

### Task 4.1: Define Slides menus + ribbon schema

**Files:**
- Create: `apps/web/src/features/slides/native-presentation-chrome.tsx`

**Slides menu contents:**

- **File**: New presentation · Open · Make a copy · Move/Trash · Import (PPTX/Keynote) · Download (PPTX/PDF/SVG ZIP/PNG slides) · Print · Version history · Page setup
- **Edit**: Undo/Redo · Cut/Copy/Paste/Paste-special · Duplicate slide · Delete slide · Find & replace · Select all on slide
- **View**: Show speaker notes · Show comments · Show animations · Show transitions · — · Filmstrip view · Grid view · Outline view · — · Master · Show ruler/gridlines · — · Full screen / Present (⌘⏎)
- **Insert**: Text box · Image (upload/Drive/URL) · Video · Audio · Shape (rect/oval/line/arrow/connector — submenu) · Table · Chart · Link · Comment · Speaker note · — · New slide (with layout submenu) · Slide number · Date
- **Format**: Text (B/I/U/S, font, size, color) · Bullets · Align & spacing · — · Shape fill / outline / shadow · Arrange (front/back/forward/backward) · Align (L/C/R/T/M/B/distribute) · Group / Ungroup · Rotate · Crop · — · Animations · Transitions · — · Background · Theme
- **Tools**: Spelling · Voice type speaker notes · — · Preferences · Accessibility
- **Help**: Slides help · Keyboard shortcuts · Report a problem · About
- **AI**: Ask this deck · Suggest layout · Rewrite bullets · Draft notes · Generate slide from prompt · Image search · — · AI settings
- **Share**: Share with people · Get link · Publish to web · Permissions

**Slides ribbon groups:**

1. **Undo**: ↶ ↷
2. **Font**: Family Select, Size Select
3. **Text**: B / I / U / S, Color, Highlight
4. **List**: Bulleted, Numbered, Increase/Decrease indent
5. **Align**: H-align (L/C/R/J), Line spacing
6. **Insert**: Text box, Shape (dropdown), Image, Media, Table
7. **Arrange**: Front, Back, Forward, Backward, Group, Ungroup, Align (dropdown: align L/C/R, distribute H/V)
8. **Slide**: Layout Select (existing — Title/Bullets/Agenda/Stats/Split/Image), Transition Select
9. **Present** (right-aligned, distinct): Big Present button

App bar actions slot: Theme dropdown (existing), Add slide button, Present button (or only in ribbon, not both — pick one. Recommend: keep in app bar for prominence).

- [ ] Write schema, wire commands.
- [ ] Tests.
- [ ] Commit `feat(slides): chrome schema`.

### Task 4.2: Wire chrome into native-presentation-editor.tsx

- [ ] Replace HEADER_STYLE block (back/title/collab/theme/add/present/exports) with `<EditorAppBar>`.
- [ ] Add `<EditorMenuBar>` + `<EditorRibbon>` (NEW — none today).
- [ ] Replace BODY_STYLE 2-column grid with `<EditorWorkspace leftRail={<ThumbnailRail/>} sidePanel={<EditorSidePanel.../>}>`. The 3rd column (current canvas-column-inspector grid `gridTemplateColumns: "minmax(360px, 1fr) 320px"`) collapses — the inspector moves into side panel as the **Format** tab.
- [ ] Commit `refactor(slides): adopt unified editor chrome + ribbon (new)`.

### Task 4.3: Move shape inspector form into the Format tab

The current inspector (INSPECTOR_STYLE, line 3774) is a long vertically-stacked form with fieldsets for:
- Slide-level (layout, AI suggestions, title, transition, layout-specific fields, speaker notes)
- Shape-level (kind, text, image props, media props, position/size, tone, animation)

Split this into TWO side panel tabs:

- **Slide tab** (icon: `Slide` from lucide or `Square`): slide-level fields. Open by default when no shape selected.
- **Format tab** (icon: `Settings2`): shape-level fields. Auto-activates when a shape is selected. Shows the **selected shape's** props.

Plus:
- **Animations tab** (icon: `Sparkles`): the existing DeckAnimationTimelineTable.
- **Media tab** (icon: `Image`): the existing DeckMediaAssetTable.
- **Notes tab** (icon: `StickyNote`): the speaker-notes textarea + per-slide notes.
- **Comments tab** (icon: `MessageSquare`): the existing comments thread list.

Tab order: **Comments · Format · Slide · Animations · Media · Notes**.

- [ ] Extract the inspector form fields into smaller components in `apps/web/src/features/slides/inspectors/{slide.tsx, format.tsx, animations.tsx, media.tsx, notes.tsx}`. Each takes the current selection state from props/context.
- [ ] Wire into the side panel tabs.
- [ ] Selection logic: when a shape is selected, `activeTabId` auto-switches to `"format"` once (user can still navigate away).
- [ ] Tests.
- [ ] Commit `refactor(slides): inspector → side panel tabs`.

### Task 4.4: Keep the thumbnail rail as the EditorWorkspace left rail

- [ ] Move the current 280px THUMB_RAIL_STYLE column markup into `apps/web/src/features/slides/slide-thumbnail-rail.tsx`.
- [ ] Pass to `EditorWorkspace leftRail={...}`.
- [ ] Confirm: thumbnail count, hover actions (move up/down/duplicate/delete), keyboard navigation all still work.
- [ ] Commit `refactor(slides): isolate thumbnail rail`.

### Task 4.5: Visual + a11y check, mark Phase 4 done.

---

## Phase 5 — Cross-editor QA + cleanup

### Task 5.1: Side-by-side visual comparison

- [ ] In dev, open Docs, Sheets, Slides in three browser tabs. Confirm:
  - App bar identical height + identical title affordance
  - Menu bar identical (same separators, same hover/active style)
  - Ribbon identical height, dividers, button look
  - Side panel identical width, tab strip, open/close animation
  - All three respect light + dark mode
- [ ] Capture screenshots into `docs/visual-review.md` under a new "2026-05 unified editor chrome" section.

### Task 5.2: Dead code sweep

Search and delete leftover constants:

```bash
grep -rn -E "TOOLBAR_STYLE|FORMAT_TOOLBAR_STYLE|EDITOR_HEADER_STYLE|EDITOR_STATUS_STYLE|TOOLBAR_SELECT_STYLE|VIEWPORT_TOOLBAR_STYLE|HEADER_STYLE|BODY_STYLE|INSPECTOR_STYLE|CANVAS_COLUMN_STYLE|COMMENTS_RAIL_STYLE|SIDE_RAIL_STYLE|PAGE_WRAP_STYLE|THUMB_RAIL_STYLE|THUMB_ROW_STYLE" apps/web/src
```

Each remaining hit needs to be either deleted or justified in a comment. Update test fixtures.

- [ ] Commit `chore: remove legacy editor toolbar/inspector style constants`.

### Task 5.3: Accessibility audit pass

- [ ] Run `pnpm --filter @helix/web audit:a11y` and resolve any new violations.
- [ ] Manually keyboard-navigate each editor: Tab through menu bar → ribbon → into editor content → into side panel → back to menu bar. No traps, focus rings visible.
- [ ] Verify all menu items have keybindings shown in the menu (Format menu items show their keybindings).
- [ ] Commit `fix: a11y issues from unified editor chrome rollout`.

### Task 5.4: Update PRD / specs / docs references

- [ ] Search `PRD.md` and `docs/specs/03-editors/` for any mention of the old toolbar / rail patterns. Update.
- [ ] Add a short "Editor chrome — design notes" section to `docs/visual-review.md` documenting the AppBar / MenuBar / Ribbon / SidePanel pattern + the EditorAppBar/MenuBar/Ribbon/SidePanel/Workspace contracts.
- [ ] Commit `docs: capture unified editor chrome design`.

### Task 5.5: Open PR

- [ ] `git push -u origin <branch>`
- [ ] `gh pr create --title "Unified editor chrome (Docs / Sheets / Slides ribbons)" --body @<heredoc summarizing each phase>`

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| 325KB native-spreadsheet-editor.tsx hard to refactor safely | Phase 3 splits into 4 incremental tasks each independently testable; existing tests are the safety net |
| React 18 (ui-kit peer) vs React 19 (consumer) version drift | ui-kit components are stateless/Radix-based; verified via Phase 1 smoke task |
| `file:` cross-repo dep breaks CI | Document in `helix-workspace/README.md` Phase 0; CI must `pnpm install` from `helix-workspace` root after `pnpm build` in `helix-editors/packages/ui-kit` |
| Slides has no toolbar today — new ribbon = new surface area for bugs | Phase 4 adds it minimally first, then iterates; all commands wire to existing shape/slide ops |
| Right rail collapse loses always-visible feature discovery | Side panel **defaults to open** with Comments tab; users can collapse but won't lose by default |
| Bottom sheet tabs (new in Sheets) reorganize muscle memory | Acceptable — matches Excel/Sheets industry norm |
