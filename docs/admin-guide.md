# Admin Guide

Phase 9 documentation pass for TASK-A09.

## Supported Business pilot profile

The first supported production profile is one organization with 5–50 trusted users on the
`business` security tier. Tenant-aware internals and cross-organization tests remain mandatory, but
public multi-tenant SaaS is not a supported pilot configuration. The accepted constraints and
reversal triggers are indexed in the
[architecture decision records](architecture/README.md).

Before enabling pilot users, operators must enforce and evidence all of the following:

- Configure a supported managed outbound email provider. Mailpit is for local evidence only, and
  Helix does not operate direct-to-MX outbound delivery for the pilot.
- Present Mail through the Helix web UI and supported APIs. The pilot does not include a
  Helix-hosted IMAP server.
- Describe Chat accurately: it uses encrypted transport, organization and room authorization,
  retention, audited administrative access, and deployment-attested storage encryption. Chat is
  **not end-to-end encrypted**, and authorized server administrators can technically access stored
  messages.
- Allow authorized agent reads immediately, but require authenticated human confirmation for every
  agent write by default. An unattended write requires an explicit, audited automation policy
  bounded by exact action, resource, target, time window or expiry, and rate.
- Untrusted Business-tier uploads remain unavailable to download, preview, share, attach, index,
  WebDAV, and agent reads until integrity checks and a real malware scanner return a clean verdict.
  Scanner failure, timeout, or unsupported results remain quarantined. A no-op scanner is not a
  valid Business configuration.
- Monitor the 99.5% monthly availability objective and rehearse encrypted backup restoration to an
  RPO of no more than 24 hours and an RTO of no more than 4 hours. These are pilot engineering
  objectives, not a contractual SLA.

Native Docs, Sheets, Slides, and PDF editing are not part of this MVP. Drive file storage,
read-only preview, versions, sharing, download, and WebDAV remain in scope. Calendar and Meet are
also disabled. Any later commands in this guide that exercise Docs, Calendar, Meet, or editor
workflows are development/full-workspace evidence only and are not pilot acceptance steps for the
storage-only production profile.

Desktop file sync: users run **`pnpm helix:drive-sync`** (or
`node scripts/helix-drive-sync-setup.mjs`), enter server URL + app password, and pick **mirror
folder** or **virtual drive**. No manual rclone config required. See
[Drive desktop sync](drive-desktop-sync.md).

## Quality Gate Responsibilities

Admins own release readiness for:

- accessibility audit results
- visual route review evidence
- k6 smoke and load results for configured web and API targets
- plugin documentation updates
- troubleshooting notes for known operational failures

## Running Gates

Accessibility:

```sh
pnpm --filter @helix/web build
pnpm --filter @helix/web preview
pnpm quality:a11y
```

k6:

```sh
WEB_BASE_URL=http://127.0.0.1:4173 API_BASE_URL=http://127.0.0.1:3000 pnpm quality:k6:target
```

Mocked k6 script validation without a running Helix stack:

```sh
infra/scripts/validate-k6.sh
```

Syntax/static validation when neither k6 nor Docker is available:

```sh
infra/scripts/validate-k6.sh --static
```

Useful k6 overrides:

- `WEB_ROUTES=/,/login,/mail`
- `API_TARGETS=/healthz,/readyz,/metrics,/openapi.json`
- `K6_SCENARIO_GROUPS=web_navigation,api_smoke,mail_api,inbound_mail,search,chat,docs,meet_jitsi,plugin_install,assistant_llm,mcp,otel_health`
- `AUTH_TOKEN=<token>`
- `K6_TRACE_TOKEN=<stable-evidence-id>` or `HELIX_TRACE_TOKEN=<stable-evidence-id>`
- `SKIP_PROTECTED_WITHOUT_AUTH=false`
- `WEB_VUS=5`
- `API_VUS=5`
- `PRD_VUS=2`
- `WEB_DURATION=1m`
- `API_DURATION=1m`
- `PRD_DURATION=1m`
- `SEARCH_TOOL_IDS=mail.search,chat.search,drive.search`
- `SEARCH_TOOL_IDS=search.query`
- `SEARCH_BODY='{"query":"helix-volume-mail-search","types":["mail"],"limit":20}'`
- `MAIL_API_BODY='{"query":"","limit":50}'`
- `INBOUND_MAIL_ACCEPT_PATH=/webhooks/<mail-ingest-slug>`
- `INBOUND_MAIL_MARKER=release-k6-inbound-001`
- `INBOUND_MAIL_SEARCHABLE_P95_MS=5000`
- `ASSISTANT_BODY='{"message":"Route this request without side effects."}'`
- `PLUGIN_INSTALL_BODY='{"pluginId":"com.helix.core.search-meilisearch","version":"1.0.0","source":"official"}'`
- `PLUGIN_INSTALL_EXPECT=pending_confirmation`

