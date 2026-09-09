# Helix Admin Console — Overhaul Specification

**Date:** 2026-08-03
**Scope:** `apps/web/src/features/admin/**`, `apps/web/src/routes/_shell/admin/**`,
`apps/web/src/features/webhooks/**`, plus the backend seams they depend on
(`apps/helix/src/platform/events`, `platform/mail/admin-routes.ts`,
`platform/admin/tenant-config.ts`).

**Method:** every claim below was read out of the source and then independently
re-verified against the file it cites. Where the re-check corrected the original
reading, the corrected version is what appears here. Line numbers are as of the
working tree at the date above.

---

## 0. Executive summary

The admin console is 23 registered sections (22 reachable — `billing` is
build-gated) across ~35,600 lines. The code is unusually careful in places: the
`toSignal` funnel in `sections/overview.tsx` refuses to render a figure that no
response backs, `useQueryFailure` holds an error across its own retry so the
banner cannot flicker away mid-recovery, and every destructive action routes
through one Radix `AlertDialog`. None of the problems below are sloppiness.
They are structural, and they fall into six groups.

| #   | Problem                                                                                          | Severity   | Root cause                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Every section navigation is two serialized round trips ending in a blank frame                   | **High**   | 23 sections share one route; `lazy()` lives _inside_ the route component, so the router's `defaultPreload: "intent"` has nothing to preload, and no route `loader` exists |
| 2   | Zero liveness — no SSE, no WebSocket, no polling anywhere in `features/admin`                    | **High**   | The `/events/ws` bus exists and admin never became a consumer                                                                                                             |
| 3   | Sections routinely exceed the tenant's hard 5 rps ceiling, with `retry: false`                   | **High**   | Per-panel endpoints, no aggregates, and the only 429 mitigation is private to one file                                                                                    |
| 4   | Four vocabularies for the same UI; every table/toolbar/panel/form-row reinvented                 | **Medium** | `console/primitives.tsx` stops at headings, scroll, banners and empty states                                                                                              |
| 5   | Four admin features are permanently broken — the client calls routes the server never registered | **High**   | No contract test covers them                                                                                                                                              |
| 6   | Lists don't scale: no virtualization, no sorting, client-side search over one page               | **Medium** | `react-table` and `react-virtual` are dependencies the console never adopted                                                                                              |

