# Shell Resilience, Accessibility, and Data-Loss Guards

> **Status:** Reconstruction plan. Derived from branch `agent/top-10-greenfield-improvements`
> (commits `a3c8a9b`, `4e57203`) compared against current `main` as of 2026-08-01.
>
> **Not** a greenfield rewrite and **not** a replacement for
> `docs/superpowers/plans/2026-07-28-core-workspace-production-readiness.md`. That plan owns
> production security, mail/Drive/Chat/agent hardening, and release evidence. This plan owns the
> unfinished **web shell UX / a11y / crash-recovery** work that was saved on the side branch after
> `main` already absorbed the production MVP program.
>
> **Target product (MVP):** Mail, Drive (storage + read-only previews), Chat, Assistant, Admin —
> as enforced by `AGENTS.md` on `main`. Native Docs/Sheets/Slides/Meet/PDF editing remain out of
> scope for this workstream.

## 1. Purpose

Reconstruct what `agent/top-10-greenfield-improvements` was trying to accomplish, decide what still
matters against current `main`, and provide an implementation-ready task list so a future agent can
land the valuable pieces without replaying the whole stale branch.

### 1.1 What the branch was trying to do

The branch name (“top-10 greenfield”) is misleading. The git history shows two distinct intents:

| Commit | Date | Intent |
| --- | --- | --- |
| `a3c8a9b` | 2026-07-28 | Document the **core workspace production-readiness** program (`AGENTS.md` + 2.1k-line plan). Explicitly states the remaining work is **not** a greenfield rewrite. |
| `4e57203` | 2026-08-01 | **Save point** of uncommitted web UI work: shell accessibility, mobile layout, offline banner, mail compose local recovery, unsaved-navigation guards, auth/search polish. Commit message says not reviewed, not rebased, not gate-checked. |

In plain language, the WIP was aiming to make the **browser shell feel safe and operable**:

1. **Do not lose user input** when a tab crashes, the network drops, or the user navigates away mid-compose.
2. **Tell the user when they are offline / back online.**
3. **Make shell chrome keyboard- and screen-reader-usable** (palette, launcher, profile menu, notifications, settings, dialogs).
4. **Make the shell usable on a phone-width viewport** (bottom rail, safe areas, no horizontal overflow).
5. **Keep settings and recovery state honest** (URL-deep-link settings; disable unavailable account actions with reasons; recovery notices).
6. **Raise baseline form/route a11y** on login, signup, invite, verify-email, and root error/not-found states.