Protected PRD groups are skipped by default when `AUTH_TOKEN` is absent. Provide
`AUTH_TOKEN` to exercise protected endpoints, or set `K6_SCENARIO_GROUPS` to a
reduced list for deployments that do not expose every PRD surface yet.
Set `K6_TRACE_TOKEN` or `HELIX_TRACE_TOKEN` to attach a deterministic W3C
`traceparent` header to k6 web/API/tool/MCP requests so target-mode p95 evidence
can be correlated with OpenTelemetry traces.

The `inbound_mail` group posts a synthetic inbound mail payload to
`INBOUND_MAIL_ACCEPT_PATH`, then polls `mail.search` for `INBOUND_MAIL_MARKER`.
By default it uses the authenticated backend bridge tool
`/api/tools/mail.inbound.accept`, which reuses the same RFC822 parser and store
path as SMTP ingest. For provider-specific target-mode evidence, override the
path/body to the deployment's signed inbound bridge and keep `INBOUND_MAIL_TO`
mapped to a visible local actor such as `local-admin@helix.local`.

## Live CLI Evidence

Use these commands after migrations are applied and the API is reachable. Local
workstations can seed a deterministic OAuth client for evidence only:

```sh
pnpm --filter @helix/app db:seed:oauth
HELIX_BASE_URL=http://127.0.0.1:3000 helix login \
  --client-id helix-local-oauth-client \
  --client-secret helix-local-dev-secret \
  --scope "platform.read admin.users admin.audit admin.agents admin.config.write"
export HELIX_ACCESS_TOKEN=<token-from-helix-login>
```

Set `HELIX_TRACE_TOKEN=<stable-evidence-id>` before CLI evidence runs when the
admin/API/MCP calls need to correlate with OpenTelemetry traces. The CLI derives
a valid W3C `traceparent` for REST, OAuth form, and MCP requests from that token.
The live auth smoke harness uses the same environment variable for readiness,
OAuth token minting, REST, MCP tool catalog, and MCP resource catalog checks.

Capture admin, tier, and agent credential proof with a real bearer token, or use
the combined smoke script once the live stack is reachable:

```sh
HELIX_SMOKE_CLIENT_ID=helix-local-oauth-client \
HELIX_SMOKE_CLIENT_SECRET=helix-local-dev-secret \
HELIX_TRACE_TOKEN=prd-live-auth-smoke-2026-05-20 \
  pnpm quality:live-auth-smoke -- --base-url http://127.0.0.1:3000 --mutate
```

Add `--k6-target-smoke` to the same command when the web/API stack is running
and you want one evidence run to mint OAuth once, reuse that bearer token for
target-mode k6, and keep trace correlation aligned:

```sh
HELIX_SMOKE_CLIENT_ID=helix-local-oauth-client \
HELIX_SMOKE_CLIENT_SECRET=helix-local-dev-secret \
HELIX_TRACE_TOKEN=prd-live-auth-smoke-2026-05-21 \
  pnpm quality:live-auth-smoke -- \
    --base-url http://127.0.0.1:28431 \
    --k6-target-smoke \
    --k6-web-base-url http://127.0.0.1:4173
```

