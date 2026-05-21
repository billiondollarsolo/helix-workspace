# com.helix.observability-otel

Configures the Helix Node OpenTelemetry SDK from environment variables or Helix plugin config.

Telemetry is disabled by default. Enable it explicitly with either `HELIX_OBSERVABILITY_ENABLED=true` or plugin config:

```json
{
  "plugins": {
    "com.helix.observability-otel": {
      "enabled": true,
      "otlpEndpoint": "http://otel-collector:4318",
      "sampling": {
        "traces": 0.1,
        "llmCalls": 1,
        "toolCalls": 1,
        "permissionChecks": 0.05
      }
    }
  }
}
```

The app uses the OTLP HTTP trace exporter, so bare receiver URLs are normalized to `/v1/traces`.
