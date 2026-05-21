# Troubleshooting

Phase 9 documentation pass for TASK-A10.

## Docker/Rancher Desktop Socket Unavailable

Symptoms:

- `docker info` reports `failed to connect to the docker API at unix:///Users/mj/.rd/docker.sock`
- compose config commands can render, but live `docker compose up` evidence cannot start

Current workstation status recorded on 2026-05-20:

- active Docker context: `rancher-desktop`
- missing socket: `/Users/mj/.rd/docker.sock`
- high-port preflight: `lsof -nP -iTCP:28431-28458 -sTCP:LISTEN` returned no TCP listeners

Once Rancher Desktop/Docker is running, rerun the live-stack commands in this order:

```sh
docker info
docker compose --profile meet --profile observability --profile drive-preview config
lsof -nP -iTCP:28431-28458 -sTCP:LISTEN
docker compose pull
docker compose build postgres drive-preview-libreoffice
docker compose up -d
pnpm --filter @helix/app db:seed:oauth
docker compose ps
```

The full optional profile port block should stay contiguous from `28431` through `28458`.

If runtime evidence is blocked by Docker, record the blocker instead of replacing
it with mocked proof:

```text
docker blocker:
  command: docker info
  blocker: Docker/Rancher Desktop socket unavailable at /Users/mj/.rd/docker.sock
  high-port preflight: lsof -nP -iTCP:28431-28458 -sTCP:LISTEN
  next command: docker compose --profile meet --profile observability --profile drive-preview config && docker compose up -d
```

Do not change the compose port range unless all optional profile ports remain
contiguous and the preflight shows no local listeners in `28431`-`28458`.

## Accessibility Audit Cannot Reach Preview

Symptoms:

- `fetch failed`
- connection refused for `http://127.0.0.1:4173`

Fix:

```sh
pnpm --filter @helix/web build
pnpm --filter @helix/web preview
HELIX_WEB_BASE_URL=http://127.0.0.1:4173 pnpm quality:a11y
```

Use `pnpm quality:a11y:fallback` only to record a manual fallback when browser execution is unavailable.

## Playwright Browser Missing

Symptoms:

- Playwright launches fail because the browser executable is missing.

Fix:

```sh
pnpm --filter @helix/web exec playwright install chromium
pnpm quality:a11y
```

## k6 Is Not Installed

Symptoms:

- `k6: command not found`

Fix:

- install k6 with the package manager approved for the environment
- rerun `pnpm quality:k6`
- or run `infra/scripts/validate-k6.sh --runner docker` to validate the k6 scenario through Dockerized k6 and mock targets
- or run `infra/scripts/validate-k6.sh --static` for syntax/static validation when no k6 runner is available

The scenario file is `infra/k6/helix-quality-gates.js`.

When k6 is launched through `pnpm quality:live-auth-smoke -- --k6-target-smoke`,
the same runner and Docker networking rules apply. The smoke script mints the
OAuth token and passes it to `infra/scripts/validate-k6.sh --no-mock`; keep
`HELIX_K6_DOCKER_WEB_BASE_URL`, `HELIX_K6_DOCKER_API_BASE_URL`, and
`HELIX_K6_DOCKER_NETWORK` on the command when the selected k6 runner is Docker.
`HELIX_K6_DOCKER_ADD_HOST_GATEWAY` defaults to `auto`: Linux runners add
`host.docker.internal:host-gateway`, while macOS keeps Docker Desktop/Rancher
Desktop's built-in `host.docker.internal` routing.

## Dockerized k6 Cannot Reach Localhost API

Symptoms:

- `HELIX_K6_RUNNER=docker pnpm quality:k6:target` cannot reach `API_BASE_URL=http://127.0.0.1:<port>`
- Dockerized k6 reports connection refused while the host can curl the same API URL