`--k6-api-base-url` defaults to the smoke script `--base-url`,
`--k6-scenario-groups` defaults to the short `api_smoke,mcp` proof set, and
`--k6-duration` defaults all k6 phase durations to `3s`. Broader PRD groups
such as `mail_api,search,assistant_llm` remain opt-in through
`--k6-scenario-groups` so missing deployment-specific routes are explicit.
When Dockerized k6 targets a host-run API, set
`HELIX_K6_DOCKER_WEB_BASE_URL` and `HELIX_K6_DOCKER_API_BASE_URL` to
`http://host.docker.internal:<port>`. The runner adds
`host.docker.internal:host-gateway` automatically only on Linux; set
`HELIX_K6_DOCKER_ADD_HOST_GATEWAY=true` to force it or `false` to preserve
Docker Desktop/Rancher Desktop's built-in macOS host routing.

Backup/restore REST evidence is opt-in because it calls admin operation routes,
and the backend returns dry-run command metadata by default without invoking the scripts unless
`HELIX_ADMIN_BACKUP_EXECUTE=true` is set on the API process. The smoke script
uses the deterministic backup id `helix-smoke-backup` and asserts both responses
return `status: "dry_run"`:

```sh
HELIX_SMOKE_CLIENT_ID=helix-local-oauth-client \
HELIX_SMOKE_CLIENT_SECRET=helix-local-dev-secret \
  pnpm quality:live-auth-smoke -- \
    --base-url http://127.0.0.1:3000 \
    --backup-restore \
    --search-reindex
```

Add `--backup-restore-encrypted` when the restore dry-run should target the
Tier 2+ age-encrypted archive shape, `<backup-id>.tar.gz.age`. The CLI
equivalent is `helix restore --from <backup-id> --encrypted`.

`POST /api/admin/backups` and `POST /api/admin/restores` require
`admin.config.write` or an admin config wildcard scope. Keep the smoke token
scope aligned with the default
`platform.read mail.read mail.send docs.read docs.write docs.comment
drive.read drive.write calendar.read calendar.write calendar.write:respond
calendar.read:freebusy chat.read chat.write meet.read meet.write
assistant.write assistant.memory admin.users admin.audit admin.agents
admin.webhooks admin.config.write`.
The `--search-reindex` check requires the API to be started with Meilisearch
configuration so `POST /api/admin/search/reindex` is registered; it asserts
`status: "completed"` with stale pruning disabled for smoke safety.
For local UI/API testing with deterministic seeded data, run
`pnpm --filter @helix/app db:prepare:demo -- --require-storage --require-search`
with `DATABASE_URL`, `RUSTFS_ENDPOINT`, and Meilisearch env set before starting
the app server.
Storage-less dev mode is metadata/editor-only. It can boot the app, but Drive
byte finalization, MCP byte reads, WebDAV byte round-trips, and Meet recording
uploads require resolved object storage. For BYO-storage hardening or
`--drive-docs-calendar-smoke`, start with `RUSTFS_ENDPOINT` or configure tenant
BYO storage plus its secret reader; missing storage is expected to fail closed.
For a complete backend-only local stack, `pnpm quality:live-demo-data -- --execute`
starts Postgres, Meilisearch, and RustFS on the contiguous high-port block
`39532`-`39535`, then runs that same prepare/verify path. The Quality Gates CI
workflow runs this smoke with `--volume-mail-count 25` and Compose cleanup. In
execute mode, the script preflights each requested high port before starting new
Compose services, while allowing already-running services from the same Compose
project to be reused.
Pass `--anchor-date <YYYY-MM-DD>` to `db:prepare:demo` or
`pnpm quality:live-demo-data` when demo mail, calendar, chat, and volume-mail
timestamps should be shifted near a specific test date while keeping stable IDs,
subjects, storage keys, and search assertions.
Add `--volume-search` to seed 10,000 deterministic Mail messages for realistic
global-search and mailbox-list testing, or pass `--volume-mail-count <n>` for a
smaller local run. The volume seed remains opt-in, stores rows in the same
Postgres Mail tables as normal demo mail, and is verified through Meilisearch by
`db:prepare:demo` when `--require-search` is present.
After the app server starts, add `--seeded-demo-tools` to the live smoke command
to assert those seeded mail, Chat, Docs, Drive, Calendar, global-search, and MCP
resources through authenticated runtime tool calls. The global-search checks
validate projected ids, types, titles, URLs, body snippets, and selected
attributes; the MCP checks read Mail, Drive, Docs, Calendar, and Chat resources.
After running `db:prepare:demo -- --volume-search --require-search`, add
`--seeded-volume-search-smoke` to assert the deterministic volume mailbox marker
through authenticated global `search.query` with volume ids, labels, and marker
metadata.

