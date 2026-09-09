# com.helix.observability-grafana-stack

Provides the local observability stack for Helix:

- Grafana dashboards provisioned from `dashboards/`
- Workspace operations dashboard for HTTP, auth, dependencies, workers, Mail,
  Drive, Chat, agents, audit, backup, and restore signals
- Prometheus datasource for `/metrics`
- Prometheus alert rules loaded from `infra/observability/prometheus/rules/`
- Alertmanager route for signup activation SLO alerts
- Tempo datasource for OpenTelemetry traces
- Loki datasource for container logs when a log shipper is connected

Start it with:

```sh
docker compose --profile observability up -d
```

The matching OpenTelemetry endpoint for the app is `http://localhost:4318/v1/traces` from the host, or `http://otel-collector:4318/v1/traces` from another Compose service.

The Workspace dashboard is provisioned as `Helix Workspace Operations`
(`uid=helix-workspace-operations`). Its alerts use content-free labels and link
to focused procedures under `docs/runbooks/`; see `docs/observability.md` for
the metric and data-safety contract.

Alertmanager listens on `http://localhost:28461` by default. The bundled route
groups signup activation alerts by alert, service, SLO, tier, plan, and region,
then sends matching `service="signup", slo="signup_activation"` alerts to the
local signup SLO webhook receiver. Validate the route with:

```sh
pnpm quality:alertmanager-signup-routing
```

Production deployments should start from
`infra/observability/alertmanager/alertmanager.production.yml`. It preserves the
local webhook fanout for evidence and adds `helix-signup-slo-paging`, an
external paging webhook loaded from
`/etc/alertmanager/secrets/signup-slo-paging-webhook-url`. Mount that file from
the deployment secret manager; do not commit paging URLs or API keys. Static
validation does not need Docker or the secret:

```sh
pnpm quality:alertmanager-signup-routing -- --static
```