By default, `127.0.0.1` inside the k6 container is the container loopback, not
the host loopback. Prefer explicit Docker-only base URLs so local k6, CI, and
release target evidence keep using the normal `WEB_BASE_URL` and `API_BASE_URL`
values:

```sh
WEB_BASE_URL=http://127.0.0.1:4173 \
API_BASE_URL=http://127.0.0.1:3000 \
HELIX_K6_DOCKER_WEB_BASE_URL=http://host.docker.internal:4173 \
HELIX_K6_DOCKER_API_BASE_URL=http://host.docker.internal:3000 \
HELIX_K6_RUNNER=docker \
pnpm quality:k6:target
```

On Linux hosts where Docker host networking is approved, use host networking:

```sh
WEB_BASE_URL=http://127.0.0.1:4173 \
API_BASE_URL=http://127.0.0.1:3000 \
HELIX_K6_DOCKER_NETWORK=host \
HELIX_K6_RUNNER=docker \
pnpm quality:k6:target
```

Do not use mocked k6 output as target-mode release evidence when the live host
API is unreachable. Record the blocker using the target-mode blocker format
below.

If `host.docker.internal:<api-port>` still resolves to a gateway address but
returns connection refused, confirm whether the API is bound only to
`127.0.0.1`. In that case, run local k6 on the host or restart the API on an
address reachable from the Docker network before collecting target-mode
evidence.

On macOS, if Dockerized k6 resolves `host.docker.internal` to a Linux bridge
gateway such as `172.17.0.1` and cannot reach a host-run Helix API, make sure
`HELIX_K6_DOCKER_ADD_HOST_GATEWAY=false` is set so Docker's platform-provided
host alias is not overridden.

## k6 API Targets Return 401

If the API requires authentication, pass a bearer token:

```sh
AUTH_TOKEN=<token> pnpm quality:k6:target
```

For local-only evidence runs after migrations are applied, seed a deterministic OAuth client and mint a real bearer token:

```sh
pnpm --filter @helix/app db:seed:oauth
HELIX_BASE_URL=http://127.0.0.1:3000 helix login \
  --client-id helix-local-oauth-client \
  --client-secret helix-local-dev-secret \
  --scope platform.read
```

The `helix login` output includes the OAuth JSON response and an `export HELIX_ACCESS_TOKEN=...` line for the current shell. It does not persist the client secret or token.

If live CLI evidence needs trace correlation, set
`HELIX_TRACE_TOKEN=<stable-evidence-id>` before `helix login`, REST-backed admin
commands, or MCP-backed tool commands. The CLI sends a valid W3C `traceparent`
on OAuth form, REST, and MCP requests whenever that variable is present.

Override the local seed secret with `HELIX_SEED_CLIENT_SECRET`. Do not use the default local secret outside local development evidence.

For browser smoke, open `/login` and use the same seeded client id, client secret, and scopes. The web app stores the returned bearer token in local storage for API requests and websocket URLs.

For live admin and agent credential evidence, mint the token with the admin
scopes required by the command under test:

```sh
HELIX_BASE_URL=http://127.0.0.1:3000 helix login \
  --client-id helix-local-oauth-client \
  --client-secret helix-local-dev-secret \
  --scope "platform.read admin.users admin.audit admin.agents admin.config.write"
export HELIX_ACCESS_TOKEN=<token-from-helix-login>
helix admin users list --limit 25
helix admin audit list --limit 25
helix tier set business
HELIX_TRACE_TOKEN=admin-evidence helix tool list --source mcp
helix admin agent-credentials list --include-revoked
helix admin app-passwords list --include-revoked
helix action status <pending-action-id>
```

The same evidence path can be collected in one pass with:

```sh
HELIX_SMOKE_CLIENT_ID=helix-local-oauth-client \
HELIX_SMOKE_CLIENT_SECRET=helix-local-dev-secret \
HELIX_TRACE_TOKEN=prd-live-auth-smoke-2026-05-20 \
  pnpm quality:live-auth-smoke -- --base-url http://127.0.0.1:3000 --mutate
```

