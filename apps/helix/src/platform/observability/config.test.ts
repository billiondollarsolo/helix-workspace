import { describe, expect, it } from "vitest";
import {
  applyOpenTelemetryEnvironment,
  loadObservabilityConfigFromEnv,
  normalizeOtlpHttpTraceEndpoint,
} from "./config.js";

describe("observability config", () => {
  it("defaults to disabled so telemetry does not leave the process without opt-in", () => {
    expect(loadObservabilityConfigFromEnv({}).enabled).toBe(false);
  });

  it("loads PRD-style observability config from HELIX_CONFIG_JSON", () => {
    const config = loadObservabilityConfigFromEnv({
      HELIX_CONFIG_JSON: JSON.stringify({
        observability: {
          enabled: true,
          config: {
            otlpEndpoint: "http://tempo:4317",
            sampling: {
              traces: 0.25,
              llmCalls: 1,
              toolCalls: 1,
              permissionChecks: 0.05,
            },
          },
        },
      }),
    });

    expect(config.enabled).toBe(true);
    expect(config.tracesEndpoint).toBe("http://tempo:4318/v1/traces");
    expect(config.sampling).toEqual({
      traces: 0.25,
      llmCalls: 1,
      toolCalls: 1,
      permissionChecks: 0.05,
    });
  });

  it("lets explicit environment values override JSON config", () => {
    const config = loadObservabilityConfigFromEnv({
      HELIX_CONFIG_JSON: JSON.stringify({
        plugins: {
          "com.helix.observability-otel": {
            enabled: false,
            otlpEndpoint: "http://tempo:4318",
            sampling: { traces: 0.1 },
          },
        },
      }),
      HELIX_OBSERVABILITY_ENABLED: "true",
      HELIX_OTEL_TRACES_ENDPOINT: "http://collector.example:4318/v1/traces",
      HELIX_OTEL_TRACES_SAMPLING: "0.75",
    });

    expect(config.enabled).toBe(true);
    expect(config.tracesEndpoint).toBe("http://collector.example:4318/v1/traces");
    expect(config.sampling.traces).toBe(0.75);
  });

  it("applies standard OpenTelemetry env vars without overwriting explicit values", () => {
    const env: NodeJS.ProcessEnv = {
      OTEL_TRACES_SAMPLER: "always_on",
    };

    applyOpenTelemetryEnvironment(env, {
      enabled: true,
      serviceName: "helix-test",
      tracesEndpoint: "http://localhost:4318/v1/traces",
      sampling: {
        traces: 0.5,
        llmCalls: 1,
        toolCalls: 1,
        permissionChecks: 0.1,
      },
      propagateTraceContext: true,
    });

    expect(env.OTEL_SERVICE_NAME).toBe("helix-test");
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe("http://localhost:4318/v1/traces");
    expect(env.OTEL_TRACES_SAMPLER).toBe("always_on");
    expect(env.OTEL_TRACES_SAMPLER_ARG).toBe("0.5");
    expect(env.OTEL_PROPAGATORS).toBe("tracecontext,baggage");
  });

  it("normalizes receiver endpoints for the HTTP trace exporter", () => {
    expect(normalizeOtlpHttpTraceEndpoint("http://otel-collector:4318")).toBe(
      "http://otel-collector:4318/v1/traces",
    );
    expect(normalizeOtlpHttpTraceEndpoint("http://otel-collector:4317")).toBe(
      "http://otel-collector:4318/v1/traces",
    );
  });
});