It was **not** trying to finish production mail provider routing, Drive malware quarantine, Chat
WebSocket origin policy, agent write approvals, or release evidence. That is the production-readiness
plan (and much of it already landed on `main` via PR #3 and follow-ups).

### 1.2 Branch topology facts (as reconstructed)

```text
dd68a9a  Optimize Helix bundles… (#2)          ← merge-base with main
   |
   +-- a3c8a9b  docs: production readiness plan
   |      |
   |      +-- 4e57203  web shell WIP save point   ← agent/top-10-greenfield-improvements tip
   |
   +-- ed92abb  Harden core production MVP (#3)   ← main evolved here
   +-- … 19 more commits on main (admin, deps, activity hash, …)
   |
   main tip (2026-08-01)
```

- Branch is **2 commits ahead** of the merge-base and **~20 commits behind** `main`.
- Three-dot delta: ~64 files, +6.5k / −0.8k lines (almost all web + the readiness plan doc).
- A trial merge into `main` conflicts in at least: `AGENTS.md`, `index.html`,
  `command-palette.tsx`, `notifications-panel.tsx`, `settings-page.tsx`, `mail-shell.tsx`,
  `styles.css`, and the production-readiness plan file.
- **Do not merge the branch as-is.** Extract and re-implement selected behaviors on a branch cut
  from current `main`.

## 2. Comparison to current `main`

### 2.1 What `main` already has that the branch lacked or duplicated poorly

| Area | On `main` | On the side branch | Consequence |
| --- | --- | --- | --- |
| Production MVP boundary in `AGENTS.md` | Explicit fail-closed MVP apps | Missing | Any re-land must preserve `main`’s `AGENTS.md` |
| Production readiness plan | Landed + some tasks checked (ADRs, format gates); status says implementation authorized | Older copy; almost all checkboxes open; status still “not authorized” | Do not re-add or regress the plan file from the branch |
| Server-side mail drafts | `saveMailDraft` + `draftId` / `draftVersion` / draft save errors in compose | Local `localStorage` recovery **and** a thinner server-draft path | Local recovery is a **fallback**, not a replacement for server drafts |
| Design-token / Tailwind bridge | Landed (`88523c8`) | Based on pre-token CSS | Rebase styles carefully; prefer token-aware CSS |
| Admin console routing/chunks | Major admin work after PR #3 | Untouched | Out of scope here |
| Backend security/ops | Production assertions, migrations, domains, activity hash, etc. | Absent | Out of scope here |
| Playwright artifact paths in `e2e.yml` | `apps/web/playwright-report` | Prefixed with `helix-all/helix-workspace/…` | **Do not port** the branch e2e.yml path change; it looks wrong for this repo layout |

### 2.2 What the branch has that `main` still lacks (valuable)

These are the salvage candidates:

| Capability | Branch artifacts | Present on `main`? |
| --- | --- | --- |
| Offline / reconnected banner | `network-status.tsx` + test + styles | No |
| Local mail compose crash recovery | `mail-compose-recovery.ts` + tests + compose wiring | No (server drafts only) |
| Unsaved-navigation warning dialog | `use-unsaved-changes-warning.tsx` + tests | No |
| Settings deep-link via URL search (`?settings=…`) | `app-shell.tsx` + overlay/settings tests | No (local React state only) |
| Command palette combobox a11y + focus restore | `command-palette.tsx` + test | Partial at best |
| Dialog focus restore + body scroll lock + labelled title | `helix-dialog.tsx` + test | Weaker (no restore/scroll lock/`aria-labelledby` as complete) |
| Profile menu keyboard/focus model | `profile-menu.tsx` + test | Weaker |
| Notifications tablist / relative time / error empty states | `notifications-panel.tsx` + test | Weaker |
| Settings honesty for unavailable actions | `settings-page.tsx` + test | Weaker |
| Mobile bottom rail + safe-area layout + e2e | `styles.css` media queries + `mobile-shell-layout.spec.ts` | Partial mobile CSS; no e2e |
| Auth form error focus / `aria-invalid` / `aria-busy` | login, signup, invite, verify-email | Weaker |
| Route error / not-found focusable main regions | `__root.tsx` + test | Minimal static markup |
| Search results error retry + table a11y polish | `search-results-shell.tsx` | Partial |
| Theme-color meta + `color-scheme` from appearance store | `index.html`, `settings-store.ts` | Theme FOUC script only |
| Compose UX extras | minimize, recipient validation, recovery notice, discard confirm | Mostly absent |

### 2.3 What the branch touched that must **not** expand MVP scope

The WIP also edited native Docs/Sheets/Slides editors, Meet recording drawer, and PDF viewer
(mostly wiring `useUnsavedChangesWarning` and small chrome/a11y tweaks). Under current `AGENTS.md`:

- Do **not** enable or polish those surfaces as product features in this workstream.
- Optional: if dormant editor code remains in the tree for build compatibility, keep changes
  minimal or drop them entirely so review stays focused on Mail/Drive/Chat/shell.

### 2.4 Relationship to the production-readiness plan

| Production-readiness task | Overlap with this branch |
| --- | --- |
| Task 0.1 “land dirty branch safely” | Partially done (committed), **not** completed (never rebased onto post-MVP `main`, never PR’d cleanly) |
| Task M6 “mail user reliability” | Local recovery is one bullet; plan wants server drafts as authority + reconcile + send status + idempotency |
| Task V1 mobile shell checks | Mobile e2e sketch exists |
| Phases 1–8 security/ops | **No meaningful overlap** — already progressed on `main` |

This document **does not** re-open the production-readiness program. Where M6/V1 overlap, implement
only the client-side pieces listed below and leave server/evidence work to that plan.

## 3. Product claim this plan supports

After these tasks land on current `main`:

> Helix’s authenticated web shell is keyboard-accessible, usable on a phone-width viewport, honest
> about offline and unavailable settings, and protects in-progress Mail compose (and analogous
> dirty forms) from silent loss on navigation, reload, or tab crash — without expanding the MVP
> app boundary.

Non-claims:

- Not offline-first / full offline editing.
- Not multi-device draft sync beyond existing server draft APIs.
- Not native Docs/Sheets/Slides parity.
- Not a substitute for production mail deliverability or Drive quarantine.

## 4. Goals and non-goals

### 4.1 Goals

1. Rebase-equivalent **cherry-pick / re-implementation** of salvageable WIP onto current `main`.
2. Local compose recovery as **crash fallback** that coexists with `main`’s server drafts.
3. Unsaved-navigation guards for **Mail compose** (and any other in-MVP dirty surface that needs it).
4. Shell chrome a11y: focus management, ARIA roles, skip link / `#main-content` focus on route change.
5. Mobile shell layout with Playwright evidence at 390×844.
6. Honest settings/unavailable controls; settings section deep-links in the URL.
7. Focused unit tests beside code + targeted Playwright; full repo gates green.

### 4.2 Non-goals

- Merging `agent/top-10-greenfield-improvements` wholesale.
- Changing production config, migrations, mail provider routing, Chat crypto claims, agent policy.
- Expanding `HELIX_APPS` or `VITE_HELIX_MVP_ONLY` behavior.
- Porting the branch’s `e2e.yml` artifact path rewrite.
- Large CSS redesign unrelated to the behaviors above.
- “Top 10 greenfield” product inventing — this is hardening of the existing shell.

## 5. Design principles (normative)

1. **Server truth beats local recovery.** For Mail, `saveMailDraft` / server `draftId`+version remain
   authoritative when online. Local storage recovers only what never made it to the server (or
   cannot be loaded yet). Never silently overwrite a newer server draft with a staler local blob.
2. **Fail closed on product scope.** MVP apps only in active UX. No new Docs/Sheets/Slides controls.
3. **No inert controls.** Unavailable settings use disabled + reason (existing branch pattern).
4. **URL owns durable UI state** that must survive refresh/share/back: settings section at minimum.
5. **Accessible by default:** semantic roles, focus trap/restore, visible focus, `aria-live` for
   transient status (offline banner, recovery notice), reduced-motion respected for animations.
6. **Storage is best-effort.** Quota / private mode must not throw into the compose path.
7. **Bounded local payloads.** Keep branch limits (subject/body/recipient caps, max age 30 days).
8. **Tests prove behavior**, not just presence of markup.

## 6. Target architecture (client-only)

```text
┌─────────────────────────────────────────────────────────────┐
│ AppShell                                                    │
│  - skip link → #main-content                                │
│  - NetworkStatus (online/offline live region)               │
│  - Rail / AppLauncher / Outlet                              │
│  - NotificationsPanel / CommandPalette / SettingsPage       │
│  - settings section from URL search                         │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          v                   v                   v
   Mail Compose         Other MVP forms      Route error states
   - server drafts      - login/signup       - focusable main
   - local recovery       a11y                 labelled titles
   - unsaved blocker
   - recipient validate
```

### 6.1 Mail compose recovery state machine

```text
empty ──type──► dirty_local ──debounce write──► localStorage record
                  │                                  │
                  │ online blur/timer                │ crash / reload
                  v                                  v
            server draft (id, version)         read recovery on open
                  │                                  │
                  │ success                          │ if newer server draft exists:
                  v                                  │   prefer server; clear or keep local
            clear local when                         │   per reconcile rules (§7 Task M-REC)
            server has equal-or-newer body           v
                                              show recovery notice
```

### 6.2 Unsaved navigation

```text
dirty && leave route  → useBlocker dialog (Stay / Leave)
dirty && beforeunload → browser prompt (enableBeforeUnload)
leave with keep-draft → do not clear local recovery; allow navigation
discard               → clear local + cancel server draft path as product already defines
```

## 7. Work breakdown

Recommended PR sequence (small, reviewable). Each task lists reasoning, files, steps, tests, and
acceptance. Start from **current `main`**, not the side branch tip.

```text
Phase A: Branch hygiene and inventory
Phase B: Shared primitives (dialog, unsaved warning, network status)
Phase C: Shell chrome a11y + settings URL
Phase D: Mail compose recovery + reconcile with server drafts
Phase E: Auth / route / search a11y polish
Phase F: Mobile layout + e2e
Phase G: Validation gates and close-out
```

---

# Phase A — Hygiene and inventory

## Task A1 — Cut a clean feature branch from `main`

**Reasoning:** The side branch is 20 commits stale and conflicts in high-churn files. Re-implement
on current `main` so production MVP work is preserved.

**Steps:**

- [ ] Ensure working tree is clean on `main`; `git pull --ff-only`.
- [ ] Create `agent/shell-resilience-data-loss-guards` (or similar) from `main`.
- [ ] Do **not** merge `agent/top-10-greenfield-improvements`.
- [ ] Keep the old branch as reference (`git show 4e57203:path`) while porting.

**Acceptance:**

- New branch tip equals current `main` before any feature commits.
- Document this plan path in the PR description.

**Tests / validation:** N/A (process).

---

## Task A2 — Inventory salvage map (this document is the map)

**Reasoning:** Prevent agents from porting out-of-scope editor work or regressing production plan/docs.

**Port / re-implement (in scope):**

| Source path on side branch | Destination intent |
| --- | --- |
| `apps/web/src/components/shell/network-status.tsx` (+ test) | Port |
| `apps/web/src/lib/use-unsaved-changes-warning.tsx` (+ test) | Port |
| `apps/web/src/features/mail/mail-compose-recovery.ts` (+ test) | Port + reconcile with server drafts |
| Shell a11y edits in palette/launcher/profile/notifications/settings/dialog | Selective port onto `main` versions |
| Settings URL state in `app-shell.tsx` / overlay context | Port |
| Mobile CSS + `mobile-shell-layout.spec.ts` | Port/adapt |
| Login/signup/invite/verify a11y | Selective port |
| `__root` error/not-found a11y | Port |
| Search error retry polish | Selective port |
| theme-color / color-scheme appearance bits | Port |

**Do not port:**

| Source | Why |
| --- | --- |
| Side-branch `AGENTS.md` | Would remove MVP boundary |
| Side-branch production-readiness plan file | Stale vs `main` |
| `.github/workflows/e2e.yml` path rewrite | Incorrect for this workspace layout |
| Docs/Sheets/Slides/Meet/PDF feature edits | Out of MVP scope |
| Unrelated mail-shell churn beyond compose recovery/a11y | High conflict; re-apply surgically |

**Acceptance:** PR description links this table; review rejects out-of-scope files.

---

# Phase B — Shared primitives

## Task B1 — Harden `Dialog` (focus restore, scroll lock, labelling)

**Reasoning:** Unsaved-changes and discard confirmations depend on a correct modal. Branch improved
Helix dialog vs weaker main implementation.

**Likely files:**

- `apps/web/src/components/ui/helix-dialog.tsx`
- `apps/web/src/components/ui/helix-dialog.test.tsx` (create if missing on `main`)

**Required behavior:**

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at title id.
- Focus moves into dialog on open; Tab cycles within; Escape closes.
- Body scroll locked while open; previous focus restored on close.
- Backdrop click closes only when click target is backdrop.

**Tests:**

- [ ] Unit: labels, trap, restore focus, scroll lock (port branch test).
- [ ] Manual: open from keyboard, Tab wrap, Escape returns focus to invoker.

**Acceptance:**

- Dialog unit tests pass.
- No regression for existing Share/settings consumers.

---

## Task B2 — `useUnsavedChangesWarning`

**Reasoning:** Shared primitive for dirty forms. Prevents silent loss on in-app navigation and
tab close.

**Likely files:**

- `apps/web/src/lib/use-unsaved-changes-warning.tsx`
- `apps/web/src/lib/use-unsaved-changes-warning.test.tsx`

**Required behavior:**

- When `enabled`, router `useBlocker` active with `enableBeforeUnload` and `withResolver`.
- When blocked, render Helix `Dialog` with Stay / Leave actions (configurable labels/message).
- When disabled, no dialog and blocker disabled.

**MVP wiring targets:**

- Mail compose (required, Phase D).
- Do **not** wire Docs/Sheets/Slides in this workstream.

**Tests:**

- [ ] Enables blocking only while dirty.
- [ ] Stay calls `reset`; Leave calls `proceed`.
- [ ] Custom labels/message appear.

**Acceptance:** Hook is reusable; no feature-surface imports inside the hook.

---

## Task B3 — `NetworkStatus` banner

**Reasoning:** Users must know when network loss may prevent server draft saves / sync.

**Likely files:**

- `apps/web/src/components/shell/network-status.tsx`
- `apps/web/src/components/shell/network-status.test.tsx`
- `apps/web/src/components/shell/app-shell.tsx` (mount once)
- `apps/web/src/styles.css` (`.network-status*`, reduced-motion)

**Required behavior:**

- Subscribe to `online` / `offline` via `useSyncExternalStore`.
- Offline: persistent polite status: changes stay on device until reconnect.
- Reconnected: temporary status (~4s), then hide.
- SSR/hydration safe default online.
- Does not steal focus; `role="status"` + `aria-live="polite"`.

**Tests:**

- [ ] Offline then online transitions (port branch test).
- [ ] No permanent banner after reconnected timeout.

**Acceptance:** Banner visible in AppShell; unit tests pass; no layout shift that covers skip link.

---

# Phase C — Shell chrome accessibility and settings URL

## Task C1 — Settings section in URL search state

**Reasoning:** AGENTS.md requires durable UI state in the URL. Branch moved settings from React
state to `?settings=<section>`.

**Likely files:**

- `apps/web/src/components/shell/app-shell.tsx`
- `apps/web/src/components/shell/overlay-context.tsx`
- `apps/web/src/components/shell/settings-page.tsx`
- `apps/web/src/components/shell/app-shell.test.tsx`
- Route search types if the shell route validates search params

**Required behavior:**

- `openSettings(section)` writes `settings` into current path search without losing other params.
- Close removes `settings` (`replace: true` preferred).
- Deep link `/drive?settings=security` opens that section.
- Help / profile menu privacy routes land on real sections.
- Invalid section ids ignored (settings closed or default per product choice — pick one and test).

**Tests:**

- [ ] Deep-link open, section change preserves other search keys, close clears settings.
- [ ] Help routes to shortcuts section.

**Acceptance:** Refresh with `?settings=appearance` restores settings UI; back button closes or
restores previous section correctly.

---

## Task C2 — Command palette a11y

**Reasoning:** ⌘K is a primary power-user surface; must be a proper combobox/listbox.

**Likely files:**

- `apps/web/src/components/shell/command-palette.tsx`
- `apps/web/src/components/shell/command-palette.test.tsx`

**Required behavior:**

- Modal dialog semantics; labelled title.
- Input: `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`.
- Results: `listbox` / `option` / group labels; disabled options not runnable and skipped in
  keyboard movement.
- Focus restore to invoker; body scroll lock while open.
- Empty state announced politely.

**Tests:** Port/adapt branch combobox/listbox test cases onto `main` command registry.

**Acceptance:** Keyboard-only use complete without mouse; unit tests green.

---

## Task C3 — App launcher grid keyboard navigation

**Likely files:**

- `apps/web/src/components/shell/app-launcher.tsx`
- `apps/web/src/components/shell/app-launcher.test.tsx`

**Required behavior:**

- Menu semantics; arrow keys move among tiles (branch used 3-column mental model).
- Focus restore on close.
- Only MVP-visible apps appear when MVP flags are on (do not resurrect disabled apps).

**Tests:** Grid keyboard navigation + focus restore.

**Acceptance:** With `VITE_HELIX_MVP_ONLY=true`, launcher matches allowed apps.

---

## Task C4 — Profile menu keyboard model

**Likely files:**

- `apps/web/src/components/shell/profile-menu.tsx`
- `apps/web/src/components/shell/top-bar.tsx` (`aria-controls`, invoker ref)
- `apps/web/src/components/shell/profile-menu.test.tsx`

**Required behavior:**

- Menu roles; arrow/Home/End; Escape closes and restores focus to profile button.
- Privacy/help actions open real settings sections (via Task C1 API).

**Tests:** Port branch profile menu tests.

---

## Task C5 — Notifications panel tabs and timestamps

**Likely files:**

- `apps/web/src/components/shell/notifications-panel.tsx`
- `apps/web/src/components/shell/notifications-panel.test.tsx`

**Required behavior:**

- Filter UI as `tablist` / `tab` / `tabpanel` with `aria-selected` / `aria-controls`.
- Focus management on open.
- Relative timestamps locale-aware (no hardcoded English-only abbreviations if branch fixed that).
- Loading / error / empty states use appropriate roles (`status` / `alert`) and retry when error.

**Tests:** Port branch notifications tests.

---

## Task C6 — Settings page honesty and labelling

**Likely files:**

- `apps/web/src/components/shell/settings-page.tsx`
- `apps/web/src/components/shell/settings-page.test.tsx`
- `apps/web/src/components/settings-store.ts` (theme-color / color-scheme only)

**Required behavior:**

- Real controls labelled; groups for theme/density/text size/accent.
- Unavailable account/storage actions rendered disabled with accessible reason (no silent no-ops).
- Controlled section prop for deep links.
- Appearance apply updates `color-scheme` and `meta[name=theme-color]` when present.

**Tests:** Port settings-page tests; add settings-store coverage for theme-color if not present.

**index.html:** Add `theme-color` meta if missing; keep FOUC script consistent with store.

---

## Task C7 — AppShell focus + NetworkStatus mount

**Likely files:**

- `apps/web/src/components/shell/app-shell.tsx`
- `apps/web/src/components/shell/rail.tsx` / `surface-frame.tsx` only if needed for `#main-content`

**Required behavior:**

- Skip link to `#main-content`.
- On pathname change, focus `#main-content` with `preventScroll` (branch behavior).
- Mount `NetworkStatus` once at shell level.

**Tests:** Covered by app-shell tests + network-status tests.

---

# Phase D — Mail compose: local recovery + server draft coexistence

## Task D1 — Port `mail-compose-recovery` module

**Reasoning:** Crash/tab-kill protection when server draft save never ran.

**Likely files:**

- `apps/web/src/features/mail/mail-compose-recovery.ts`
- `apps/web/src/features/mail/mail-compose-recovery.test.ts`

**Required behavior (from branch):**

- Key `helix-mail-compose-recovery-v1`.
- Fields: to, cc, bcc, subject, body, updatedAt.
- Max age 30 days; malformed/expired cleared.
- Size caps on read (branch: to/cc/bcc 4k, subject 998, body 250k).
- `write` / `clear` never throw on quota / denied storage.
- Recipient token helpers + invalid address detection.

**Tests:** Round-trip, expiry, malformed, recipient parsing (port as-is).

---

## Task D2 — Wire recovery into compose **without** regressing server drafts

**Reasoning:** `main` already has `saveMailDraft` with version. Branch local recovery must layer on
top, not replace.

**Likely files:**

- `apps/web/src/features/mail/mail-shell.tsx` (compose only — surgical edit)
- `apps/web/src/features/mail/mail-shell.test.tsx`

**Required behavior:**

1. On compose open: `readMailComposeRecovery()`.
2. **Reconcile rules (normative):**
   - If no server draft loaded and local exists → hydrate from local; show recovery notice.
   - If server draft loaded and local exists:
     - If local `updatedAt` is **newer** than last successful local knowledge of server save **and**
       content differs → show conflict UI: “Keep server draft” vs “Restore local recovery” (do not
       silent overwrite).
     - If server is equal/newer → clear local recovery.
   - If only server → normal path; no notice.
3. While dirty, debounced `writeMailComposeRecovery` (text fields). Attachments: do **not** store
   file bytes in localStorage; optional note in recovery notice that attachments may need re-add.
4. On successful server draft save of matching content → clear local recovery **or** update
   watermark so reconcile stays stable (pick one; document in code comment).
5. On successful send → clear local recovery.
6. On explicit discard → clear local recovery + existing discard draft behavior.
7. `useUnsavedChangesWarning` when dirty; Leave may keep local recovery (“Leave and keep draft”).
8. Recipient validation before send; inline error + focus first invalid field.
9. Optional UX from branch if low-risk: minimize compose, discard confirm dialog.

**Tests:**

- [ ] Hydrate from local when no server draft.
- [ ] Debounced write on edit; clear on send/discard.
- [ ] Conflict path does not silent-overwrite server.
- [ ] Unsaved blocker appears when dirty.
- [ ] Invalid recipients block send and expose accessible error.
- [ ] Existing server draft version mismatch error still surfaces.

**Acceptance:**

- Kill tab mid-compose (before server blur save) → reopen compose → body restored or recovery notice.
- Online path still creates/updates server drafts as on `main` today.
- No attachment bytes in localStorage.

---

## Task D3 — Compose styles for recovery / errors / minimize

**Likely files:**

- `apps/web/src/styles.css`

**Required behavior:**

- Styles for `.compose-recovery`, `.compose-inline-error`, `.compose-minimized`, focus-visible on
  compose fields — adapted to current tokenized CSS on `main`.
- Respect `prefers-reduced-motion`.

**Tests:** Visual/manual + unit tests for classes present via component tests.

---

# Phase E — Auth, route, search, drive micro-a11y

## Task E1 — Login / signup / invite / verify-email a11y

**Likely files:**

- `apps/web/src/routes/login.tsx`, `-login.test.tsx`
- `apps/web/src/features/signup/signup-shell.tsx`, `invite-shell.tsx`, `verify-email-shell.tsx`
- Related tests

**Required behavior:**

- Errors: `role="alert"`, stable id, `aria-invalid` / `aria-describedby` on fields.
- Focus moves to error summary/paragraph when error appears.
- Submit button `aria-busy` while submitting.

**Tests:** Port/adapt login and signup tests for invalid/busy states.

---

## Task E2 — Root route error and not-found states

**Likely files:**

- `apps/web/src/routes/__root.tsx`
- `apps/web/src/routes/-__root.test.tsx`

**Required behavior:**

- Focusable `<main>` with labelled heading.
- Safe error detail extraction (no token leakage).
- Devtools remain lazy in DEV only.

**Tests:** Render error/not-found; assert roles/labels/focus helper.

---

## Task E3 — Search results error/retry polish

**Likely files:**

- `apps/web/src/features/search/search-results-shell.tsx` (+ test)
- `apps/web/src/features/search/queries.ts` only if required for retry

**Required behavior:**

- Error state `role="alert"` with Retry that revalidates query.
- Do not change search ranking/backend contracts.

**Tests:** Error state + retry calls refetch.

---

## Task E4 — Drive micro-improvements (optional, low risk)

**Likely files:**

- `apps/web/src/features/drive/drive-shell.tsx`
- `apps/web/src/features/drive/file-thumbnail.tsx` (+ tests)

**Allowed:**

- Stable class names for contained cards/rows if useful for CSS.
- Preview `img` width/height/lazy/decoding attributes.

**Not allowed:** New editor entry points or enablement of non-MVP apps.

---

# Phase F — Mobile shell layout

## Task F1 — Mobile CSS (≤760px and ≤520px)

**Reasoning:** Branch converted rail to bottom bar with safe-area insets; compose/dialog/search
adjusted to avoid overflow under the rail.

**Likely files:**

- `apps/web/src/styles.css`
- Possibly `rail.tsx` / `top-bar.tsx` if markup hooks required

**Required behavior:**

- Viewport 390×844: rail is horizontal bottom bar; workspace sits above rail.
- Touch targets ≥44×44 CSS px for rail items.
- No horizontal page overflow.
- Launcher opens above the rail and stays within viewport.
- Compose and dialogs respect `safe-area-inset-*` and `100dvh`.
- Coexist with `main` design tokens / existing mobile rules (merge, don’t blind-overwrite).

**Tests:** Task F2 e2e + manual device/emulation check.

---

## Task F2 — Playwright mobile shell e2e

**Likely files:**

- `apps/web/tests/e2e/mobile-shell-layout.spec.ts`
- Fixtures under `apps/web/tests/e2e/support/` as needed

**Required behavior:**

- Seed session + mock API (pattern from branch).
- Assert rail flex-direction row, geometry, 44px targets, no overflow, launcher bounds.
- Use MVP-visible app (e.g. Drive) that remains enabled on `main`.

**Do not** change e2e artifact upload paths unless CI is actually broken on `main`.

**Acceptance:** Spec passes in mocked Playwright job.

---

# Phase G — Validation and close-out

## Task G1 — Focused test matrix

Run while iterating (narrow → wide):

```sh
# Unit (examples; adjust paths to match final files)
pnpm --filter @helix/web exec vitest run \
  src/components/ui/helix-dialog.test.tsx \
  src/lib/use-unsaved-changes-warning.test.tsx \
  src/components/shell/network-status.test.tsx \
  src/components/shell/app-shell.test.tsx \
  src/components/shell/command-palette.test.tsx \
  src/components/shell/app-launcher.test.tsx \
  src/components/shell/profile-menu.test.tsx \
  src/components/shell/notifications-panel.test.tsx \
  src/components/shell/settings-page.test.tsx \
  src/features/mail/mail-compose-recovery.test.ts \
  src/features/mail/mail-shell.test.tsx \
  src/routes/-__root.test.tsx \
  src/routes/-login.test.tsx

# Mobile e2e (mocked)
pnpm --filter @helix/web exec playwright test tests/e2e/mobile-shell-layout.spec.ts
```

## Task G2 — Full repository gates

From repo root (per `AGENTS.md`):

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm quality:editors-boundaries:test
pnpm quality:editors-boundaries
```

Web UI: run relevant Playwright suite used in CI for mocked e2e.

## Task G3 — Manual validation checklist

- [ ] Desktop: ⌘K open/close, filter, run command, focus returns.
- [ ] Desktop: open settings via profile; refresh keeps section; close clears query param.
- [ ] Desktop: go offline in DevTools → banner; type mail compose → recovery written; kill tab;
      reopen → recovery or server draft correct per rules.
- [ ] Desktop: dirty compose → navigate away → Stay/Leave dialog.
- [ ] Desktop: invalid recipient → accessible error, no send.
- [ ] Mobile 390×844: bottom rail, no horizontal scroll, launcher in bounds, compose usable.
- [ ] MVP-only build: no Docs/Sheets/Slides controls introduced.
- [ ] Screen reader spot-check: offline banner, recovery notice, palette options.

## Task G4 — PR and branch close-out

**PR description must include:**

- Link to this plan.
- Explicit “re-implemented from `agent/top-10-greenfield-improvements@4e57203`, not merged.”
- Task IDs completed.
- Test commands + results summary.
- Note on server-draft vs local recovery reconcile choice.

**After merge:**

- [ ] Optionally archive/delete remote `agent/top-10-greenfield-improvements` once salvage is done
      (owner decision).
- [ ] Do not leave partial ports claiming full M6 completion in the production-readiness plan;
      only check M6 boxes when server-side reliability items are truly done.

---

# 8. Granular task index

| ID | Task | Depends on | Primary evidence |
| --- | --- | --- | --- |
| A1 | Branch from current `main` | — | clean branch tip = main |
| A2 | Salvage map enforced in PR | A1 | file list review |
| B1 | Dialog a11y harden | A1 | unit test |
| B2 | Unsaved-changes hook | B1 | unit test |
| B3 | NetworkStatus | A1 | unit + shell mount |
| C1 | Settings URL state | A1 | unit + manual refresh |
| C2 | Command palette a11y | B1 | unit |
| C3 | App launcher keyboard | A1 | unit |
| C4 | Profile menu keyboard | C1 | unit |
| C5 | Notifications a11y | A1 | unit |
| C6 | Settings honesty + theme-color | C1 | unit |
| C7 | AppShell focus + mount network | B3, C1 | unit |
| D1 | Local recovery module | A1 | unit |
| D2 | Compose wiring + reconcile | B2, D1 | unit + manual crash |
| D3 | Compose CSS | D2 | visual |
| E1 | Auth form a11y | A1 | unit |
| E2 | Root error/not-found | A1 | unit |
| E3 | Search error retry | A1 | unit |
| E4 | Drive micro a11y (optional) | A1 | unit |
| F1 | Mobile CSS | C7 | e2e + manual |
| F2 | Mobile Playwright | F1 | e2e CI |
| G1 | Focused tests | all feature tasks | vitest/playwright |
| G2 | Full gates | G1 | format/type/lint/test/build |
| G3 | Manual checklist | G1 | human sign-off |
| G4 | PR close-out | G2–G3 | merged PR |

Suggested PR slicing:

1. **PR1:** B1–B3 + C7 mount network only  
2. **PR2:** C1–C6 shell chrome  
3. **PR3:** D1–D3 mail recovery  
4. **PR4:** E1–E3 (+ optional E4)  
5. **PR5:** F1–F2 mobile  

Or combine PR1+PR2 if small enough; keep mail recovery separate because of compose conflict risk.

---

# 9. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Merge conflicts in `mail-shell.tsx` / `styles.css` | Surgical re-apply; never whole-file copy from side branch |
| Local recovery overwrites newer server draft | Normative reconcile rules in D2; tests for conflict |
| localStorage PII (draft body) | Document as device-local; cap size; clear on send; no logs |
| Attachment loss after crash | Explicit UX copy; do not pretend attachments recovered |
| MVP boundary regression via launcher/docs edits | C3 asserts MVP apps; skip editor ports |
| CSS fights design tokens on `main` | Port selectors/behaviors, restyle with current variables |
| e2e.yml wrong paths | Leave `main` workflow paths alone |
| Scope creep into production-readiness M6 server work | Keep server draft API as-is; file follow-ups for full M6 |

---

# 10. Stop conditions

Stop and return to owner review if:

1. Reconcile rules would require new server draft APIs or migrations.
2. Mobile layout requires redesign of navigation IA (not just CSS/rail orientation).
3. Any task needs enabling Docs/Sheets/Slides/Meet to “finish.”
4. Conflict with production-readiness work on the same files cannot be resolved without regressing
   security/ops behavior on `main`.
5. Local recovery would need to store secrets or full attachment bytes.

---

# 11. Reference commits and paths

| Ref | Role |
| --- | --- |
| `origin/agent/top-10-greenfield-improvements` | Historical WIP branch (do not merge) |
| `4e57203` | Shell / recovery / unsaved WIP save point |
| `a3c8a9b` | Original production-readiness doc commit (superseded on `main`) |
| `docs/superpowers/plans/2026-07-28-core-workspace-production-readiness.md` | Sibling plan for security/ops (on `main`) |
| `AGENTS.md` on `main` | MVP boundary and verification commands |

### High-value source files to read when implementing

```text
# From side branch (git show 4e57203:…)
apps/web/src/components/shell/network-status.tsx
apps/web/src/lib/use-unsaved-changes-warning.tsx
apps/web/src/features/mail/mail-compose-recovery.ts
apps/web/src/components/shell/app-shell.tsx
apps/web/src/components/shell/command-palette.tsx
apps/web/src/components/ui/helix-dialog.tsx
apps/web/tests/e2e/mobile-shell-layout.spec.ts

# From main (always edit these live versions)
apps/web/src/features/mail/mail-shell.tsx   # server drafts already here
apps/web/src/styles.css
apps/web/src/components/shell/*
AGENTS.md
```

---

# 12. Task completion template (for PRs)

```md
## Plan task

- Plan: docs/superpowers/plans/2026-08-01-shell-resilience-and-data-loss-guards.md
- Task IDs:
- User-visible outcome:
- MVP boundary preserved: yes/no

## Source changes

- Files:
- Re-implemented from 4e57203 (not merged): yes

## Tests

- Commands:
- Results:

## Manual checks

- [ ] Offline banner
- [ ] Compose recovery / server draft reconcile
- [ ] Unsaved navigation
- [ ] Mobile 390×844
- [ ] Settings deep link

## Follow-ups

- Deferred to production-readiness plan (if any):
```

---

# 13. One-paragraph reconstruction (executive)

The branch tried to (1) capture a production-readiness planning document and (2) save unfinished
browser-shell work that prevents data loss and improves accessibility/mobile usability. `main`
already absorbed the production MVP/security program and server mail drafts, leaving the side
branch stale and conflicted. The remaining useful mission is to **re-implement shell resilience and
a11y on current `main`**: offline status, local compose crash recovery layered under server drafts,
unsaved-navigation warnings, URL-backed settings, keyboard-accessible shell chrome, auth/route
error polish, and a proven mobile bottom-rail layout — without merging the old branch or expanding
beyond the Mail/Drive/Chat/Assistant/Admin MVP.