`HELIX_TRACE_TOKEN` is optional, but setting it makes the smoke script attach a
W3C `traceparent` header to readiness, OAuth token minting, REST, and MCP
tool/resource requests for trace-correlated evidence.

To include backup/restore REST route evidence, keep the token scoped with
`admin.config.write` and opt in to the dry-run calls:

```sh
HELIX_SMOKE_CLIENT_ID=helix-local-oauth-client \
HELIX_SMOKE_CLIENT_SECRET=helix-local-dev-secret \
  pnpm quality:live-auth-smoke -- --base-url http://127.0.0.1:3000 --backup-restore --search-reindex
```

The smoke script sends `backupId: "helix-smoke-backup"` to
`POST /api/admin/backups` and `POST /api/admin/restores` and expects
`status: "dry_run"` from each response. If either call returns `403`, mint the
token with `admin.config.write`; if either call reports `completed`, verify the
API process was not started with `HELIX_ADMIN_BACKUP_EXECUTE=true`.
Use `--backup-restore-encrypted` to make the restore dry-run target the
encrypted `<backup-id>.tar.gz.age` archive path; CLI operators can use
`helix restore --from <backup-id> --encrypted` for the same REST payload.
With `--search-reindex`, the same smoke run also posts to
`/api/admin/search/reindex` and expects `status: "completed"`. If that route is
missing, restart the API with Meilisearch configured.
With `--seeded-demo-tools`, the smoke run also reads the deterministic local
demo corpus through `/api/tools/...` and `/mcp` resources, including seeded
Mail, Chat, Docs, Drive, Calendar, and global search records. Search failures
now point at projection shape drift as well as missing ids because the smoke
checks hit ids, titles, URLs, snippets, and selected attributes. Run
`pnpm --filter @helix/app db:prepare:demo -- --require-storage --require-search`
first and mint the token with `platform.read mail.read drive.read docs.read
calendar.read chat.read assistant.write assistant.memory admin.users admin.audit
admin.agents admin.webhooks admin.config.write`.
With `--seeded-volume-search-smoke`, the smoke run asserts opt-in high-volume
demo Mail through global `search.query`. Run
`pnpm --filter @helix/app db:prepare:demo -- --volume-search --require-search`
first, or use `--volume-mail-count <n>` for a smaller local proof. If the smoke
cannot find `helix-volume-mail-search`, confirm Meilisearch is configured, the
prepare command completed its scoped reindex, and the API token includes
`platform.read` plus `mail.read`.
With `--agent-limits-smoke`, the smoke run mints a second OAuth token for a
dedicated agent actor and expects `platform.ping` to return `429` once the
per-minute budget is consumed. Run
`pnpm --filter @helix/app db:seed:smoke-agent` first, start the API with a
non-personal tier such as `HELIX_SECURITY_TIER=business`, use
`HELIX_AGENT_LIMIT_REQUESTS_PER_MINUTE=1` for deterministic local proof, and set
`REDIS_URL` when validating Redis-backed counters. If the response is not `429`,
confirm the seeded actor type is `agent` or `service_account`; if metrics fail,
check `/metrics` for `helix_agent_tool_limiter_denials_total`.
With `--drive-docs-calendar-smoke`, the smoke run creates live workspace data:
a Drive text object with `contentBase64` finalized into object storage and read
back through MCP, a Docs document with title update/comment/export/MCP read, and
a Calendar event that goes through pending approval, list, RSVP, free/busy, and
MCP read. Mint the token with `drive.write`, `docs.write`, `docs.comment`,
`calendar.write`, `calendar.write:respond`, and `calendar.read:freebusy`. If the
Drive MCP byte read fails, check that the app was started with `RUSTFS_ENDPOINT`;
if Calendar create returns `403`, reseed the local OAuth client.
With `--drive-docs-calendar-search-smoke`, the same live data smoke also runs
`POST /api/admin/search/reindex` and verifies each created Drive, Docs, and
Calendar record through POST and read-safe GET `search.query`. If a unified
search check times out, verify Meilisearch is configured and the admin reindex
route returns `status: "completed"`. Automatic event indexing uses the
configured event bus: local single-process stacks use the in-memory bus when
`NATS_URL` is absent, while distributed release evidence should set `NATS_URL`.
With `--drive-docs-calendar-event-search-smoke`, the same mutation/search path
skips `POST /api/admin/search/reindex` and relies on outbox delivery through
the event bus into the search event indexer. If it times out, inspect
`outbox.delivered_at` and `outbox.last_error` for `activity.drive.*`,
`activity.docs.*`, and `activity.calendar.*` rows. On NATS-backed stacks, also
check NATS monitor `/connz?subs=1` for a `helix.>` subscription.
With `--cli-checks`, the smoke run also shells through the built `helix` CLI
against the same API, bearer token, and trace token. If it fails with a missing
CLI bundle, run `pnpm --filter @helix/cli build` first or pass `--cli-bin` with
the executable path.
With `--pending-action-cli`, the smoke run creates an app-password pending
confirmation for the seeded actor, then verifies `helix action status` and
`helix action cancel`. It also creates a second app-password pending action,
approves it through `helix action approve`, and approves a pending revoke for
cleanup. For non-demo stacks, set `HELIX_SMOKE_PENDING_ACTOR_ID` to an actor id
in the authenticated org.
With `--events-ws`, the smoke run opens `/events/ws` with the minted bearer token
as `access_token`, triggers a backend `helix.config.changed` event, and waits
for that envelope on the socket. Local stacks without NATS use the in-memory
event bus, so the proof should include both authenticated subscribe and message
delivery before the smoke closes the socket. A `1013` `Event bus unavailable`
close means the app did not register an event bus; `1008` or a connection error
indicates auth, subject, or route failure. A delivery timeout means the config
mutation, subject filtering, or event bus fanout path regressed; confirm the
token includes `admin.config.write` and check NATS subscriptions when `NATS_URL`
is set.
With `--chat-realtime-smoke`, the smoke run creates a room through
`chat.create_room`, opens two authenticated `/ws/chat` sockets, and expects
typing, message, and read-receipt fanout plus a searchable persisted marker. A
timeout usually means websocket auth, room membership, or the chat realtime bus
regressed; a `chat.search` timeout means persistence/search visibility regressed.
With `--mail-chat-search-smoke`, the Mail or Chat smoke also runs an admin
search reindex after the live mutation and asserts the fresh marker through
global `search.query`. Use it only when Meilisearch and the admin reindex route
are configured.
With `--mail-chat-event-search-smoke`, the same Mail or Chat global search
assertions run without admin reindex. Use it only when Meilisearch and the event
bus are enabled; local single-process stacks use the in-memory bus, while
distributed release evidence should set `NATS_URL`. If it times out, check the
`outbox` rows for `activity.mail.*` and `activity.chat.*`; `delivered_at` should
be set and `last_error` should stay empty. On NATS-backed stacks, also check NATS
connectivity/subscriptions.
With `--meet-smoke`, the smoke run creates a Meet room, mints a Jitsi JWT, checks
invalid and valid `/webhook/jitsi` recording delivery, verifies the recording
artifact on room lists, and ends the room. Failures usually point to missing
`meet.read`/`meet.write` token scopes, a `HELIX_SMOKE_MEET_WEBHOOK_SECRET` /
`MEET_JITSI_WEBHOOK_SHARED_SECRET` mismatch, the wrong default org id, missing
Meet migrations, or a recording artifact/object-store attach regression.
With `--audit-runtime-smoke`, the smoke run verifies live Postgres audit rows
for `app.password.listed` and `agent.credential.listed`, hash-chain field shape,
`HELIX_TRACE_TOKEN` correlation, and audit Prometheus metrics. If
`HELIX_TRACE_TOKEN` is unset, the smoke generates one before triggering the
audited calls. Failures usually mean the token is missing `admin.users`, `admin.agents`, or
`admin.audit`, the audit sink is not wired into the tool registry, the verifier
worker is disabled or has not reported metrics, or immutable-S3 shipping metrics
were required without `AUDIT_IMMUTABLE_S3_*` runtime configuration.
With `--assistant-smoke`, the smoke run uses the built-in deterministic
`assistant.local` provider to validate assistant conversation creation, the four
default slash commands, and `assistant.memory.forget` pending-confirmation
gating through assistant-native cancel and approve resume tools. This path does
not require Ollama or an external LLM key.
With `--mail-smtp-smoke`, the smoke run expects a live SMTP receiver and
outbound SMTP sink. Compose publishes the app receiver at `28456` and Mailpit at
`28458`; local host-run apps must set `MAIL_SMTP_RECEIVER_ENABLED=true`,
`MAIL_SMTP_RECEIVER_PORT=28456`, `MAIL_SMTP_HOST=127.0.0.1`,
`MAIL_SMTP_PORT=28457`, `NATS_URL`, and
`HELIX_DEFAULT_ORG_ID=00000000-0000-4000-8000-000000000100` for actor-visible
inbound mail and outbound worker delivery.
The Mailpit smoke only validates local backend receive/send plumbing. For
external deliverability failures, use `pnpm quality:mail-deliverability-smoke`
with approved provider credentials and controlled recipient mailboxes; check
provider auth, DNS/SPF/DKIM/DMARC alignment, the persisted provider message
id/metadata when available, suppression lists, sandbox mode, rate limits, and
recipient spam/quarantine state.
With `--webdav-smoke`, the smoke run creates and approves a temporary `webdav`
app password, uses it against `/dav/files/*`, uploads and downloads a text file,
locks the file, verifies locked writes fail until the `Lock-Token` is supplied,
unlocks it, deletes the temporary resources, revokes the app password, and
verifies the revoked credential returns `401`. Failures usually mean
app-password pending approval, Basic auth, Drive object storage, path
resolution, lock token issuance, `If` header validation, unlock cleanup, or
revoke handling regressed.
With `--caldav-smoke`, the smoke run creates and approves a temporary `caldav`
app password, uses it against `/dav/cal/*`, creates and reads a VEVENT, checks
`calendar-multiget` plus `calendar-query`, updates and deletes with current
ETags, revokes the app password, and verifies the revoked credential returns
`401`. Failures usually mean app-password pending approval, Basic auth, CalDAV
route registration, default calendar creation/access, malformed href handling,
or ETag preconditions regressed.
With `--carddav-smoke`, the smoke run creates and approves a temporary
`carddav` app password, uses it against `/dav/card/*`, creates and reads a vCard,
checks `addressbook-multiget` plus `sync-collection` deltas, deletes the contact,
revokes the app password, and verifies the revoked credential returns `401`.
Failures usually mean app-password pending approval, Basic auth, CardDAV route
registration, contact-store migrations, ETag preconditions, or sync-token
handling regressed.
With `--webhook-smoke`, the smoke run uses the built `helix` CLI to create
webhook records, list them, rotate the inbound secret, list deliveries, and
delete the records. It also posts invalid and valid generic HMAC payloads to the
local `/webhooks/<slug>` receiver and fires an outbound webhook back into that
receiver, so failures in this slice usually mean the inbound secret, signature,
loopback URL, pending-action approval, or delivery persistence path regressed.

