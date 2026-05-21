# Tier 1 Compose Checklist

Scope: TASK-121 Phase 0 readiness for the Tier 1 Docker Compose stack. This checklist covers compose wiring only; it does not replace app tests, migrations, or broad repo validation.

## Services

Default Tier 1 starts these services without a profile:

| Service       | Purpose                                                        | Published port            |
| ------------- | -------------------------------------------------------------- | ------------------------- |
| `helix`       | Helix app, API, MCP, OpenAPI, AsyncAPI, webhooks, SMTP receive | `28431`, `28456`          |
| `postgres`    | Primary data store with pgvector                               | `28432`                   |
| `redis`       | Sessions, rate limits, ephemeral state                         | `28433`                   |
| `nats`        | JetStream event bus                                            | `28434`, `28435`          |
| `meilisearch` | Keyword search index                                           | `28436`                   |
| `rustfs`      | S3-compatible object storage                                   | `28437`, `28438`          |
| `cerbos`      | Policy decision point                                          | `28439`, `28440`          |
| `caddy`       | Edge proxy and local TLS entrypoint                            | `28441`, `28442`, `28443` |
| `mailpit`     | Local outbound SMTP sink and message web UI                    | `28457`, `28458`          |

Optional observability profile:

| Service          | Purpose                                | Published port   |
| ---------------- | -------------------------------------- | ---------------- |
| `otel-collector` | OTLP trace receiver and Tempo exporter | `28444`, `28445` |
| `prometheus`     | Metrics store                          | `28446`          |
| `tempo`          | Trace store                            | `28447`          |
| `loki`           | Log store endpoint                     | `28448`          |
| `grafana`        | Dashboards                             | `28449`          |

Optional Drive preview profile:

| Service                     | Purpose                          | Published port |
| --------------------------- | -------------------------------- | -------------- |
| `drive-preview-libreoffice` | Office-to-PDF preview conversion | `28450`        |

Optional Meet profile:

| Service         | Purpose                  | Published port   |
| --------------- | ------------------------ | ---------------- |
| `jitsi-web`     | Jitsi Meet web frontend  | `28451`, `28452` |
| `jitsi-jvb`     | Jitsi video bridge media | `28453`          |
| `jitsi-prosody` | Jitsi XMPP/BOSH service  | `28454`, `28455` |
| `jitsi-jicofo`  | Jitsi conference focus   | none             |

## High-Port Block

Default published ports are contiguous high ports from `28431` through `28458` when all optional
Tier 1 profiles are enabled.

- Base Tier 1: `28431`-`28443`
- Observability profile: `28444`-`28449`
- Drive preview profile: `28450`
- Meet profile: `28451`-`28455`
- Local mail: `28456`-`28458`
- `28442` is intentionally published for both TCP and UDP HTTPS on Caddy.
- If overriding ports with environment variables, keep add-on services contiguous so local firewall and VPS runbook rules stay simple.
- Runtime evidence should include the resolved published port list from `docker compose config`
  and `docker compose --profile meet --profile observability --profile drive-preview config`. The
  expected full set is:
  `28431 28432 28433 28434 28435 28436 28437 28438 28439 28440 28441 28442 28443 28444 28445 28446 28447 28448 28449 28450 28451 28452 28453 28454 28455 28456 28457 28458`.

## Local Mail

The Helix app starts the in-process SMTP receiver when `MAIL_SMTP_RECEIVER_ENABLED=true`.
Compose exposes it on `localhost:${HELIX_SMTP_RECEIVE_PORT:-28456}` and binds the in-container
receiver to `0.0.0.0:${MAIL_SMTP_RECEIVER_PORT:-2525}`. Outbound mail uses `MAIL_SMTP_HOST`
and `MAIL_SMTP_PORT`; compose defaults those to the `mailpit` service at `mailpit:1025`.
Mailpit's SMTP sink is available on `localhost:${MAILPIT_SMTP_PORT:-28457}` and its web UI on
`http://localhost:${MAILPIT_WEB_PORT:-28458}`.

## Webhook Engine

The webhook engine is loaded by the `helix` app service, not a separate container.

- Inbound path: `POST /webhooks/<slug>`
- Tool registry includes outbound, inbound, and delivery webhook tools.
- `HELIX_CONFIG_JSON` enables the Phase 0 webhook engine and bundled source/format plugin ids for compose deployments.
- Caddy proxies webhook traffic to `helix:3000` through the same edge as the rest of the API.

