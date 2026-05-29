import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  applyOpenTelemetryEnvironment,
  loadObservabilityConfigFromEnv,
} from "./platform/observability/config.js";
import { createTenantSpanProcessor } from "./platform/observability/tenant-span.js";

let sdk: NodeSDK | null = null;

export function initTelemetry(): void {
  const config = loadObservabilityConfigFromEnv();
  if (sdk !== null || process.env.OTEL_SDK_DISABLED === "true" || !config.enabled) {
    return;
  }

  applyOpenTelemetryEnvironment(process.env, config);

  const exporterOptions: ConstructorParameters<typeof OTLPTraceExporter>[0] =
    config.tracesEndpoint === undefined
      ? {}
      : {
          url: config.tracesEndpoint,
          ...(config.headers === undefined ? {} : { headers: config.headers }),
        };

  const traceExporter = new OTLPTraceExporter(exporterOptions);

  sdk = new NodeSDK({
    serviceName: config.serviceName,
    spanProcessors: [createTenantSpanProcessor(), new BatchSpanProcessor(traceExporter)],
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();
}