When no live stack is available, validate the smoke harness syntax only:

```sh
pnpm quality:live-auth-smoke -- --static
```

Protected PRD scenario groups are skipped by default when `AUTH_TOKEN` is not
set. To force them and fail on unauthorized responses, set:

```sh
SKIP_PROTECTED_WITHOUT_AUTH=false AUTH_TOKEN=<token> pnpm quality:k6:target
```

If a target is not part of the deployment, override the route or scenario list:

```sh
API_TARGETS=/healthz,/metrics K6_SCENARIO_GROUPS=web_navigation,api_smoke,otel_health pnpm quality:k6:target
```

## k6 Target-Mode Blocker Reporting

When target-mode k6 cannot run every PRD scenario group, do not replace it with
mocked evidence. Record the skipped `K6_SCENARIO_GROUPS`, the blocker, owner,
next command, observed p95 if the scenario partially ran, and threshold.

Use this shape in release evidence:

```text
k6 target-mode blocker:
  skipped K6_SCENARIO_GROUPS: inbound_mail,plugin_install
  blocker: inbound webhook secret and signed plugin bundle unavailable
  owner: platform-oncall
  next command: AUTH_TOKEN=<token> K6_SCENARIO_GROUPS=inbound_mail,plugin_install pnpm quality:k6:target
  observed p95: not measured
  threshold: INBOUND_MAIL_SEARCHABLE_P95_MS=5000, PLUGIN_INSTALL_P95_MS=30000
```