## Observability Profile

Run the profile only when local telemetry is needed:

```sh
HELIX_OBSERVABILITY_ENABLED=true docker compose --profile observability up -d
```

Expected wiring:

- Helix exports OTLP HTTP traces to `http://otel-collector:4318/v1/traces`.
- The collector exports traces to Tempo over OTLP gRPC.
- Prometheus scrapes `helix:3000/metrics`, Prometheus itself, and the collector.
- Grafana provisions Prometheus, Tempo, and Loki datasources from `infra/observability/grafana`.

## Config Checks

Use config-only validation for this task:

```sh
pnpm infra:config
pnpm infra:config:observability
docker compose --profile drive-preview config >/tmp/helix-drive-preview-compose.yml
docker compose --profile observability --profile drive-preview config >/tmp/helix-full-compose.yml
docker compose --profile meet --profile observability --profile drive-preview config >/tmp/helix-all-profiles-compose.yml
lsof -nP -iTCP:28431-28458 -sTCP:LISTEN
```

Expected TASK-121 evidence:

- the config commands exit successfully
- resolved service list includes `helix`, Tier 1 dependencies, Caddy, and the optional
  observability, Drive preview, and Meet services under their profiles
- resolved published ports remain the contiguous `28431`-`28458` block above when optional profiles
  are included; `28431`-`28450` plus local mail `28456`-`28458` is expected when only observability
  and Drive preview are enabled
- port preflight for `28431`-`28458` returns no listeners before runtime startup
- any skipped runtime startup is recorded with the blocker: image pull/build failure,
  port conflict, missing secret, healthcheck failure, or unavailable Docker daemon
- current workstation runtime startup remains blocked until the Docker/Rancher Desktop socket is
  available at `/Users/mj/.rd/docker.sock`; config-only evidence does not prove live service health,
  migrations, seeded auth, or browser/API flows

Exact next commands once Docker/Rancher Desktop is available:

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

Do not run broad repo validation for TASK-121 unless a later task asks for it.

## Plugin Install and Admin Prompt Readiness

The current compose slice can only prove wiring readiness. Runtime acceptance still needs a live
authenticated stack.

- Backend plugin tool surface: `apps/helix/src/platform/plugins/tools.ts` exposes `plugin.list`
  and `plugin.install` as protected `admin.plugins` tools. The unit evidence in
  `apps/helix/src/platform/plugins/tools.test.ts` covers registration of both tools, list output
  with permission and confirmation metadata, blocked non-official installs until explicit
  confirmations are supplied, and official installs without non-official prompts. Validate with
  `pnpm --filter @helix/app exec vitest run src/platform/plugins/tools.test.ts`.
- Plugin install prompt readiness: run the plugin install k6 group against the target stack:
  `WEB_BASE_URL=<web-url> API_BASE_URL=<api-url> AUTH_TOKEN=<token> K6_SCENARIO_GROUPS=plugin_install pnpm quality:k6:target`.
  Capture the selected `PLUGIN_INSTALL_TOOL_ID` and `PLUGIN_INSTALL_BODY`, HTTP status, and
  `helix_plugin_install_ms` result. The default smoke tool is `plugin.install` with a
  bundled official plugin body intended to return `202 pending_confirmation` when the install
  prompt path is wired. Override `PLUGIN_INSTALL_PLUGIN_ID`, `PLUGIN_INSTALL_VERSION`,
  `PLUGIN_INSTALL_SOURCE`, `PLUGIN_INSTALL_REGISTRY_URL`, or `PLUGIN_INSTALL_BODY` to match the
  target plugin fixture. Use `pnpm quality:live-auth-smoke -- --plugin-lifecycle-smoke` for the
  fuller live backend lifecycle proof: list, install approval, enable, disable, uninstall approval,
  and audit rows.
- Admin config readiness: prove `GET /api/admin/platform-config` and
  `PATCH /api/admin/platform-config` with an admin token, then attach browser evidence that
  `/settings/admin` reflects success/error states without restart.
- Evidence is incomplete until protected calls are run with real auth; mocked k6 validation and
  config-only compose checks are readiness signals, not install/admin runtime proof.
