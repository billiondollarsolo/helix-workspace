# com.helix.observability-grafana-stack

Provides the local observability stack for Helix:

- Grafana dashboards provisioned from `dashboards/`
- Prometheus datasource for `/metrics` and local alert rules from `infra/observability/prometheus/rules/`
- Alertmanager route for tenant storage migration alerts
- Tenant export dashboard panels for durable export job outcomes, active jobs, and stalled jobs
- Tempo datasource for OpenTelemetry traces
- Loki datasource for container logs when a log shipper is connected

Start it with:

```sh
docker compose --profile observability up -d
```

The matching OpenTelemetry endpoint for the app is `http://localhost:4318/v1/traces` from the host, or `http://otel-collector:4318/v1/traces` from another Compose service.

Alertmanager listens on `http://localhost:28461` by default. The bundled route
groups tenant storage migration alerts by alert, service, operation, target, and
status, then sends matching `service="storage",
operation="tenant_storage_migration"` alerts to the local storage migration
webhook receiver. Validate the route with:

```sh
pnpm quality:alertmanager-tenant-storage-routing
```

Production deployments should start from
`infra/observability/alertmanager/alertmanager.production.yml`. It preserves the
local webhook fanout for evidence and adds
`helix-tenant-storage-migration-paging`, an external paging webhook loaded from
`/etc/alertmanager/secrets/tenant-storage-migration-paging-webhook-url`. Mount
that file from the deployment secret manager; do not commit paging URLs or API
keys. Static validation does not need Docker or the secret:

```sh
pnpm quality:alertmanager-tenant-storage-routing -- --static
```
