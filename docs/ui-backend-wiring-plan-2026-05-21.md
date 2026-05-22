# UI ↔ Backend Wiring Plan

**Date:** 2026-05-21 · **Branch:** `ui-overhaul`
**Goal:** wire every new UI surface to real backend APIs; where the API doesn't exist, build it
to enterprise standard, sized to the UI's capabilities.

## Per-surface gap (UI need vs. backend today)

| Surface | Wired today | Gap to close |
|---|---|---|
| Mail | `mail.send` only | Folder model, category-tab classification, labels, thread list+previews+bodies, star/archive/snooze/label actions, operator search → wire to mail tools; extend mail backend for folder + tab projection |
| Calendar | `calendar.events` | Calendar-list (My calendars / Team) API; event create/update from the grid + popover |
| Drive | `drive.list` | Wire details-panel actions (open/download/share/move/trash); recent-activity feed |
| Docs | list (merged) | Editor → real Yjs sync, comments, suggestions/version history, outline; share dialog → `docs` share |
| Sheets | 100% seed | **NEW backend domain** — sheets + sheet tabs + cell data; CRUD tools; persistence |
| Slides | 100% seed | **NEW backend domain** — decks + slides (typed layouts); CRUD tools; persistence |
| Meet | hub (rooms) | Scheduled meetings, recent meetings + recordings, in-call token mint |
| Chat | 100% seed | Wire to real chat backend (rooms, messages, reactions, threads, WS realtime) |
| Assistant | streaming | Conversation list + persistence (`assistant_conversations`); pin/search |
| Admin | Users | Groups & OUs, Security policies, OAuth apps, Billing, Audit log (exists), Domain/DNS APIs |

## Build waves

**Wave 1 — backend (5 agents, disjoint modules, none touch `server.ts`)**
- BE-sheets: `platform/sheets/**` + migration — sheets, sheet_tabs, sheet_cells; tools; `registerSheets*`.
- BE-slides: `platform/slides/**` + migration — decks, slides (typed layout JSON); tools; `registerSlides*`.
- BE-mailcal: extend `platform/mail` (folder + category-tab + label projection, thread list/body) and `platform/calendar` (calendar-list).
- BE-admin: `platform/admin/**` — groups/OUs, security policies, OAuth apps, billing, domain; tools/routes.
- BE-meetasst: extend `platform/meet` (scheduled/recent meetings, recordings) and `platform/assistant` (conversation list/search/pin).

**Wave 1.5 — `server.ts` registration** (lead): wire all new `register*` exports + routes + OpenAPI.

**Wave 2 — UI wiring (per-surface agents):** replace each surface's seed with real TanStack Query
calls to the now-complete APIs; keep typed seed only as offline fallback.

**Enterprise bar:** every new API — Zod-validated, scope-gated, audited, paginated, error-enveloped,
OpenAPI-documented, tested. Migrations 0021+.

**Verify each wave:** `apps/helix` + `apps/web` typecheck + lint + test + build.
