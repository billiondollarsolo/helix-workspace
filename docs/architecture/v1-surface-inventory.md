# Full Workspace v1 surface inventory

**Date:** 2026-08-02  
**Task:** G0.1  
**Source of truth for packaging today:** `apps/web/src/components/apps.ts`, `apps/helix/src/config/production-assertions.ts`  
**Forward plan:** `docs/superpowers/plans/2026-08-02-helix-full-workspace-v1-release.md`

## Packaging today (production MVP fail-closed)

| Mechanism                          | Value                                                   |
| ---------------------------------- | ------------------------------------------------------- |
| `VITE_HELIX_MVP_ONLY=true`         | Filters launcher to mail, drive, chat, assistant, admin |
| `HELIX_APPS` production            | Must be exactly `mail,drive,chat,assistant`             |
| `HELIX_EDITORS_MIGRATIONS_ENABLED` | Must be `false` in production                           |
| Disabled modules                   | Explicit `modules.*.enabled=false` for non-MVP          |

## Surface matrix

| Surface            | Web UI path                        | Platform/API path                                    | Packaging today                 | Full Workspace v1 target             | Status (honest)                    | Gap owner           |
| ------------------ | ---------------------------------- | ---------------------------------------------------- | ------------------------------- | ------------------------------------ | ---------------------------------- | ------------------- |
| Mail               | `apps/web/src/features/mail/`      | `apps/helix/src/platform/mail/`                      | MVP on                          | GA                                   | code-exists; evidence partial      | M.*                 |
| Drive              | `apps/web/src/features/drive/`     | `apps/helix/src/platform/drive/`                     | MVP on                          | GA                                   | code-exists; scan/evidence partial | D.*                 |
| Chat               | `apps/web/src/features/chat/`      | `apps/helix/src/platform/chat/`                      | MVP on                          | GA (not E2EE)                        | code-exists; live evidence partial | C.*                 |
| Assistant / agents | `apps/web/src/features/assistant/` | `tool-registry`, `api/mcp.ts`, `platform/assistant/` | MVP on                          | GA least-privilege                   | code-exists; policy matrix partial | A.*                 |
| Admin              | `apps/web/src/features/admin/`     | `platform/admin/`, tenancy                           | UI on; not in HELIX_APPS string | GA ops                               | code-exists; enforce-or-hide debt  | ADM.*               |
| Calendar           | `apps/web/src/features/calendar/`  | `platform/calendar/`                                 | **off** (MVP filter)            | GA                                   | partial                            | CAL.*               |
| Meet               | `apps/web/src/features/meet/`      | `platform/meet/`                                     | **off**                         | GA (Jitsi)                           | partial (Jitsi path exists)        | MT.*, O-D.9, O-K.10 |
| Docs               | `apps/web/src/features/docs/`      | `platform/docs/`, helix-editors                      | **off**                         | GA                                   | partial; editors sibling           | ED.*                |
| Sheets             | `apps/web/src/features/sheets/`    | `platform/sheets/`                                   | **off**                         | GA                                   | partial                            | ED.*                |
| Slides             | `apps/web/src/features/slides/`    | `platform/slides/`                                   | **off**                         | GA                                   | partial                            | ED.*                |
| PDF                | `apps/web/src/features/pdf/`       | Drive preview                                        | preview only                    | preview GA; edit non-goal unless ADR | partial                            | ED.6, D9            |
| Search             | `apps/web/src/features/search/`    | `platform/search/`                                   | supporting                      | GA                                   | partial                            | SRCH.*              |
| Signup/onboarding  | `features/signup/`, routes         | `platform/signup/`                                   | supporting                      | self-host + S+ later                 | code-exists                        | ID._, S+._          |
| Notifications      | shell + features                   | `platform/notifications/`                            | on                              | on                                   | code-exists                        | UX.7                |
| Shell chrome       | `components/shell/`                | —                                                    | on                              | on                                   | partial (resilience branch)        | UX.*                |

## allApps registry (complete)

From `apps.ts`: mail, calendar, drive, docs, sheets, slides, meet, chat, assistant, admin.

## Dormant / non-advertised under MVP packaging

calendar, docs, sheets, slides, meet — routes may still exist for dev builds when `VITE_HELIX_MVP_ONLY` is not true.

## Notes

- Do **not** enable Meet/Calendar/Editors packaging until PKG.* and domain enablement gates in the v1 bible.
- Platform also contains carddav, connectors, plugins, metering — not first-class launcher apps; treat as supporting.