For a broad backend-only runtime pass after the app is running, use
`pnpm quality:live-auth-smoke -- --backend-realism-smoke`. That bundle enables
seeded demo checks, live Drive/Docs/Calendar mutations and search, SMTP/Mailpit,
events websocket, WebDAV, CalDAV, CardDAV, and target-mode k6. Add
`--assistant-provider-smoke` separately when the app has a non-local provider
configured with `ASSISTANT_AI_PROVIDER_ID` or AI routing; it verifies the
provider/model, surfaced AI provenance id, and provider-specific LLM metrics.
Add `--drive-docs-calendar-smoke` to mutate realistic workspace data through
the live backend: Drive upload/finalize with inline bytes and MCP byte read,
Docs create/update/comment/export and MCP read, and Calendar confirmation-gated
create/list/RSVP/freebusy plus MCP read. Add
`--drive-docs-calendar-search-smoke` when Meilisearch is configured to run an
admin reindex after those mutations and verify the created Drive, Docs, and
Calendar records through both POST and read-safe GET `search.query`. Add
`--drive-docs-calendar-event-search-smoke` when Meilisearch is configured to
skip the admin reindex and prove the outbox/event-indexing path for fresh Drive,
Docs, and Calendar records. Local single-process stacks use the in-memory event
bus when `NATS_URL` is absent; distributed release evidence should set
`NATS_URL`.
After building `@helix/cli`, add `--cli-checks` to the same smoke command to
prove the first-party CLI can log in, list OpenAPI/MCP tools, invoke
`platform.ping` over REST and MCP, read admin users/audit, and read seeded MCP
resources with the same token and trace settings.
For the local seeded actor, add `--pending-action-cli` to also create an
app-password pending confirmation, poll it with `helix action status`, cancel it
with `helix action cancel`, approve a second pending app-password creation with
`helix action approve`, then approve a pending revoke for cleanup.
Add `--events-ws` to validate authenticated `/events/ws` websocket delivery.
The smoke subscribes with the minted bearer token, triggers a real
`helix.config.changed` event through the live backend, and asserts the socket
receives that envelope before closing. A local single-process stack uses the
in-memory event bus when `NATS_URL` is not set; set `NATS_URL` for cross-process
fanout and distributed release evidence.
Add `--chat-realtime-smoke` to create a real chat room through
`chat.create_room`, connect two authenticated `/ws/chat` sockets, validate
presence/typing/message/read fanout, and poll `chat.search` for the persisted
message marker. Add `--mail-chat-search-smoke` with `--chat-realtime-smoke` or
`--mail-smtp-smoke` when Meilisearch is configured to reindex the fresh live
Mail/Chat records and verify them through global `search.query`.
Use `--mail-chat-event-search-smoke` instead when Meilisearch is configured; it
pairs with the same Chat or Mail smokes but skips `POST
/api/admin/search/reindex`, proving `activity.chat.*` and `activity.mail.*`
outbox-driven indexing through the configured event bus. Local single-process
stacks use the in-memory bus; distributed release evidence should set
`NATS_URL`.
Add `--meet-smoke` to create a live Meet room through `meet.create-room`, mint a
Jitsi JWT/join URL through `meet.mint-token`, reject an invalid `/webhook/jitsi`
secret, attach a recording artifact through the valid webhook path, verify the
artifact on active and ended `meet.room.list` results, and end the room through
`meet.end-room`. Override `HELIX_SMOKE_MEET_JITSI_DOMAIN`,
`HELIX_SMOKE_MEET_WEBHOOK_SECRET`, or `HELIX_SMOKE_MEET_ORG_ID` when the running
stack differs from the local compose defaults; `MEET_JITSI_WEBHOOK_SHARED_SECRET`
is also honored when exported in the smoke environment.
Add `--audit-runtime-smoke` to trigger real `app.passwords.list` and
`agent.credentials.list` tool calls, read the resulting `app.password.listed`
and `agent.credential.listed` rows back through `/api/admin/audit-log`, assert
hash-chain fields plus `HELIX_TRACE_TOKEN` correlation, and verify
`helix_audit_activity_total` plus
`helix_audit_hash_chain_last_verified_timestamp_seconds` on `/metrics`. Set
`HELIX_SMOKE_AUDIT_SHIPPING_METRICS=true` when immutable-S3 audit shipping is
enabled and the same smoke should also require backlog/lag metrics for
`immutable-s3`. If `HELIX_TRACE_TOKEN` is not set, the smoke generates a
deterministic-format token for this audit slice before it triggers the audited
tool calls.
Add `--assistant-smoke` to validate deterministic local Assistant runtime
coverage without external AI: conversation creation, `/draft`, `/summarize`,
`/find`, `/schedule`, `assistant.memory.forget` confirmation gating, and
assistant-native confirmation cancel/approve resume paths. The same check now
fetches `/metrics` and asserts `helix_llm_calls_total` plus
`helix_llm_latency_seconds_count` and `helix_llm_cost_usd_micros_total` for
`assistant.local`, `deterministic-assistant`, and `assistant.chat`.
Add `--mail-smtp-smoke` when the app is running with the in-process SMTP
receiver and outbound SMTP/NATS worker enabled. The smoke sends a local RFC822
message to `HELIX_SMOKE_SMTP_HOST:HELIX_SMOKE_SMTP_PORT`, polls `mail.search`,
queues and approves `mail.send` with `undoWindowMs: 0`, verifies Mailpit at
`HELIX_SMOKE_MAILPIT_URL`, then creates and approves a calendar event with
`sendInvitations: true` for `HELIX_SMOKE_CALENDAR_INVITE_RECIPIENT` and
verifies the outbound invite in Mailpit. The calendar invite recipient defaults
to a generated non-organizer `example.net` address so the backend queues a real
attendee invite. Compose defaults are Helix SMTP `127.0.0.1:28456` and Mailpit
`http://127.0.0.1:28458`.
Add `pnpm quality:mail-deliverability-smoke` only for approved external
deliverability evidence. It sends through the configured managed outbound email
provider path to a controlled recipient, approves the real `mail.send` pending
action, and records recipient domain, marker, pending id, persisted outbound
provider message id/metadata, timestamps, latency, and trace-correlatable
output. The smoke reads that controlled third-party recipient mailbox through
the recipient provider's IMAP endpoint. This is test infrastructure and does
not provide or imply a Helix-hosted IMAP server. Do not point this smoke at
Mailpit.

