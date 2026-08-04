export const observabilityOtelPluginId = "com.helix.observability-otel";

export interface ObservabilitySamplingConfig {
  readonly traces: number;
  readonly llmCalls: number;
  readonly toolCalls: number;
  readonly permissionChecks: number;
}

export interface ObservabilityConfig {
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly tracesEndpoint?: string;
  readonly headers?: Record<string, string>;
  readonly sampling: ObservabilitySamplingConfig;
  readonly propagateTraceContext: boolean;
}

type PartialObservabilityConfig = Omit<Partial<ObservabilityConfig>, "sampling"> & {
  readonly sampling?: Partial<ObservabilitySamplingConfig>;
};

const defaultSampling: ObservabilitySamplingConfig = {
  traces: 0.1,
  llmCalls: 1,
  toolCalls: 1,
  permissionChecks: 0.05,
};

export const defaultObservabilityConfig: ObservabilityConfig = {
  enabled: false,
  serviceName: "helix-app",
  sampling: defaultSampling,
  propagateTraceContext: true,
};

export function loadObservabilityConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ObservabilityConfig {
  const configJson = parseConfigJson(env.HELIX_CONFIG_JSON);
  const jsonConfig = configFromJson(configJson);
  const envConfig = configFromExplicitEnv(env);

  return mergeObservabilityConfig(
    defaultObservabilityConfig,
    mergeObservabilityConfig(jsonConfig, envConfig),
  );
}

export function mergeObservabilityConfig(
  base: PartialObservabilityConfig,
  override: PartialObservabilityConfig,
): ObservabilityConfig {
  const sampling = {
    ...defaultSampling,
    ...base.sampling,
    ...override.sampling,
  };

  // Optional fields stay *absent* rather than explicitly `undefined`, so a
  // merged config can be spread over another without erasing its values.
  const tracesEndpoint = override.tracesEndpoint ?? base.tracesEndpoint;
  const headers = override.headers ?? base.headers;

  return {
    enabled: override.enabled ?? base.enabled ?? defaultObservabilityConfig.enabled,
    serviceName: override.serviceName ?? base.serviceName ?? defaultObservabilityConfig.serviceName,
    ...(tracesEndpoint === undefined ? {} : { tracesEndpoint }),
    ...(headers === undefined ? {} : { headers }),
    sampling: {
      traces: normalizeSampleRate(sampling.traces),
      llmCalls: normalizeSampleRate(sampling.llmCalls),
      toolCalls: normalizeSampleRate(sampling.toolCalls),
      permissionChecks: normalizeSampleRate(sampling.permissionChecks),
    },
    propagateTraceContext:
      override.propagateTraceContext ??
      base.propagateTraceContext ??
      defaultObservabilityConfig.propagateTraceContext,
  };
}

export function normalizeOtlpHttpTraceEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (parsed.pathname === "" || parsed.pathname === "/") {
    parsed.pathname = "/v1/traces";
  }
  if (parsed.port === "4317") {
    parsed.port = "4318";
  }
  return parsed.toString();
}

export function applyOpenTelemetryEnvironment(
  env: NodeJS.ProcessEnv,
  config: ObservabilityConfig,
): void {
  env.OTEL_SERVICE_NAME ??= config.serviceName;
  if (config.tracesEndpoint !== undefined) {
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??= config.tracesEndpoint;
  }
  if (config.propagateTraceContext) {
    env.OTEL_PROPAGATORS ??= "tracecontext,baggage";
  }

  env.OTEL_TRACES_SAMPLER ??= "traceidratio";
  env.OTEL_TRACES_SAMPLER_ARG ??= String(config.sampling.traces);
}

