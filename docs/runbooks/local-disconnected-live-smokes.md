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

1. Start infra on **high consecutive ports** (example `38600–38615`, avoids default `28431+` and host `:5432`):

```sh
export COMPOSE_PROJECT_NAME=helix-smoke-hi
export HELIX_PORT=38600 POSTGRES_PORT=38601 REDIS_PORT=38602
export NATS_CLIENT_PORT=38603 NATS_MONITOR_PORT=38604 MEILI_PORT=38605
export RUSTFS_API_PORT=38606 RUSTFS_CONSOLE_PORT=38607
export CERBOS_HTTP_PORT=38608 CERBOS_GRPC_PORT=38609
export CADDY_HTTP_PORT=38610 CADDY_HTTPS_PORT=38611 CADDY_ADMIN_PORT=38612
export HELIX_SMTP_RECEIVE_PORT=38613 MAILPIT_SMTP_PORT=38614 MAILPIT_WEB_PORT=38615
export RUSTFS_SERVER_DOMAINS=localhost,rustfs,localhost:38606,localhost:9000,rustfs:9000
docker compose up -d --build postgres redis nats meilisearch rustfs cerbos mailpit
# If Cerbos hits inotify limits: disable watchForChanges or raise fs.inotify.max_user_instances
# Create object bucket once: aws s3 mb s3://helix-objects --endpoint-url http://127.0.0.1:38606
```

2. Start Helix API on host (or compose `helix`) with matching env (`DATABASE_URL`, `RUSTFS_ENDPOINT`, `MAIL_SMTP_*` → Mailpit, `MAIL_SMTP_RECEIVER_PORT=38613`, `CERBOS_HTTP_URL`, `HELIX_DEFAULT_ORG_ID=00000000-0000-0000-0000-000000000000`).
3. Migrate + seed: `db migrate`, `db:seed:oauth` (include `mail.external`, `chat.create`), `db:seed:logins`.
4. Raise local smoke quotas if needed: org `quotas.api_rps_limit = null` (personal default can 429 at 5 rps).
5. Seed `helix.local` as active receiving domain for SMTP tests.
6. Tokens:

```sh
export HELIX_BASE_URL=http://127.0.0.1:38600
export HELIX_SMOKE_CLIENT_ID=helix-local-oauth-client
export HELIX_SMOKE_CLIENT_SECRET=helix-local-dev-secret
export HELIX_SMOKE_SMTP_PORT=38613
export HELIX_SMOKE_MAILPIT_URL=http://127.0.0.1:38615
# OAuth client-credentials → HELIX_ACCESS_TOKEN (admin-like scopes)
# Limited user session: sign-in user@helix.local → HELIX_SMOKE_USER_TOKEN
```

```sh
pnpm quality:local-disconnected-live-smokes -- --execute --iterations 100 --base-url "$HELIX_BASE_URL"
```

**Core live flags** (blocking): assistant, search reindex, audit.  
**Optional residual** (non-blocking): mail SMTP full outbound approve, WebDAV, chat realtime WS.

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