Plus one security finding surfaced while designing the realtime work
([§3.5](#35-security-eventsws-has-no-tenant-filter)) that must be fixed _before_
admin becomes the bus's second consumer.

Two premises from the initial read were **wrong** and are corrected here:

- "There is not one `<table>` in the admin console" — false. There are **11**
  real tables (8 via the shadcn `Table` primitive, 3 raw in webhooks) sitting
  alongside **10** CSS-grid pseudo-tables. The console is _split_ between two
  table strategies, which is a different and slightly better problem.
- "`HEADER_CELL` is a byte-for-byte duplicate of `.section-label`" — only one of
  the five copies of that caption token is an exact match. There are five
  near-copies, not five identical ones.

---

## 1. Navigation and perceived speed

### 1.1 Hover preload is a no-op

`main.tsx:43` sets `defaultPreload: "intent"`. `sidebar.tsx:93-99` renders a
bare `<Link to="/admin/$section" params={{ section: item.id }}>`. Both are
correct in isolation and together do nothing.

TanStack's preload path (`router-core/router.js:742-767` → `load-matches.js:607-612`)
calls `route.options[type]?.preload?.()` — the _route_ component's lazy handle.
Every admin section resolves to the same route component
(`$section.tsx:38 component: AdminSectionRoute`), which is already loaded because
you are standing on it. The per-section code is `React.lazy()` inside a plain
component (`admin-console.tsx:36`), and nothing exports a `.preload()` for those
23 dynamic imports.

Confirmed in the build output: `dist/assets/_section-*.js` opens with a
`__vite__mapDeps` list that is only fetched when the dynamic import fires.

**Cost paid after the click, per first visit:** billing 85,355 B ·
webhook-management 38,765 B · security-tier-readiness 27,901 B ·
tenant-config-management 25,812 B · overview 25,804 B · mail-admin 22,288 B ·
identity-management 19,554 B · domains 17,474 B — each plus its `__vitePreload`
dependency chunks.

### 1.2 No route loader; nine prefetch helpers are dead code

`$section.tsx:23-39` declares only `params`, `validateSearch`, `component`. No
`loader`, no `loaderDeps`, no `pendingComponent`. The only loader in the whole
app is `routes/_shell/drive/index.tsx:20`.

Meanwhile these are written, exported, and never called from anywhere:

| Helper                              | File                               |
| ----------------------------------- | ---------------------------------- |
| `prefetchAdminCoreAppsQuery`        | `core-apps-management.tsx:28`      |
| `prefetchAdminServicesQuery`        | `admin-services.tsx:111`           |
| `prefetchAdminAuditLogQuery`        | `audit-log.tsx:88`                 |
| `prefetchAdminAIObservabilityQuery` | `ai-observability.tsx:106`         |
| `prefetchAdminTenantConfigQuery`    | `tenant-config-management.tsx:36`  |
| `prefetchAdminAICostLimitsQuery`    | `ai-cost-limits-management.tsx:31` |
| `prefetchAdminReadinessQueries`     | `tier-readiness/api.ts:52`         |
| `prefetchAdminUsersQuery`           | `admin-users.tsx:68`               |

`app-passwords-management.tsx:86-87` documents behaviour that does not happen:
"sharing the cache (and the route prefetch) with the Users section".

Consequence: chunk time and data time are strictly serialized. The section's
first request cannot start until its chunk has downloaded, parsed and mounted.

### 1.3 Blank frame on every cold navigation

`admin-console.tsx:142` — `<Suspense fallback={null}>`. The comment says "the
chunk resolves in a tick on a local network," which is true locally and false
over any real link. There is no `pendingComponent` on the admin route, so
`main.tsx:44 defaultPendingMinMs: 200` is **inert** — a pending component is
only shown if one exists, and only after `defaultPendingMs` (1000 ms).

The operator sees: click → content pane goes white → then the section's own
loading banner → then content. Two visible transitions, the first of which reads
as a broken page.

### 1.4 Related-nav chips are raw anchors — every click is a full page reload

`admin-related-nav.tsx` renders `<a className="chip" href={adminHref(...)}>`,
with the stated reason "so section unit tests need no RouterProvider". Used by
seven call sites across six sections.

Clicking one discards the SPA entirely: full document request, entry-bundle
re-parse, `_shell.tsx:11 getSessionUser()` auth round trip, and every warm React
Query entry in the workspace thrown away. This is the slowest navigation in the
console, and it is the one offered as a convenience shortcut.

### 1.5 Smaller navigation defects

- **No nav filter.** 22 rows, 6 group headings, and the sidebar's own comment
  concedes "882px of content in an 843px nav at compact density, ~190px over at
  comfortable density". The mitigations (overflow fade, `scrollIntoView`,
  collapsible groups) all compensate for a missing search box.
- **The topbar always reads "Admin"** (`admin-console.tsx:136`). The section name
  lives only in the section's own `<h1>`, which is _inside_ the Suspense
  boundary — i.e. absent during exactly the window when the operator needs to
  know something is happening.
- **Every filter keystroke pushes a history entry.** `admin-section-search.ts:139-152`
  hardcodes `replace: false`, and `patchSearch`/`useAdminSectionTab` funnel
  through it. Typing in the Users filter means Back walks you through your own
  typing.
- **Related-nav coverage is arbitrary** — 6 of 23 sections have sibling links.
  Of the Security group, only Tier readiness carries the strip, even though
  `AdminSecurityRelatedNav` lists all four members.

---

## 2. Request budget and caching

### 2.1 The ceiling

`packages/contracts/src/tenant-config.ts:135` — `api_rps_limit: 5`.
`apps/helix/src/platform/limits/api-rps.ts:5,70` — a hard 1000 ms sliding window,
refusing when `state.length + 1 > limit`. Only `/api/auth*` is exempt
(`server.ts:546-549`).

**The shell spends two of those five before a section renders anything:**
`surface-frame.tsx:51` (`notifications.unread-count`, itself on a 30 s interval)
and `use-enabled-apps.ts:28` (`GET /api/core-apps`).

### 2.2 Overview's pacing is off by one

`overview.tsx:86-92` justifies `CHECK_RELEASE_INTERVAL_MS = 250` with "the spare
slot is what the shell … is fetching alongside it" — singular. The shell fires
two. The real timeline on a cold console:

```
t=0    shell×2 + check0   → 3 used
t=250  check1             → 4
t=500  check2             → 5
t=750  check3             → 6th in window → 429
```

The Directory card is refused on every cold load and sits in "Checking…" for at
least one `rateLimitBackoff` (≈1.1 s) before resolving.

### 2.3 The mitigation is private to one file

`overview.tsx:85-168` defines `isRateLimited`, `rateLimitBackoff`, `checkOptions`
and `useReleaseSchedule` — **none exported**. Every other admin query factory
hardcodes `retry: false` with no 429 exception (24 modules; `billing-api.ts:163,175,187`,
`mail-admin-api.ts:239-275`, `groups-api.ts:140,149,162`, and so on).

Sections firing ≥3 concurrent queries — Billing 3, Webhooks 3, Drive 2, Tier
readiness 2, Audit 2, Groups 2, App passwords 2, Agent credentials 2 — plus the
shell's 2 sit **at or over** the ceiling with zero retry. A 429 there is
permanent until the operator clicks Retry: exactly the bug Overview documents,
still live everywhere else.

### 2.4 `throwOnError: true` is inverted for admin

`main.tsx:24` sets it globally. All 24 admin query factories then opt out
one-by-one — 31 duplicated `throwOnError: false` lines. The console's entire
error UX (`useQueryFailure` + `QueryFailureBanner` + `describeFailure`) depends
on the opt-out: none of it can run if the query threw to an error boundary.

So the default is a trap, not a safety net. A new admin `queryOptions` that
forgets the line silently changes from "inline banner with Retry" to "whole
admin surface replaced by an error boundary", and nothing catches it.

### 2.5 Over-invalidation

Child keys are nested _under_ their list keys, and `invalidateQueries` matches by
prefix:

| Key                   | Child it also kills               | Fired by                                                                       |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| `["admin","domains"]` | `["admin","domains",id,"dns"]`    | all 9 mutations in `domain-capabilities.tsx`                                   |
| `["admin","groups"]`  | `["admin","groups",id,"members"]` | `sections/groups.tsx:320`                                                      |
| `["admin","users"]`   | all 5 directory key variants      | `app-passwords-management.tsx:687-691`, `agent-credentials-management.tsx:303` |

Toggling one domain's receiving capability refetches DNS records for every
expanded domain. Each refetch is another metered request against the 5 rps
ceiling with `retry: false` — so an over-invalidation on a page with several rows
open is itself a 429 generator.

### 2.6 Cache-key drift, missing invalidation, no `gcTime`

- **Directory key drift.** `sections/users.tsx` uses `{ includeDisabled: true, limit: 250 }`;
  `app-passwords-management.tsx:88` and `agent-credentials-management.tsx:92` use
  `{ includeDisabled: false, limit: 50 }`. Different keys → the cache is not
  shared, contrary to the comment. Overview and Audit _do_ share.
- **No admin mutation ever invalidates the audit log.** Suspend an IdP, open
  Audit within 30 s, and the log does not contain the action you just took — on
  the one surface whose purpose is completeness.
- **`gcTime` is set nowhere in the app.** Everything falls to the 5-minute
  default, so a section revisited after 5 minutes is fully cold and re-fires its
  whole burst. `staleTime` ranges 5 s → 60 s with no stated rationale.

### 2.7 Aggregation opportunities

Cold-load fan-out, with the backend file already serving each leg:

| Section        | Requests                              | Aggregate                                                                            |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| Overview       | 5 across 5 route files                | new `GET /api/admin/overview` — deletes `useReleaseSchedule` entirely                |
| Billing        | 3, all in `platform/admin/billing.ts` | `GET /api/admin/billing` → `{account, invoices, usage}`                              |
| Groups         | 2, both in `platform/admin/groups.ts` | `GET /api/admin/directory` → `{orgUnits, groups}`                                    |
| Tier readiness | 2                                     | **`GET /api/admin/platform-config/readiness` already exists and no client calls it** |
| Webhooks       | 3 tool calls                          | `webhook.overview` tool                                                              |

---

## 3. Realtime

### 3.1 What exists on the server

- **`GET /events/ws?subject=<filter>`** (`platform/events/routes.ts`). Cookie
  auth. NATS-style `*`/`>` wildcards. **One subject per socket** — an array
  query param is silently collapsed to `subjects[0]` (`routes.ts:44-52`). Bare
  `*`/`>` and any `chat.*` root are rejected with close code 1008
  (`routes.ts:138-141`). Bus-absent is close code 1013. No client→server frames,
  no heartbeat.
- **`GET /sse/mail`** (`platform/mail/stream.ts`). Two hardcoded subjects,
  org-filtered, frames shaped `{type, threadId, orgId}`.

### 3.2 What is actually published

Only five families are admin-relevant:

| Subject                           | Emitted at                                | Admin surface                          |
| --------------------------------- | ----------------------------------------- | -------------------------------------- |
| `helix.config.changed`            | `platform/config/admin.ts:499`            | tier-readiness, ai-providers, overview |
| `flags.changed.<orgId>`           | `platform/admin/tenant-config.ts:314,529` | workspace-settings, workspace-apps     |
| `platform.ai_cost.warning`        | `server.ts:1609`                          | ai-costs, ai-observability             |
| `quota.storage.exceeded`          | `platform/drive/store.ts:2752`            | drive                                  |
| `platform.pending_action.created` | `server.ts:2215,2234,2269`                | agent-controls (partial)               |

**Thirteen sections have no subject at all** — services, agent-controls, audit,
users, groups, domains, identity, policies, oauth-apps, app-passwords,
agent-credentials, webhooks, chat retention, and mail's config tabs. For those,
realtime is not merely unwired but _unpublishable_ without new emitters. An
honest design polls them and says so; it does not mount a hook everywhere and
show a "live" indicator over a frozen services-health page.

### 3.3 What exists on the client

`features/admin` contains zero `EventSource`, zero `WebSocket`, zero
`refetchInterval`. The only realtime in the whole web app is
`use-mail-realtime.ts` — 36 lines, mail-only, invalidating the entire `["mail"]`
tree on any frame.

### 3.4 Design constraints for `useAdminRealtime`

- **One socket per distinct subject, ref-counted.** Ten sections each opening
  their own socket would multiply the `helix_websocket_connections_active{route="/events/ws"}`
  gauge (`platform/websocket-metrics.ts:25-28`) by ten per tab and make it
  useless for capacity planning.
- **Targeted invalidation only.** The mail-style `invalidateQueries({queryKey:["mail"]})`
  pattern, applied here, would refetch ~20 admin queries on every quota event.
  Every target key already exists and is stable.
- **Backoff:** 1 s → 30 s cap with ±20 % jitter; reset on a _received frame_, not
  on `open`, so a flapping proxy does not reset the ladder. Stop permanently on
  1008 (retrying an auth rejection is a login loop).
- **Auth:** cookie only. The precedent is explicit at `features/chat/api.ts:379-386`
  — reusable access tokens must not be copied into `Sec-WebSocket-Protocol`.
- **Never subscribe to bare `>` or `*`** — the server rejects them.
- **Expose `connectionState: 'live' | 'polling' | 'offline'`** and show it, so a
  dead socket can never be mistaken for a quiet system.

### 3.5 SECURITY: `/events/ws` has no tenant filter

`handleEventSocket` (`platform/events/routes.ts:63-121`) authenticates the actor
and then subscribes to the requested subject on the shared bus, forwarding
**every** matching envelope with no comparison against `actor.orgId`.

Subjects that embed the org id (`flags.changed.<orgId>`, chat rooms, sheet sync)
are safe by naming convention. The globally-named ones are not:
`platform.ai_cost.warning`, `quota.api_rps.exceeded`, `quota.storage.exceeded`,
`platform.pending_action.created` and `helix.config.changed` all carry an
`orgId` **in the payload** and are broadcast to any authenticated actor who asks
for them.

In `multi-tenant-saas` mode this is a cross-tenant information leak: tenant A can
observe tenant B's cost warnings, quota breaches and pending approvals. It is
latent today only because no client subscribes. **Wiring admin onto this bus
without fixing it would activate the leak**, so the filter is a prerequisite of
§3, not a follow-up.

---

## 4. Layout and styling consistency

### 4.1 Four vocabularies

27 non-test page-level files speak four mutually incompatible dialects, split
roughly along the `sections/` vs top-level directory boundary rather than any
design intent:

| Vocabulary                                                              | Files                               | Volume                                                                                                        |
| ----------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Inline `style={{}}` objects                                             | 8                                   | 137 occurrences (billing 44, users 31, policies 20, groups 16, domains 12, oauth-apps 9, overview 4, drive 2) |
| Unlayered `.admin-*` CSS                                                | —                                   | ~905 lines / 152 selectors in `styles.css`                                                                    |
| Tailwind arbitrary values on `var(--*)`                                 | most top-level files                | —                                                                                                             |
| shadcn semantic utilities (`text-muted-foreground`, `border-border/70`) | tenant-config, audit-log, core-apps | —                                                                                                             |

### 4.2 Missing primitives, and what each would replace

`console/primitives.tsx` provides `PageHeading`, `PageScroll`, `StateBanner`,
`EmptyRow`, `EmptyState`, `QueryFailureBanner`, `SubviewHeading`,
`useQueryFailure`. It does **not** provide a table, toolbar, panel, form row, tab
strip or stat tile — so each is reinvented per file:

- **Tables:** 10 CSS-grid pseudo-tables vs 11 real `<table>` elements. Five
  distinct row heights across five sections; only two honour the density token.
  Four different last-row border strategies, leaving a doubled hairline inside
  some panels and not others.
- **Panels:** six distinct border radii and three distinct border opacities for
  the same visual object.
- **Form rows:** the `Field` component is copy-pasted **byte-identically** into
  `drive-admin.tsx:35-50`, `chat-admin.tsx:38-53` and `mail-admin.tsx:130-145`.
- **Toolbars:** `.admin-filter-bar` and `.admin-bulk-bar` are documented in
  `styles.css:3166-3184` as shared and have **zero call sites** — every section
  hand-rolls its filter bar.
- **Stat tiles:** implemented five ways with four different auto-fit breakpoints.
- **Tab strips:** three implementations with three different bottom margins; one
  is a separate CSS class with no focus ring.
- **Buttons:** three systems — `<Button>` from `components/ui`, raw
  `<button className="helix-button">` (14 sites in tier-readiness and webhooks),
  and bare `<button>`.

### 4.3 Design tokens shipped as inline styles

`primitives.tsx:14-22` exports `INPUT_STYLE` and `:104-110` exports `HEADER_CELL`
as `React.CSSProperties` objects. An inline style cannot be themed, cannot carry
a `:focus-visible` ring, cannot respond to a media query or the density token,
and can only be overridden with `!important`. `.section-label` in `styles.css` is
a near-copy of `HEADER_CELL`; five near-copies of that one caption token exist.

### 4.4 Specificity trap

All `.admin-*` rules are **unlayered**, while Tailwind v4 (`styles.css:6`) puts
its utilities in `@layer utilities`. Unlayered rules beat every layered utility
regardless of specificity. Two live call sites already have silently dead
Tailwind classes because of this. The file has exactly two `@layer` blocks
(`:582`, `:3070`) — the second exists precisely because someone hit this and
fixed it locally.

### 4.5 Dead and duplicated CSS

`.admin-tier-header` and `.admin-user-detail` are fully dead. `.webhooks-header`
is a near-verbatim clone of `.admin-page-header`. `.admin-filter-bar` and
`.admin-bulk-bar` have no call sites. 22 raw palette colours bypass the theme.

### 4.6 No vertical rhythm

`PageScroll` renders `.admin-page > .admin-page-inner` with padding and a
max-width but **no `display`, no `gap`**. So each of nine distinct page-body
wrappers invents its own child spacing — `grid gap-4`, `grid gap-5`,
`admin-tier-page grid gap-4`, a bare fragment, or nothing at all.

---

## 5. Broken features (client calls routes the server never registered)

These are not styling issues. They are features that fail 100 % of the time.

| Client call                                                                                     | Reality on the server                                                                      | Operator sees                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/admin/mail/dmarc` (`mail-admin-api.ts:386`)                                           | only `/dmarc/reports` and `/dmarc/summary` exist (`platform/mail/admin-routes.ts:612,626`) | Mail › Deliverability shows "may not be enabled for this workspace" forever; `retry: false` means Retry re-issues the same 404 |
| `POST /api/admin/mail/providers/:id/set-default` (`mail-admin-api.ts:321`)                      | only `PATCH /:id` and `DELETE /:id`                                                        | "Set as default" 404s                                                                                                          |
| `POST /api/admin/mail/sending-domains/:id/dkim/rotate` (`mail-admin-api.ts:376`)                | only `POST /:id/dkim/:keyId/retire`                                                        | DKIM rotation 404s                                                                                                             |
| `POST /api/admin/tenant-config/byo-storage/migrations/:id/cutover` (`tenant-config-api.ts:178`) | only `POST /migrations` and `GET /migrations/:id`                                          | operator confirms a storage-migration cutover behind a destructive dialog and gets an error                                    |

`mail-admin-api.contract.test.ts` exists and covers none of these four.

---

## 6. List scale

| Surface                                                       | Paging                                     | Search                                                                        | Virtualized | Failure mode                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| Users                                                         | 250-row page, cursor discarded             | **client-side over the page** — while the server already implements it in SQL | no          | in a 10k-actor workspace, searching for anyone outside the 250 newest returns "No users match" |
| App passwords / Agent credentials actor picker                | hard cap 50, no search, no paging          | none                                                                          | no          | the 51st user in the workspace is literally unselectable                                       |
| OAuth apps                                                    | server-side filter, `nextCursor` discarded | server                                                                        | no          | page 2 unreachable                                                                             |
| Billing invoices                                              | cap 25, cursor discarded, no disclosure    | none                                                                          | no          | silent truncation                                                                              |
| Audit log                                                     | forward-only, no position indicator        | server                                                                        | no          | going back one page means restarting from newest                                               |
| Groups, group members, domains, routing rules, AI cost limits | **no LIMIT clause on the server at all**   | none                                                                          | no          | unbounded response                                                                             |

`sections/users.tsx:254-276` filters in the browser. The transport already sends
`query` and `type` (`admin-users.tsx:76-77`), and the server implements them
(`platform/auth/admin-users.ts:325-330`, indexed `LIKE` over email / display_name
/ id). The capability is built and unused.

**No column anywhere in the console is sortable.** **No admin list is
virtualized**, despite `@tanstack/react-virtual` being a dependency used
correctly in webhooks, search, chat and assistant. **No list supports keyboard
navigation** — rows are not focusable and arrow keys do nothing.

`sections/users.tsx` "Select all" selects only the loaded page while the counter
reports a number spanning rows the operator cannot see.

---

## 7. Accessibility

Genuinely above average: exactly one `<h1>` per section from the shared
`PageHeading`, form controls almost universally wrapped in a real `<label>`,
every status chip carries a text equivalent beside its colour, one destructive
dialog for the whole console.

Three structural defects dominate:

1. **The entire console is invisible to the a11y gate.** Every admin route in
   `quality-gates.routes.json` redirects to `/login`, because
   `scripts/accessibility-audit.mjs` never authenticates. The gate has been
   scanning the login page 19 times. (It also covers only 19 of 23 sections, and
   axe runs light-theme only — `shouldRunAxe = theme === "light"` at `:465` —
   while the hand-rolled contrast parser bails on `oklch()`, so dark theme is
   checked by nothing.)
2. **Tier readiness "Plugins" tab is unreachable by keyboard** — roving
   `tabindex` with no arrow-key handler.
3. **The sidebar emits six `<h2>` group headings before the page `<h1>`**, so
   every admin page's document outline starts at level 2.

Also: webhooks declares `role="tab"`/`role="tablist"` twice with no tabpanels, no
`aria-controls`, no ids and no keyboard handling; `aria-controls` references
elements absent from the DOM while collapsed; the `AlertDialog` blast-radius text
is `role="note"` so the console's most important consequence statement is not in
the dialog's announcement; several controls carry both a wrapping `<label>` and a
conflicting `aria-label`, discarding the visible text from the accessible name;
`StateBanner` live regions are inserted into the DOM together with their content,
which makes polite announcements unreliable.

---

## 8. Remediation plan

Ordered by (operator-visible value ÷ risk). Each phase is independently
shippable.

### Phase 1 — Perceived speed

1. Restructure `section()` in `admin-console.tsx` to stop discarding the loader.
   Return `{ Component, preloadChunk, prefetchData }`; keep the map keyed by
   `AdminSectionId` so the exhaustiveness type-error property survives. Export
   `preloadAdminSection(id)` and `prefetchAdminSectionData(queryClient, id)`.
2. `sidebar.tsx`: `onPointerEnter` / `onFocus` → `preloadAdminSection`.
   (Precedent already in-repo: `features/signup/password-strength.ts:31-33`.)
3. `$section.tsx`: add a non-blocking `loader` that starts chunk + data together.
   Because loaders also run under `preloadRoute`, this makes hover warm the data
   as well.
4. Replace `fallback={null}` with a page-shaped skeleton, keyed on `section`.
5. Put the section label in the topbar — it lives _outside_ Suspense, so it
   repaints on the click itself. Cheapest possible perceived-speed win.
6. `admin-related-nav.tsx`: `<a>` → `<Link>`.
7. `admin-section-search.ts`: `replace: true` for filter/typing updates; keep
   `replace: false` only for genuine tab switches.
8. Add a sidebar filter input.

### Phase 2 — Request budget

9. New `console/request-budget.ts`: `isRateLimited`, `rateLimitBackoff`,
   `useReleaseSchedule`, `SHELL_BASELINE_REQUESTS`, and an `adminQueryOptions()`
   wrapper folding in `throwOnError: false`, tiered `staleTime`/`gcTime`, and the
   429 retry fragment. Route every `*-api.ts` factory through it.
   The `Math.max(current, order + 1)` idempotency guard and `queue.start()` in
   the effect are load-bearing against StrictMode double-mount and must survive
   the move verbatim.
10. Derive Overview's interval from `CHECK_COUNT + SHELL_BASELINE` rather than
    hardcoding 250 ms.
11. Flatten the three prefix-colliding key namespaces.
12. One exported `ADMIN_DIRECTORY_QUERY_INPUT`; delete the three local copies and
    the false comment at `app-passwords-management.tsx:86`.

### Phase 3 — Realtime

13. **Fix the tenant filter on `/events/ws` first** (§3.5).
14. `use-admin-realtime.ts` — ref-counted per-subject hub, targeted invalidation,
    jittered backoff, `connectionState`.
15. Wire the nine sections that have subjects. Give the high-stakes subject-less
    ones an explicit `refetchInterval` with a comment naming the missing subject
    (services 15 s, agent-controls 10 s, audit 20 s on page 1).

### Phase 4 — Broken endpoints

16. Reconcile all four client/server mismatches from §5 and extend
    `mail-admin-api.contract.test.ts` to cover them.

### Phase 5 — Layout system

17. Add the missing primitives: `AdminTable` (semantic `<table>`, one row-height
    token), `AdminToolbar`, `AdminPanel`, `AdminField`, `AdminStatTile`,
    `AdminTabs`.
18. Convert the 8 inline-style files; delete `INPUT_STYLE` and `HEADER_CELL` as
    exported objects; de-duplicate the three `Field` copies.
19. Move `.admin-*` into a layer so Tailwind utilities work on admin elements.
20. Delete the dead CSS; give `PageScroll` a vertical rhythm.

### Phase 6 — Scale and a11y

21. Users: server-side `query`/`type`, `useInfiniteQuery`, virtualized rows.
22. Actor pickers: search + paging instead of a 50 cap.
23. Keyboard: arrow-key handlers on all three tab strips; focusable rows.
24. Authenticate the a11y audit script; extend the route manifest to 23; run axe
    in both themes.

---

## 9. Measurement

Four falsifiable numbers, each produced by a command that already runs in CI.

| Metric                         | Command                                                                    | Baseline (2026-08-03)                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Bundle size                    | `pnpm --filter @helix/web build` → `[plugin helix-bundle-budgets]`         | initial **389.8 kB / 17 chunks**, 175 chunks total                                                                          |
| Requests per cold section load | new `admin-request-budget.test.tsx`, table-driven over `ADMIN_SECTION_IDS` | 1–7 per section against a ceiling of 5                                                                                      |
| Click-to-`<h1>` paint          | new `tests/e2e/admin-navigation-perf.spec.ts`                              | not instrumented; two existing admin specs are **already broken** (they query `role=button` against a `<Link>`)             |
| Suite state                    | `pnpm --filter @helix/web exec vitest run src/features/admin`              | **364 passed / 1 failed** (365 tests, 37 files) — the failure in `ai-providers-management.test.tsx:349` is **pre-existing** |

House constraints any change must respect:

- Test harness is hand-rolled `createRoot`/`act`/memory-router. **No
  `@testing-library` anywhere** — new tests must match the existing style.
- Lint rules that will bite: `helix/pacer-discipline` (bans bare
  `setTimeout`/`setInterval` — scheduled work goes through Pacer),
  `helix/query-refresh-discipline` (bans `.refetch()`),
  `helix/use-query-options`, `helix/mutation-discipline` (every `useMutation`
  needs `onMutate` **and** `onError`).
- Recurring assertions the overhaul must not break: exactly one `<h1>` per
  section with no skipped levels; no native `alert`/`confirm`/`prompt`; distinct
  loading vs empty vs error vs refused states, never a refused request rendered
  as a zero; retry controls that re-issue every failed query; deep-linkable
  `?tab=`; no inline style attributes in `identity-management`.

---

## 10. Implementation status (2026-08-03)

Everything below was implemented, tested and validated in this pass unless
marked otherwise.

### Landed

**Phase 1 — perceived speed**

- `console/section-loaders.ts` (new) — the section table as pure data plus
  dynamic-import thunks, with `preloadAdminSection` and
  `prefetchAdminSectionData`. Deliberately free of React and of any static
  import into the console tree: the route's `loader` is _not_ code-split by
  `autoCodeSplitting`, so importing the prefetch entry point from
  `admin-console.tsx` put the console shell, sidebar, icon set and realtime hub
  into the initial graph of every page. The bundle budget caught it at 605.0 kB
  against a 450.0 kB ceiling; splitting the table out brought it to 393.5 kB.
- `sidebar.tsx` — `onPointerEnter` / `onFocus` preload on every nav row.
- `$section.tsx` — a non-blocking `loader` that starts chunk and data together.
  It also runs under `preloadRoute`, so hover now warms both.
- `SectionSkeleton` replaces `fallback={null}`; the `Suspense` boundary is keyed
  on the section.
- The topbar reads `Admin · <Section>`, outside the Suspense boundary, so it
  repaints on the click itself.
- `admin-related-nav.tsx` — `<a href>` → `<Link>`. Also fixed the one remaining
  raw internal anchor in `mail-admin.tsx`.
- `admin-section-search.ts` — filter/typing updates use `replace: true`; only
  genuine tab switches push history.
- Sidebar filter input, `/`-free, cleared on navigation.

**Phase 2 — request budget**

- `console/request-budget.ts` (new) — `ADMIN_QUERY_DEFAULTS` (`throwOnError:
false`, `gcTime`, tiered `staleTime`, 429-only retry with jittered backoff),
  `useReleaseSchedule`, `releaseIntervalMs`, and the documented constants
  `TENANT_API_RPS_LIMIT` / `SHELL_BASELINE_REQUESTS`. Adopted by 17 query
  factories; Overview's private copy deleted.
- `releaseIntervalMs` derives the interval from the real two-request shell
  baseline, fixing the off-by-one that 429'd Overview's fourth check on every
  cold load.
- `isRateLimited`'s pattern is now anchored on both sides — unanchored it read
  "…page 1429" as a rate limit and silently retried a reported failure.

**Phase 3 — realtime**

- **Security prerequisite fixed first:** `/events/ws` now filters delivery by the
  subscriber's org, fail-closed, with an explicit allowlist for genuinely global
  subjects. `quota.storage.exceeded` gained the `orgId` it accepted and never
  published.
- `use-admin-realtime.ts` (new) — ref-counted one-socket-per-subject hub,
  targeted invalidation, jittered backoff that resets on a received frame,
  permanent stop on 1008/1013, and a `connectionState` the sidebar renders when
  it is not `live`.
- Nine sections subscribe. The three high-stakes subject-less ones got explicit
  intervals with a comment naming the missing emitter: services 15 s,
  agent-controls 10 s, audit `staleTime: 0`.

**Phase 4 — broken endpoints.** All four from §5 fixed, plus three more found
during the work (`generateDkimKey` sent no selector and parsed the wrong
envelope; `createMailProvider`/`patchMailProvider` parsed a bare provider;
`createSendingDomain` parsed a record the create route does not join). The
`byo-storage/.../cutover` route turned out to **already exist** — that §5 row was
an audit false positive, corrected by the implementer and confirmed by review.
Contract tests now assert URL and method for all 15 admin mail client functions
on both sides.

**Phase 5 — layout.** `console/table.tsx` (`AdminTable`) and
`console/controls.tsx` (`AdminField`, `AdminToolbar`, `AdminBulkBar`,
`AdminInput`, `AdminSelect`, `AdminStatTile`, `AdminStatRow`). Every CSS-grid
pseudo-table is gone. Inline `style={{}}` in admin: **137 → 7**. The three
byte-identical `Field` copies are one. `.admin-filter-bar` / `.admin-bulk-bar`
have callers for the first time; `.admin-tier-header` / `.admin-user-detail`
deleted.

**Phase 6 — scale and a11y.** Users searches server-side via `useInfiniteQuery`
with a debounced `?q=`; the "search applies only to loaded rows" banner is gone
because it is no longer true, and the loaded/total counts no longer contradict
each other. Tier readiness and webhooks tab strips got the WAI-ARIA keyboard
interface; the three unnamed webhooks tables got accessible names.

**Measurement.** `admin-request-budget.test.tsx` pins per-section cold-load
request counts against `5 - SHELL_BASELINE_REQUESTS`, with an empty
over-budget ledger that fails in both directions.

### Not done

- **Aggregate endpoints (§2.7).** Billing and Webhooks still fire 3 requests and
  sit at exactly 5 of 5 with the shell. Under budget, no headroom.
- **Virtualization and sorting.** No admin list is virtualized and no column
  sorts. Users pages instead.
- **Actor pickers** in app-passwords / agent-credentials are still capped at 50.
- **The a11y gate still never authenticates**, so every admin route in
  `quality-gates.routes.json` still scans the login page, and axe still runs
  light-theme only.
- **The sidebar still emits six `<h2>` group headings before the page `<h1>`.**
  Defensible as a WAI-ARIA accordion inside a `nav` landmark, and changing it
  breaks tests for a marginal gain.
- **Deliverability SPF/DKIM cards.** The backend can back the DMARC rate but not
  the per-mechanism rates without a new aggregation over
  `mail_dmarc_report_records`. Those two cards are now dropped individually
  rather than taking the whole summary down with them, so the DMARC rate, window
  and message count render for the first time.
- **`ai-observability` is unmeasured** in the request-budget harness: mounting it
  through the console's lazy boundary does not settle in the act() loop. It
  renders correctly (its `<h1>` appears) and its own suite passes; the hang is
  after first paint and is not root-caused. Recorded as `skipped` in the
  snapshot, never as zero.

---

## 11. Verified against a running workspace (2026-08-03)

Everything in §10 was written and tested without the app running. Booting it
(Postgres/Redis/NATS/Meilisearch/RustFS/Cerbos via `docker compose`, API on
:3000, Vite on :5173, signed in as `admin@helix.local`) corrected three things
that source-reading had got wrong, and surfaced one bug that only exists at
runtime.

### Corrections that only a running app could produce

1. **`SHELL_BASELINE_REQUESTS` was wrong, twice.** The original comment said
   one; reading the source suggested two; a real cold load shows **three**
   metered requests landing within 20 ms of each other — `/api/core-apps`,
   `notifications.unread-count` and `notifications.list`. (`/api/auth/get-session`
   fires twice as well and is genuinely exempt, which is what made the smaller
   estimates look right.) The constant now says three and cites the measurement.
   `SECTION_REQUEST_BUDGET` consequently drops from 3 to 2.

2. **The Overview route prefetch was over-eager.** Warming two checks put both
   inside the shell's burst and earned a 429. They recovered — that is the
   429-only retry working — but a card that arrives 1.4 s late having been
   refused is worse than one that waited its turn. It now warms exactly one.

3. **`ai-observability` is not broken.** §10 recorded it as unmeasurable because
   it would not settle in the request-budget harness. In a real browser it
   renders correctly (`<h1>Observability</h1>`, no errors). The hang is an
   artifact of the act()-loop harness after first paint, not a user-visible
   fault.

### Runtime-only bug: liveness competed with the data it keeps fresh

`/events/ws` was metered by the tenant request-rate limiter. The console opens
its event sockets as a section mounts, so the upgrades landed in the same
one-second window as that section's own queries and pushed the page over its
budget — visible on Overview as a Workspace-apps card stuck on "reading…".

A rate limit bounds work per unit time, which is the wrong control for a
connection that costs one upgrade and then lives for minutes. `/events/ws` is
now exempt (`isLongLivedStreamPath`, server.ts) and bounded by the control that
fits: `EventStreamLimiter`, a per-org ceiling on _concurrent_ streams, refusing
with close code 1013 so the client's backoff keeps retrying rather than giving
up the way it does on an auth rejection. `/sse/mail` and `/ws/chat` were left
metered — the same argument applies to them, but exempting a surface means
moving it onto the cap, and that is worth doing per surface with its own
verification.

### Webhooks, built out

The section was **broken on arrival**: three tool calls on cold load, over the
five-per-second ceiling once the shell's three are counted, so it rendered
"Webhook API unavailable: Tenant API request rate limit exceeded" instead of its
content on every single load — with `retry: false` making it stick.

- **`webhook.overview`** (new tool) returns outbound, inbound and recent
  deliveries in one call. Cold load **3 requests → 1**, pinned by the
  request-budget snapshot. The narrower list tools remain for mutations and for
  the filtered delivery view.
- **Replay.** `webhook.outbound.replay` had existed since the feature landed
  with nothing in the UI able to reach it, so a failed delivery was a dead end.
  There is now a Replay control on failed and abandoned _outbound_ deliveries
  only — replaying an inbound record or a delivered one would duplicate an event
  the receiver already acted on. Verified end to end against a deliberately
  unreachable endpoint: attempt went 1 → 2.
- **Deliveries name their endpoint.** New Endpoint column and a resolved name in
  the detail pane, instead of a raw UUID. Falls back to the id, not to a dash,
  so a delivery whose endpoint was deleted stays identifiable.
- **Per-endpoint triage.** `webhook.delivery.list` accepts
  `outboundWebhookId`/`inboundWebhookId`, and "Show this endpoint" jumps from one
  failure to that endpoint's whole history. The UI's single `webhookId` field
  maps to the right column by direction — it was previously sent under a name
  the server ignored, i.e. a filter that looked applied and was not.
- **Two visible defects fixed:** the read-only pane was headed "_Edit_ delivery
  detail", and `.webhooks-detail-row` only styled a `td` variant the component
  never renders, so every label ran into its value ("Directionoutbound").

### Billing

Parked, per the project's open-source posture. Already build-gated off
(`VITE_HELIX_BILLING_ENABLED`), absent from the nav, and `/admin/billing` 404s
rather than rendering an unreachable page. Now also excluded from the
request-budget harness, so a section nobody can reach cannot hold an
over-budget entry open against work nobody is going to do. The code stays: it
is the record of what a hosted build would need.

### Final state

| Check                             | Result                                                                      |
| --------------------------------- | --------------------------------------------------------------------------- |
| All 22 sections in a real browser | load, one `<h1>` each, no error boundary, no rate-limit banner              |
| Webhooks cold load                | 1 request (was 3), 0 × 429 (was a blocking error banner)                    |
| Overview cold load                | 0–1 transient 429 that self-recovers (was 5, with a permanently stuck card) |
| `vitest` web                      | 1234 / 1235                                                                 |
| `vitest` helix                    | 2707 / 2708                                                                 |
| Bundle                            | initial 393.5 kB / 16 chunks (budget 450)                                   |

The two remaining failures are pre-existing and untouched by this work:
`ai-providers-management.test.tsx` (fails in isolation, passes in the full run)
and `cerbos-policy-shape.test.ts` (`admin.chat` / `admin.drive` are in
`SCOPE_CATALOG` with no rule in `infra/cerbos/policies/tool.yaml`; both files
untouched).

### Still open

- `identity`'s `<h1>` reads "Identity" while its nav label is "Identity & SSO" —
  the label/heading rule in `admin-console-data.ts` says these must match.
- Overview's remaining transient 429: the release schedule spaces its five
  checks correctly, but the first release can still land inside the shell's
  burst. Fixing it properly means either an aggregate `GET /api/admin/overview`
  or delaying the first release, and the latter trades first paint for it.
- `/sse/mail` and `/ws/chat` are still rate-metered (see above).

---

## 12. Tier 1 — verified against a seeded workspace (2026-08-03)

§11's verification ran against a nearly-empty workspace: 2 users, 0 domains, 0
webhooks. Every scale claim was therefore untested. This pass seeded a real one
(`db:seed:workspace` + `db:seed:workspace:large` → 23 teammates, 270 mail
threads, 4,670 chat messages, plus 320 probe actors to force paging past the
250-row page) and drove the console against it.

### What held up

- **All 22 sections** load against real data with one `<h1>` each, no error
  boundary and no rate-limit banner.
- **Server-side directory search works across the whole workspace.** `?q=rosa`
  → `?query=rosa` on the wire, 30 rows → 1. With 350 actors, searching for
  "Bulk Tester 0319" — an actor on page 2 — finds it. That was the headline
  claim of the scale work and it is now exercised, not asserted.
- **Paging is correct.** Page 1 shows 250 rows and reads "250 loaded — more not
  yet loaded"; Load more brings it to 350 and the header switches to "350
  users". 350 rows, 350 unique emails — no duplicate rows, which is the classic
  `useInfiniteQuery` failure and the thing most worth checking.
- **Honest empty state.** A search with no matches reads "0 matching" and "No
  users match the current filters", not an empty table.

### Bugs found and fixed

1. **300 of 350 actors were unselectable.** The App passwords and Agent
   credentials actor pickers were a fixed 50-option `<select>` — 51 options in a
   350-actor workspace. The notice said so, which made it an honest dead end
   rather than a silent one, but a dead end either way. Both pickers now have a
   debounced search that queries the directory server-side, so any actor is
   reachable; still one bounded page per request. Verified: searching "Bulk
   Tester 0300" surfaces an actor that was previously impossible to pick.

2. **`identity`'s `<h1>` said "Identity" while its nav label said "Identity &
   SSO".** `admin-console-data.ts` states the rule — clicking a label and
   landing on a differently-titled page reads as having navigated somewhere
   else. Fixed, and the test now pins the label/heading equality rather than the
   literal string.

3. **The audit log was not a named landmark.** Its `<section>` had no accessible
   name. `PageHeading` now exposes `ADMIN_PAGE_TITLE_ID` and the section names
   itself from its own heading, so the two cannot drift apart.

### The three broken admin e2e specs

All seven admin e2e tests pass. They were failing for five separate reasons,
each a genuine drift between spec and product:

| Cause                                                                                                                                 | Fix                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Sidebar renders `<Link>` (role `link`), specs queried role `button`                                                                   | query links                                                             |
| Related-pages chips are real links now, so `role=link` matched twice                                                                  | scope nav clicks to the `navigation` landmark                           |
| Specs asserted pre-taxonomy page titles ("OAuth client credentials", "Security tier readiness", "AI observability", "Admin services") | assert the current `<h1>`, which is required to equal the sidebar label |
| Applying a security tier now routes through the destructive-confirm dialog                                                            | confirm it                                                              |
| The plugin catalog moved behind a tab                                                                                                 | click the tab                                                           |

Two assertions were also ambiguous rather than wrong (`Services` matched both
the page `<h1>` and a summary-card `<h3>`; `getByText("Live tier")` matched the
label and every ancestor). Pinned by heading level and `exact`, not deleted.

### Final state

| Check                                       | Result                                    |
| ------------------------------------------- | ----------------------------------------- |
| 22 sections, seeded workspace, real browser | all clean                                 |
| Web unit suite                              | 1235 / 1235                               |
| Admin e2e                                   | 7 / 7 (was 3 specs failing)               |
| Backend suite                               | 2707 / 2708                               |
| Bundle                                      | initial 393.5 kB / 16 chunks (budget 450) |
| Lint / typecheck / format                   | clean for every file this work touched    |

### Still open, unchanged

- `cerbos-policy-shape.test.ts` — `admin.chat` / `admin.drive` are in
  `SCOPE_CATALOG` with no rule in `infra/cerbos/policies/tool.yaml`. Both files
  untouched by this work; a failing _permissions_ test is worth a decision.
- Overview's occasional transient 429 (self-recovers). The real fix is a
  `GET /api/admin/overview` aggregate, which would also delete the release-pacing
  machinery entirely.
- The accessibility gate still never authenticates, so its admin routes scan the
  login page. Every a11y claim about this console remains unverified by CI.
- No admin list is virtualized and no column sorts.
- `/sse/mail` and `/ws/chat` are still rate-metered.
- A heading in tier readiness was renamed ("Install permissions prompt" →
  "Catalog and install") somewhere in that section's in-flight restructure; the
  e2e spec now follows the current name.

---

## 13. The accessibility gate now actually audits the console (2026-08-03)

### What was wrong

`pnpm quality:a11y` runs axe over `quality-gates.routes.json` — 26 routes × 3
viewports × 2 themes — and reported a pass. It never established a session, so
every route behind the app shell (Mail, Chat, Drive and all nineteen `/admin/*`
entries) redirected to `/login`. The gate had been auditing the login page
twenty-odd times per run and calling it coverage.

That is worse than having no gate: a green light nobody earned.

### The fix

`scripts/a11y-session.mjs` (new) gives the audit a signed-in browser context —
seeding the token the shell reads and answering `/api/**` from fixtures, the
same way the mocked E2E specs do, because CI runs this against a `vite preview`
with no backend. Two contexts are created per viewport/theme: `/login` and
`/signup` deliberately keep an anonymous one, since seeding a session there
would bounce into the shell and stop auditing the auth screens — the same bug
pointing the other way.

### What it found, and what was fixed

The first authenticated run reported **302 violations / 2,016 failing nodes**,
where the previous "passing" run had been scanning login pages.

Counting _nodes_ rather than violations is the honest measure here — axe groups
every node on a route into one violation, so fixing some nodes leaves the
violation count flat.

| Scope                                       | Before  | After  |
| ------------------------------------------- | ------- | ------ |
| All routes (nodes)                          | 2,016   | 1,410  |
| `/admin` routes (nodes)                     | 1,715   | 1,109  |
| **`/admin`, admin-console-owned selectors** | **639** | **60** |

Fixed, all admin-owned:

- **`target-size` (214 → 0).** The sidebar's collapsible group toggles were
  14.3 px tall against WCAG 2.2's 24 px minimum — the control an operator hits
  to fold a nav group was half the required size.
- **`empty-table-header` (6 → 0).** App passwords and Agent credentials declared
  their actions column as `header: ""`, so screen readers got an unnamed column.
  Now visually-hidden text, matching what `AdminTable` already does.
- **`color-contrast` (829 → ~481 on admin routes).** `--text-3` (`#a8a29e`) on
  `--surface` (`#ffffff`) measures **2.52:1** — below AA at any size. Every
  admin rule using it for text moved to `--text-2`.

### What is left, and whose it is

Of the 1,109 nodes still failing on admin routes, **1,061 are shell-level, not
admin-level**: the left app rail (`region` — the rail's links sit outside any
landmark), the topbar search placeholder and ⌘K badge (contrast), and the
`.avatar` component (`role="img"` with no accessible name). They appear on
admin routes only because every admin page renders inside that shell.

The remaining ~60 admin-owned nodes are all the same `--text-3` contrast issue
in rules this sweep did not reach.

**The root cause is a token, not a stylesheet.** `--text-3` cannot legally be
used for text on `--surface` anywhere in the product. Retuning it once (light
mode needs roughly `#78716c` or darker for 4.5:1) would fix this class across
every surface at a stroke. That is a product-wide visual change, so it is
flagged here rather than made unilaterally.

Also unfixed: `page-has-heading-one` on `/`, `/mail`, `/chat` and `/drive` —
those surfaces have no `<h1>`. Admin pages all do, because `PageHeading`
guarantees it.

### Consequence to decide

**The gate now fails.** It exits non-zero on 239 violations where it previously
passed on a lie. Before this can gate CI, someone has to choose between:

1. fixing the shell-level issues (the rail landmark, the avatar name, the
   contrast tokens) — the real fix, and mostly outside the admin console; or
2. recording a documented baseline that fails in both directions — new
   violations fail, and a fixed one fails too until its entry is deleted. That
   is the same ledger shape as `OVER_BUDGET_ALLOWLIST` in
   `admin-request-budget.test.tsx`, and it is the honest way to hold a line
   while the backlog is worked down.

What it must not do is go back to passing by not looking.

---

## 14. `GET /api/admin/overview` — the aggregate (2026-08-03)

The last item that kept Overview paced and occasionally 429-ing.

### The change

`apps/helix/src/platform/admin/overview.ts` (new) fans out server-side to the
five sources the page reads. The readers passed to it in `server.ts` are the
_same functions the individual endpoints use_ — `readDomainsWithRecords`,
`readSecurityPolicies`, `platformConfig.getStatus`, `adminUsersStore.listUsers`
and `buildCoreAppsAdminStatus`, three of which were extracted from inside their
route handlers for the purpose — so the aggregate cannot drift away from the
section pages it summarises.

### The property that had to survive

Overview's discipline is that a figure may only be rendered from a response that
actually arrived. Five independent requests gave that for free: one endpoint
down left the other four cards accurate.

A naive aggregate destroys it — a single failing source fails the whole request
and blanks all five cards, turning a precise reading into a total outage. So
each source is caught individually and reports its own status:

```
{ "signals": { "domains": { "status": "ok", "data": … },
               "policies": { "status": "unavailable", "reason": "…" }, … } }
```

The client adapts each signal into something query-shaped, so `useQueryFailure`,
`toSignal` and the per-card banners all work unchanged. The page actually gained
something: a per-signal `reason`, where a 403 on one source used to be
indistinguishable from that source being unreachable.

### What went away

- `useReleaseSchedule` / `pacedQueryOptions` on Overview, and the `CHECK_COUNT`
  release order.
- The five-key `refreshAll` fan-out — Refresh is now one invalidation.
- The whole "prefetch only the first check" balancing act: with one request
  there is nothing to pace and no reason to warm part of it.

`console/request-budget.ts` stays: it still owns the shared 429 policy and the
`throwOnError`/`staleTime`/`gcTime` defaults for every other section, and
`useReleaseSchedule` remains exported for any section that ever needs it.

### A bug the tests caught

The rate limiter answers with a _nested_ envelope
(`{ error: { code, message, traceId } }`). The first version of the client took
`payload.error` as the message, so `new Error({…})` produced `"[object Object]"`
— no trailing status, so `isRateLimited` could not see the 429 and the shared
retry never fired. A refused page stayed refused: precisely the permanent
failure the retry exists to prevent. Only a string `error` is treated as a
message now.

### Measured against the running workspace

|                                                    | before | after                       |
| -------------------------------------------------- | ------ | --------------------------- |
| Overview cold load, metered requests               | 8–9    | **4** (3 shell + 1 section) |
| 429s across three consecutive loads                | 1–5    | **0**                       |
| Cards stuck on "Checking…"                         | 1      | **0**                       |
| Self-imposed pacing before the last card can paint | ~1 s   | none                        |

Where this session started, Overview's Workspace apps card sat on "reading…"
behind a banner reading "1 check is still loading". It now fills every card from
one request.

### Gates

Web 1234/1235 (the known `ai-providers` flake) · admin suite 413/413 · backend
2707/2708 (the pre-existing `cerbos-policy-shape` failure) · admin e2e 7/7 ·
lint, format and typecheck clean for everything touched · bundle initial
393.5 kB / 16 chunks against a 450 kB budget.

---

## 15. The dark pass (2026-08-03)

### The dark audit had never run

§13 enabled the accessibility gate on the admin console and noted axe was
light-only. Turning axe on for dark revealed something worse: **the dark pass
had never been dark.**

`prepareTheme` seeded `localStorage["helix-color-mode"]`. Nothing themes off
that key. The theme lives in `helix-appearance` and is applied to the document
as `data-theme` (`src/components/settings-store.ts`), which is what
`styles.css` selects on. Every "dark" run was a second light run — same tokens,
same surfaces, near-identical findings, reported as dark coverage.

Proof, before the fix, with `colorScheme: "dark"` requested and
`data-color-mode="dark"` set on the root:

```
light  --surface: #fff      --text: #1c1917   body: rgb(250,250,249)
dark   --surface: #fff      --text: #1c1917   body: rgb(250,250,249)
```

After seeding `helix-appearance`:

```
dark   --surface: #131316   --text: #ededee   body: rgb(10,10,11)
```

This is the same family of bug as the routes that were silently scanning the
login page: a gate reporting coverage it did not have. Two of the three
accessibility "greens" this project had were of that kind.

A second, quieter defect fixed alongside it: the hand-written contrast parser in
`collectVisualSmoke` blended translucent colours against **white** regardless of
theme, so every alpha calculation in dark mode was computed against a page that
does not exist. It now blends against the document's own background.

### What dark actually looks like

Once the theme applied, the answer was reassuring and worth stating plainly:

|                                                    | light | dark  |
| -------------------------------------------------- | ----- | ----- |
| `/admin` failing nodes                             | 1,113 | 976   |
| admin-console-owned                                | 70    | 15    |
| **contrast targets failing in dark but not light** | —     | **0** |

**There is no dark-specific regression in the admin console.** Every contrast
failure dark has, light has too; light has 18 that dark does not. Dark is the
easier theme here, because `--text-3` on a dark surface clears AA while the same
token on white does not. The console's new primitives — the shared table, stat
tiles, form controls, nav filter and skeleton — all render correctly in dark;
they were verified by screenshot as well as by axe.

### Fixed in this pass

- `.admin-failure-detail` used `opacity: 0.85` to de-emphasise the raw error
  message. Opacity dims the text _and_ its background, so the ratio fell below
  AA in both themes — and it is the one line support can act on. It is now
  de-emphasised by colour, which the contrast tokens account for.
- The fifteen `text-[var(--text-3)]` utilities in Overview's signal cards.
- The a11y session had no `/api/admin/overview` fixture after §14 landed, so the
  audit was measuring Overview's five error banners and calling it Overview.
  Auditing a surface's failure state and reporting it as the surface is the same
  error as auditing the login page and calling it Users.

Admin-owned failing nodes over this pass: **light 120 → 70, dark 65 → 15.**

### What is still left, unchanged

The dominant remainder on admin routes is shell-level and identical in both
themes: the app rail's links sit outside any landmark (`region`), `.avatar`
carries `role="img"` with no accessible name, and the topbar search placeholder
and ⌘K badge fail contrast. Plus the `--text-3` token itself, which cannot be
used for text on `--surface` in light mode anywhere in the product.

The gate still fails, and still needs the decision recorded in §13: fix the
shell issues, or record a baseline that fails in both directions. It should not
go back to passing by not looking — which, it turns out, it had been doing in
two separate ways.

---

## 16. Virtualization and sorting (2026-08-03)

The last Tier 2 item, and the last of §6's list-scale findings: no admin list
was virtualized and no column anywhere in the console could be sorted, on a
directory that pages 250 rows at a time.

Both went into `console/table.tsx` rather than into Users, so every section
already on `AdminTable` — Users, Domains, Groups, OAuth apps, Billing, Mail —
gets them without changing a line.

### Sorting

Opt-in per column via `sortValue`, deliberately separate from `cell`: what you
sort on is rarely what you render (a status chip sorts on its status, not on its
JSX; the Role column sorts on privilege order, not on the alphabet, because
A-Z would interleave Admin and Member around "Scoped admin" and mean nothing).

Three states, not two — **none → ascending → descending → none**. The unsorted
state has to stay reachable because for several of these lists the server's
order _is_ information: the audit log and the directory are newest-first, and a
two-state toggle would make that unrecoverable without a reload.

Two details that are load-bearing rather than decorative:

- **Unknown sorts last in both directions.** Filing every unnamed actor at the
  top of an A-Z sort invites the reader to believe those are the As. This is
  handled _inside_ the comparator rather than by a direction multiplier applied
  to its result — a bug the new tests caught: multiplying flipped the nulls to
  the front on the descending pass.
- **Rows sharing a sort value keep their relative order.** The directory
  interleaves an expanded detail row directly after its parent and gives both
  the same sort value, so a stable sort keeps the pair together instead of
  flinging the detail to the far end of a name sort.

The direction indicator is drawn by CSS from `aria-sort`, so the glyph stays out
of the header's text content and out of its accessible name — the semantics live
in `aria-sort`, which is what assistive tech reads.

**Honesty:** sorting reorders what is _loaded_, not what exists. When a page is
still outstanding, the sorted column carries "Sorted within the N rows loaded so
far" — and it disappears once everything is loaded, because there is no longer a
caveat to make. Without it, "sorted by name" would be a claim about the whole
workspace: the same lie the client-side search told before search moved to the
server.

### Virtualization

Above 60 rows the table renders into a focusable scroll container and windows
its rows. Below it, plain DOM — virtualizing a ten-row table costs a measured
height and two spacer rows to save nothing, and the threshold keeps every
existing section (and its tests) on the simple path.

The scroll container carries `tabIndex={0}`: a scroll region nobody can focus is
a region a keyboard user cannot read past the first screen — axe's
`scrollable-region-focusable`, which the console was already failing elsewhere.

### Measured against a 350-actor workspace

|                                       | before | after                                 |
| ------------------------------------- | ------ | ------------------------------------- |
| Rows in the DOM at 250 loaded         | 250    | **24**                                |
| Rows in the DOM at 350 loaded         | 350    | **24**                                |
| Sortable columns in the admin console | 0      | Users ×4, and any column that opts in |

Verified in the browser at full scale: name ascending starts at "Alex Torres"
and descending at "Zed Tester 0319"; Role ascending puts the scoped admin above
the members; the partial-sort caveat appears at 250 of 350 and disappears once
all 350 are loaded; zero console errors.

### Gates

Web 1244/1245 (the known `ai-providers` flake) · admin + webhooks 446/447 ·
admin e2e 7/7 · lint and format clean for everything touched · bundle initial
393.5 kB / 16 chunks against a 450 kB budget.

### Tier 2 is done

Remaining, all previously recorded and none of it admin-console-owned: the
accessibility gate's shell-level backlog and the baseline decision (§13, §15),
the `--text-3` token, `cerbos-policy-shape`, and the `ai-providers` flake.