function configFromExplicitEnv(env: NodeJS.ProcessEnv): PartialObservabilityConfig {
  const enabled = parseBoolean(env.HELIX_OBSERVABILITY_ENABLED);
  const rawEndpoint =
    env.HELIX_OTEL_TRACES_ENDPOINT ??
    env.HELIX_OTEL_OTLP_ENDPOINT ??
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const endpoint =
    rawEndpoint === undefined ? undefined : normalizeOtlpHttpTraceEndpoint(rawEndpoint);
  const headers = parseHeaders(env.HELIX_OTEL_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS);
  const traces = parseSampleRate(env.HELIX_OTEL_TRACES_SAMPLING ?? env.OTEL_TRACES_SAMPLER_ARG);
  const llmCalls = parseSampleRate(env.HELIX_OTEL_LLM_CALLS_SAMPLING);
  const toolCalls = parseSampleRate(env.HELIX_OTEL_TOOL_CALLS_SAMPLING);
  const permissionChecks = parseSampleRate(env.HELIX_OTEL_PERMISSION_CHECKS_SAMPLING);

  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(env.OTEL_SERVICE_NAME === undefined ? {} : { serviceName: env.OTEL_SERVICE_NAME }),
    ...(endpoint === undefined ? {} : { tracesEndpoint: endpoint }),
    ...(headers === undefined ? {} : { headers }),
    sampling: {
      ...(traces === undefined ? {} : { traces }),
      ...(llmCalls === undefined ? {} : { llmCalls }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
      ...(permissionChecks === undefined ? {} : { permissionChecks }),
    },
  };
}

function configFromJson(value: unknown): PartialObservabilityConfig {
  if (!isRecord(value)) {
    return {};
  }

  const observability = isRecord(value.observability) ? value.observability : undefined;
  const topLevelConfig = isRecord(observability?.config) ? observability.config : undefined;
  const pluginConfig = pluginConfigFromJson(value);
  const merged = mergePlainObjects(topLevelConfig, pluginConfig);

  const endpoint = stringValue(merged.otlpEndpoint ?? merged.tracesEndpoint);
  const headers = parseHeadersObject(merged.headers);
  const sampling = isRecord(merged.sampling) ? merged.sampling : {};

  const enabled = parseBooleanValue(observability?.enabled ?? merged.enabled);
  const serviceName = stringValue(merged.serviceName);
  const traceSampleRate = numberValue(sampling.traces);
  const llmSampleRate = numberValue(sampling.llmCalls);
  const toolSampleRate = numberValue(sampling.toolCalls);
  const permissionSampleRate = numberValue(sampling.permissionChecks);

  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(serviceName === undefined ? {} : { serviceName }),
    ...(endpoint === undefined ? {} : { tracesEndpoint: normalizeOtlpHttpTraceEndpoint(endpoint) }),
    ...(headers === undefined ? {} : { headers }),
    sampling: {
      ...(traceSampleRate === undefined ? {} : { traces: traceSampleRate }),
      ...(llmSampleRate === undefined ? {} : { llmCalls: llmSampleRate }),
      ...(toolSampleRate === undefined ? {} : { toolCalls: toolSampleRate }),
      ...(permissionSampleRate === undefined ? {} : { permissionChecks: permissionSampleRate }),
    },
  };
}

function pluginConfigFromJson(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!isRecord(value.plugins)) {
    return undefined;
  }

  const exact = value.plugins[observabilityOtelPluginId];
  if (isRecord(exact)) {
    return exact;
  }

  const versioned = Object.entries(value.plugins).find(([key]) =>
    key.startsWith(`${observabilityOtelPluginId}@`),
  );
  return isRecord(versioned?.[1]) ? versioned[1] : undefined;
}

function parseConfigJson(text: string | undefined): unknown {
  if (text === undefined || text.trim().length === 0) {
    return undefined;
  }

  return JSON.parse(text) as unknown;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseBooleanValue(value);
}

function parseBooleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  return undefined;
}

function parseSampleRate(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeSampleRate(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function parseHeaders(value: string | undefined): Record<string, string> | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const [rawKey, ...rawValue] = pair.split("=");
    const key = rawKey?.trim();
    const headerValue = rawValue.join("=").trim();
    if (key !== undefined && key.length > 0 && headerValue.length > 0) {
      headers[key] = headerValue;
    }
  }

  return Object.keys(headers).length === 0 ? undefined : headers;
}

function parseHeadersObject(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string") {
      headers[key] = headerValue;
    }
  }
  return Object.keys(headers).length === 0 ? undefined : headers;
}

function mergePlainObjects(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(override ?? {})) {
    const existing = merged[key];
    merged[key] =
      isRecord(existing) && isRecord(value) ? mergePlainObjects(existing, value) : value;
  }
  return merged;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