If the deployment intentionally omits a surface, keep the reduced
`K6_SCENARIO_GROUPS` command with the release artifact and name the product or
environment decision that made the full target-mode run inapplicable.

For trace-correlated target-mode evidence, set `K6_TRACE_TOKEN` or
`HELIX_TRACE_TOKEN` to the release evidence id. The k6 script converts it into a
W3C `traceparent` header for web, API, tool, and MCP requests.

## k6 Inbound Mail Probe Does Not Become Searchable

Symptoms:

- `inbound mail accept endpoint accepted probe` fails
- `inbound mail probe became searchable` fails
- `helix_inbound_mail_searchable_ms` breaches the 5000ms p95 threshold

Fix:

- verify `AUTH_TOKEN` has the scopes required by the inbound mail bridge and `mail.search`
- use the default `INBOUND_MAIL_ACCEPT_PATH=/api/tools/mail.inbound.accept` for local/backend evidence, or set `INBOUND_MAIL_ACCEPT_PATH=/webhooks/<mail-ingest-slug>` for a deployment-specific signed bridge
- set `INBOUND_MAIL_TO` to a mailbox mapped to the authenticated actor, for example `local-admin@helix.local`
- set `INBOUND_MAIL_BODY` when the deployment expects a provider-specific payload or signature metadata
- set `INBOUND_MAIL_SEARCH_BODY` when the mail search tool needs labels, tenant filters, or a different query shape
- keep `INBOUND_MAIL_MARKER` unique per release evidence run so stale indexed mail cannot satisfy the probe

Use `K6_SCENARIO_GROUPS=inbound_mail` for a focused rerun after fixing the route,
auth, or indexing pipeline.

## External Mail Deliverability Smoke Fails

Symptoms:

- provider accepts SMTP but no mailbox receipt is observed
- provider rejects authentication, sender, recipient, or TLS
- message lands in spam/quarantine or is suppressed

Fix:

- confirm the smoke is not using Mailpit and is pointed at the approved external provider
- verify `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_SECURE`, `MAIL_SMTP_USER`, `MAIL_SMTP_PASS`, and sender address
- verify SPF, DKIM, and DMARC alignment for the sender domain
- check provider sandbox/suppression/rate-limit logs and compare the persisted provider message id/metadata when available
- keep the smoke recipient controlled and use a unique marker per run so stale mailbox state cannot satisfy the proof

## Route Review Finds Mobile Overflow

Check the route at 390px width. Common causes are fixed-width panels, non-wrapping labels, long badges, and nested grids without `min-width: 0`.

Record the failing route, viewport, theme, and screenshot in the release evidence.