For the complete M7 local release flow, run
`pnpm quality:mail-live-evidence -- --local` after configuring two tenant
mailboxes, ClamAV, SpamAssassin, Mailpit, and a test-only signed provider webhook.
The machine-readable report distinguishes real local evidence from the
explicitly `not_run` provider-sandbox, Gmail, and Microsoft 365 checks. See
[`mail-live-evidence.md`](mail-live-evidence.md) for the required environment
and evidence-handling rules.

```sh
HELIX_BASE_URL=http://127.0.0.1:28431 \
HELIX_SMOKE_CLIENT_ID=helix-local-oauth-client \
HELIX_SMOKE_CLIENT_SECRET=helix-local-dev-secret \
HELIX_DELIVERABILITY_RECIPIENT=deliverability-probe@gmail.com \
HELIX_DELIVERABILITY_IMAP_HOST=imap.gmail.com \
HELIX_DELIVERABILITY_IMAP_USER=deliverability-probe@gmail.com \
HELIX_DELIVERABILITY_IMAP_PASSWORD=<app-password> \
  pnpm quality:mail-deliverability-smoke
```

Add `--webdav-smoke` to create and approve a scoped `webdav` app password for
the seeded actor, prove `/dav/files/*` Basic-auth challenge and authenticated
Drive byte round-trip through `PROPFIND`/`MKCOL`/`PUT`/`GET`/`DELETE`, prove
`LOCK`/`UNLOCK` token handling plus locked-write enforcement, revoke the app
password, and verify the revoked credential is rejected.
Add `--caldav-smoke` to create and approve a scoped `caldav` app password for
the seeded actor, prove `/dav/cal/*` Basic-auth challenge, advertised calendar
home default-calendar aliasing, VEVENT `PUT`/`GET`, `calendar-multiget`,
`calendar-query`, conditional update/delete, app-password revoke, and rejected
revoked credentials.
Add `--carddav-smoke` to create and approve a scoped `carddav` app password for
the seeded actor, prove `/dav/card/*` Basic-auth challenge, authenticated
addressbook discovery, self-card reads, vCard `PUT`/`GET`, `addressbook-multiget`,
`sync-collection`, conditional update/delete, app-password revoke, and rejected
revoked credentials.
Add `--webhook-smoke` to validate webhook admin CLI/runtime coverage without
external network delivery: disabled outbound create/list/delete, enabled
inbound create/list/rotate-secret/delete, invalid and valid generic HMAC
inbound posts, delivery record reads, and an outbound loopback delivery into the
local inbound receiver.
Add `--agent-limits-smoke` to prove agent/service-account throttling against a
live stack. Seed the dedicated smoke OAuth client first with
`pnpm --filter @helix/app db:seed:smoke-agent`, start the API with a
non-personal tier such as `HELIX_SECURITY_TIER=business`, set
`HELIX_AGENT_LIMIT_REQUESTS_PER_MINUTE=1` for deterministic local evidence, and
include `REDIS_URL` when proving Redis-backed cross-process counters. The smoke
expects a `429`, `Retry-After`, structured `rateLimit` metadata, and the
`helix_agent_tool_limiter_denials_total` Prometheus counter.

