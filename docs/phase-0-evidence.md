# Phase 0 Evidence

## TASK-121: Tier 1 Docker Compose Readiness

Evidence captured for the compose/readiness slice only.

### Acceptance Notes

- `docker-compose.yml` includes the Helix app service and Tier 1 dependencies: Postgres, Redis, NATS JetStream, Meilisearch, RustFS, Cerbos, and Caddy.
- The Helix service enables the Phase 0 webhook engine, outbound webhook format plugin ids, inbound webhook source plugin ids, and observability OTel plugin config through `HELIX_CONFIG_JSON`.
- The webhook engine is in-process with the app and exposed through the Caddy edge path, including `POST /webhooks/<slug>`.
- The optional `observability` profile includes OTel Collector, Prometheus, Tempo, Loki, and Grafana.
- The optional `drive-preview` profile includes the `drive-preview-libreoffice` Office-to-PDF
  preview conversion service.
- The base local stack includes the in-process Helix SMTP receiver and Mailpit outbound SMTP sink.
- Grafana provisioning for datasources and dashboards lives under `infra/observability/grafana`.
- Default published ports are contiguous high ports from `28431` through `28458` when optional
  observability, Drive preview, and Meet profiles are enabled; observability add-ons occupy
  `28444` through `28449`, Drive preview occupies `28450`, and Meet/Jitsi occupies `28451`
  through `28455`; local mail occupies `28456` through `28458`.
- Live-stack Docker evidence remains blocked on this workstation until the Docker/Rancher Desktop
  socket at `/Users/mj/.rd/docker.sock` is available. Config-only evidence does not prove runtime
  service health.

### Commands

Run after edits:

```sh
docker compose config
docker compose --profile observability config
docker compose --profile drive-preview config
docker compose --profile observability --profile drive-preview config
docker compose --profile meet --profile observability --profile drive-preview config
lsof -nP -iTCP:28431-28458 -sTCP:LISTEN
```

Recorded on 2026-05-20:

```text
docker compose config: ok
docker compose --profile observability config: ok
docker compose --profile drive-preview config: ok
docker compose --profile observability --profile drive-preview config: ok
docker compose --profile meet --profile observability --profile drive-preview config: ok
resolved published ports with observability and drive-preview profiles: 28431 28432 28433 28434 28435 28436 28437 28438 28439 28440 28441 28442 28443 28444 28445 28446 28447 28448 28449 28450 28456 28457 28458
resolved published ports with meet, observability, and drive-preview profiles: 28431 28432 28433 28434 28435 28436 28437 28438 28439 28440 28441 28442 28443 28444 28445 28446 28447 28448 28449 28450 28451 28452 28453 28454 28455 28456 28457 28458
port preflight 28431-28458: no TCP listeners
docker info: blocked, Rancher Desktop context cannot connect to unix:///Users/mj/.rd/docker.sock
runtime startup: blocked, Docker/Rancher Desktop socket unavailable
```

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

No broad repo validation is required for this evidence file.
