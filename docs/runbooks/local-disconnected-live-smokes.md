# Local disconnected multi-surface live smokes

**Audience:** Operators and agents validating Helix offline (no public internet).  
**Script:** `scripts/local-disconnected-live-smokes.mjs`  
**npm:** `pnpm quality:local-disconnected-live-smokes`

## What this is

A single entry point that:

1. **Always** validates domain live-evidence **contracts** (`--static` / not_run skeletons for mail, agent, chat, drive).
2. **Always** runs the **negative security matrix** inventory (links to real isolation tests).
3. **Always** runs a **multi-actor RBAC unit battery** (mail, drive, chat, agents, tenancy, admin offboard, packaging) against shipped modules.
4. **Optionally** (`--execute`) probes a **running** local stack (Mailpit, RustFS, Postgres, …) via `live-auth-smoke` multi-surface flags, dual-token RBAC API probes, optional mail `--local`, and a health soak loop.

**Never forges** Gmail / Microsoft 365 / provider-sandbox passes. Those stay `not_run` in the report.

## Prerequisites

### Static-only (default, air-gapped unit/contract)

- Node + pnpm install completed
- No Docker required

```sh
pnpm quality:local-disconnected-live-smokes
# or
pnpm quality:local-disconnected-live-smokes -- --static-only --iterations 25
```

### Full local execute

1. Start infra: `pnpm infra:up` (postgres, rustfs, mailpit, meilisearch, redis, nats, …)
2. Start app: `scripts/dev-up.sh` (or compose helix service on `:28431`)
3. Seed OAuth: `pnpm --filter @helix/app db:seed:oauth`
4. Seed login users (admin + user): as used by `db:seed` / login seed (`admin@helix.local` / `user@helix.local`)
5. Mint or export tokens for dual-user probes (optional but recommended):

```sh
export HELIX_BASE_URL=http://127.0.0.1:28431
export HELIX_SMOKE_CLIENT_ID=helix-local-oauth-client
export HELIX_SMOKE_CLIENT_SECRET=helix-local-dev-secret
# Optional dual-user RBAC live probes:
export HELIX_SMOKE_ADMIN_TOKEN=<bearer for admin scopes>
export HELIX_SMOKE_USER_TOKEN=<bearer for limited user scopes>
# Optional full mail --local (see docs/mail-live-evidence.md):
# export HELIX_MAIL_LIVE_ORG_A_TOKEN=...
```

```sh
pnpm quality:local-disconnected-live-smokes -- --execute --iterations 100
```

## Surfaces covered

| Surface            | Static / unit                             | Live (`--execute` + healthy stack)                          |
| ------------------ | ----------------------------------------- | ----------------------------------------------------------- |
| Mail               | negative tests + tool matrix              | `--mail-smtp-smoke` (Mailpit), optional mail-live `--local` |
| Drive              | authz + quarantine invariants + matrix    | seeded demo tools, WebDAV smoke                             |
| Chat               | non-member authz + matrix                 | `--chat-realtime-smoke`                                     |
| Assistant / agents | policy firewall, kill self-unlock, limits | `--assistant-smoke`, `--agent-limits-smoke`                 |
| Admin / offboard   | org-scoped offboard 404                   | dual-token admin.users allow/deny + foreign offboard 404    |
| Search             | packaging/search reindex units            | `--search-reindex`                                          |
| Tenancy            | cross-tenant isolation suite              | residual unless multi-org live fixtures                     |
| Packaging          | production assertions MVP allowlist       | —                                                           |
| External mail      | **not_run**                               | **not_run**                                                 |

## Report output

Default: `artifacts/local-disconnected-smokes/<timestamp>/`

- `report.json` — phase statuses, external not_run, claims flags
- `*.log` — per-phase command transcripts

Claims in report:

- `local_disconnected_contracts` — static phases green
- `multi_actor_rbac_units` — RBAC vitest battery green
- `external_mail_deliverability: false`
- `final_release_go: false`

## Relationship to final release

This harness is **local preflight**, not `docs/final-release-readiness.md` final mode. For production GO you still need digest-bound live gates and (for mail) optional external deliverability with honest `not_run` when omitted.

## Multi-user security expectations

Unit battery enforces:

- Org A cannot read Org B Drive/mail/chat
- Chat non-members cannot list/send
- Agents queue confirmation on writes; kill self-unlock
- Admin offboard foreign actor → no cascade

Live dual-token probes (when tokens set) enforce:

- Admin `GET /api/admin/users` → 200
- User `GET /api/admin/users` → 401/403
- Admin `POST .../offboard` foreign UUID → **404** (not 200)

## Troubleshooting

| Symptom                        | Action                                                         |
| ------------------------------ | -------------------------------------------------------------- |
| healthz skipped on `--execute` | `pnpm infra:up` + `scripts/dev-up.sh`; check `HELIX_BASE_URL`  |
| live-auth-smoke fails OAuth    | `pnpm --filter @helix/app db:seed:oauth`                       |
| mail-live-local skipped        | configure `HELIX_MAIL_LIVE_*` per `docs/mail-live-evidence.md` |
| unit battery fails             | fix failing vitest file first; harness is fail-closed          |

## Related

- `docs/mail-live-evidence.md` — `--static` / `--local` / external
- `infra/scripts/live-auth-smoke.sh` — full live flag surface
- `docs/runbooks/pilot-install-zero-to-mail.md` — pilot install path
- `docs/architecture/mvp-r3-structural-decision.md` — no false GO
