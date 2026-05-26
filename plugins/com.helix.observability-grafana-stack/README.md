# com.helix.observability-grafana-stack

Provides the local observability stack for Helix:

- Grafana dashboards provisioned from `dashboards/`
- Prometheus datasource for `/metrics` and local alert rules from `infra/observability/prometheus/rules/`
- Tempo datasource for OpenTelemetry traces
- Loki datasource for container logs when a log shipper is connected

Start it with:

```sh
docker compose --profile observability up -d
```

The matching OpenTelemetry endpoint for the app is `http://localhost:4318/v1/traces` from the host, or `http://otel-collector:4318/v1/traces` from another Compose service.