Static validation for the smoke harness does not need Docker or a live API:

```sh
pnpm quality:live-auth-smoke -- --static
```

For individual command evidence:

```sh
HELIX_BASE_URL=http://127.0.0.1:3000 helix admin users list --limit 25
HELIX_BASE_URL=http://127.0.0.1:3000 helix admin audit list --limit 25
HELIX_BASE_URL=http://127.0.0.1:3000 helix tier set personal
HELIX_TRACE_TOKEN=admin-evidence-$(date +%Y%m%d) \
  HELIX_BASE_URL=http://127.0.0.1:3000 helix tool list --source mcp
HELIX_BASE_URL=http://127.0.0.1:3000 helix admin agent-credentials list --include-revoked
HELIX_BASE_URL=http://127.0.0.1:3000 helix admin agent-credentials create \
  --actor-id <agent-actor-id> \
  --scope platform.read \
  --scope admin.audit
HELIX_BASE_URL=http://127.0.0.1:3000 helix admin agent-credentials revoke --client-id <created-client-id>
HELIX_BASE_URL=http://127.0.0.1:3000 helix admin audit list --verb agent.credentials.created --limit 10
HELIX_BASE_URL=http://127.0.0.1:3000 helix admin app-passwords list --include-revoked
HELIX_BASE_URL=http://127.0.0.1:3000 helix action status <pending-action-id>
HELIX_BASE_URL=http://127.0.0.1:3000 helix backup create
HELIX_BASE_URL=http://127.0.0.1:3000 helix restore --from helix-smoke-backup
HELIX_BASE_URL=http://127.0.0.1:3000 helix reindex --all
```

Release evidence should include command output, the actor id used, whether a
pending-tool approval was required for create/revoke, and matching audit rows.
Do not use `helix-local-dev-secret` outside local development evidence.

## k6 PRD Scenario Evidence Contract

For every target-mode release run, record the scenario group, whether it ran or
was skipped, base URLs, auth mode, observed p95, threshold, blocker, owner, and
next command for any skip or failure.

| Scenario group   | Trend and threshold                                                  | Target-mode env overrides                                                                                                                                                                                                                      | Skip/blocker guidance                                                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mail_api`       | `helix_mail_api_ms`, `MAIL_API_P95_MS`                               | `MAIL_API_TOOL_ID`, `MAIL_API_BODY`, `MAIL_API_QUERY`, `MAIL_API_EXPECT`                                                                                                                                                                       | Protected; provide `AUTH_TOKEN` or record the blocker, owner, and next command: `AUTH_TOKEN=<token> K6_SCENARIO_GROUPS=mail_api pnpm quality:k6:target`.                                                                                                                    |
| `inbound_mail`   | `helix_inbound_mail_searchable_ms`, `INBOUND_MAIL_SEARCHABLE_P95_MS` | `INBOUND_MAIL_ACCEPT_PATH`, `INBOUND_MAIL_BODY`, `INBOUND_MAIL_MARKER`, `INBOUND_MAIL_FROM`, `INBOUND_MAIL_TO`, `INBOUND_MAIL_SEARCH_TOOL_ID`, `INBOUND_MAIL_SEARCH_BODY`, `INBOUND_MAIL_SEARCH_TIMEOUT_MS`, `INBOUND_MAIL_SEARCH_INTERVAL_MS` | Protected; configure auth plus the local actor recipient or signed provider bridge, or record the blocker, owner, and next command: `AUTH_TOKEN=<token> K6_SCENARIO_GROUPS=inbound_mail pnpm quality:k6:target`.                                                            |
| `search`         | `helix_search_query_ms`, `SEARCH_P95_MS`                             | `SEARCH_TOOL_IDS`, `SEARCH_BODY`, `SEARCH_QUERY`, `SEARCH_EXPECT`                                                                                                                                                                              | Protected; seed searchable data and auth or record the blocker, owner, and next command: `AUTH_TOKEN=<token> K6_SCENARIO_GROUPS=search pnpm quality:k6:target`.                                                                                                             |
| `chat`           | `helix_chat_delivery_ms`, `CHAT_DELIVERY_P95_MS`                     | `CHAT_TOOL_ID`, `CHAT_BODY`, `CHAT_QUERY`, `CHAT_EXPECT`                                                                                                                                                                                       | Protected; seed chat data and auth or record the blocker, owner, and next command: `AUTH_TOKEN=<token> K6_SCENARIO_GROUPS=chat pnpm quality:k6:target`.                                                                                                                     |
| `docs`           | `helix_docs_collaboration_ms`, `DOCS_COLLABORATION_P95_MS`           | `DOCS_CREATE_TOOL_ID`, `DOCS_CREATE_BODY`, `DOCS_EXPORT_TOOL_ID`, `DOCS_EXPORT_BODY`, `DOCS_DOC_ID`, `DOCS_EXPECT`                                                                                                                             | Protected; create/export a backend Docs document with auth or record the blocker, owner, and next command: `AUTH_TOKEN=<token> K6_SCENARIO_GROUPS=docs pnpm quality:k6:target`.                                                                                             |
| `meet_jitsi`     | `helix_jitsi_join_ms`, `JITSI_JOIN_P95_MS`                           | `MEET_CREATE_TOOL_ID`, `MEET_CREATE_BODY`, `MEET_MINT_TOOL_ID`, `MEET_MINT_BODY`, `MEET_END_TOOL_ID`, `MEET_ROOM_ID`, `MEET_JITSI_DOMAIN`, `MEET_EXPECT`, `MEET_END_AFTER_MINT`                                                                | Protected; create a backend Meet room and mint a Jitsi join token with auth or record the blocker, owner, and next command: `AUTH_TOKEN=<token> K6_SCENARIO_GROUPS=meet_jitsi pnpm quality:k6:target`.                                                                      |
| `plugin_install` | `helix_plugin_install_ms`, `PLUGIN_INSTALL_P95_MS`                   | `PLUGIN_INSTALL_TOOL_ID`, `PLUGIN_INSTALL_BODY`, `PLUGIN_INSTALL_EXPECT`, `PLUGIN_INSTALL_PLUGIN_ID`, `PLUGIN_INSTALL_VERSION`, `PLUGIN_INSTALL_SOURCE`, `PLUGIN_INSTALL_REGISTRY_URL`                                                         | Protected/admin; use release plugin metadata or record the blocker, owner, and next command: `AUTH_TOKEN=<token> K6_SCENARIO_GROUPS=plugin_install pnpm quality:k6:target`.                                                                                                 |
| `assistant_llm`  | `helix_llm_routing_overhead_ms`, `LLM_ROUTING_P95_MS`                | `ASSISTANT_TOOL_ID`, `ASSISTANT_BODY`, `ASSISTANT_MESSAGE`                                                                                                                                                                                     | Protected; configure provider-safe prompt/body or record the blocker, owner, and next command: `AUTH_TOKEN=<token> K6_SCENARIO_GROUPS=assistant_llm pnpm quality:k6:target`. Pair release provider proof with `pnpm quality:live-auth-smoke -- --assistant-provider-smoke`. |
| `mcp`            | `helix_mcp_catalog_ms`, `MCP_CATALOG_P95_MS`                         | `MCP_PATH`, `MCP_EXPECT`                                                                                                                                                                                                                       | Protected; expose the MCP catalog endpoint with auth or record the blocker, owner, and next command: `AUTH_TOKEN=<token> K6_SCENARIO_GROUPS=mcp pnpm quality:k6:target`.                                                                                                    |
| `otel_health`    | `helix_otel_trace_ingestion_lag_ms`, `OTEL_INGESTION_LAG_P95_MS`     | `OTEL_HEALTH_PATH`                                                                                                                                                                                                                             | Health/metrics evidence can run without auth; if observability is not deployed, record the blocker, owner, and next command: `K6_SCENARIO_GROUPS=otel_health pnpm quality:k6:target`.                                                                                       |

Outbound mail send-to-delivered remains live-provider evidence unless
`pnpm quality:mail-deliverability-smoke` has passed against an approved external
SMTP/provider target and controlled recipient mailbox. Do not claim
deliverability from Mailpit, static validation, or mocked k6 runs; record the
SMTP/provider blocker, owner, next command, and required recipient/provider
setup until real mailbox proof is attached.

## Signup SLO Paging

The local observability stack uses
`infra/observability/alertmanager/alertmanager.yml` for Docker smoke evidence.
Production deployments should use
`infra/observability/alertmanager/alertmanager.production.yml`, which keeps the
local signup SLO webhook receiver and fans the same
`service="signup", slo="signup_activation"` alerts out to
`helix-signup-slo-paging`.

Mount the external paging webhook URL from your secret manager at:

```text
/etc/alertmanager/secrets/signup-slo-paging-webhook-url
```

The file should contain the PagerDuty/Opsgenie/BetterStack-compatible webhook
bridge URL for the signup activation SLO escalation. Do not commit the URL or
API token. Static proof that the route and secret-file contract are present:

```sh
pnpm quality:alertmanager-signup-routing -- --static
```

Local route delivery proof remains:

```sh
pnpm quality:alertmanager-signup-routing
```

## Workspace incident operations

The provisioned `Helix Workspace Operations` dashboard covers the production
signals for HTTP, auth, dependencies, workers, Mail, Drive, Chat, agents, audit,
and recovery. The metric and safe-label contract is documented in
[Workspace observability](observability.md).

When an alert fires, page the owning service operator, open the alert's linked
runbook, and use only its opaque `resource_id` and `trace_query` to correlate
evidence. Do not copy user content or secrets into the incident record. The
[incident runbook index](RUNBOOK.md#workspace-incident-runbooks) lists all
supported failure procedures.

## Release Hold Criteria

Hold release when:

- strict accessibility audit has untriaged violations
- mobile review finds clipped navigation or primary actions
- dark mode loses contrast on primary workflows
- reduced-motion review finds required motion
- k6 reports server errors above threshold
- k6 target-mode skips or failures lack a blocker, owner, and next command
- plugin author or troubleshooting docs are stale for changed behavior
