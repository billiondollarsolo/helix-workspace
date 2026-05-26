import type { JsonObject } from "@helix/sdk-types";

export interface FeatureFlagEvaluationContext {
  readonly orgId?: string;
  readonly actorId?: string;
  readonly environment?: string;
  readonly attributes?: JsonObject;
}

export interface FeatureFlagProvider {
  get<T>(key: string, defaultValue: T, context?: FeatureFlagEvaluationContext): T;
  getAsync<T>(
    key: string,
    defaultValue: T,
    context?: FeatureFlagEvaluationContext,
  ): Promise<T>;
}

export class FeatureFlagClient implements FeatureFlagProvider {
  #provider: FeatureFlagProvider = new StaticFeatureFlagProvider();

  setProvider(provider: FeatureFlagProvider): void {
    this.#provider = provider;
  }

  resetProvider(): void {
    this.#provider = new StaticFeatureFlagProvider();
  }

  get<T>(key: string, defaultValue: T, context?: FeatureFlagEvaluationContext): T {
    return this.#provider.get(key, defaultValue, context);
  }

  getAsync<T>(
    key: string,
    defaultValue: T,
    context?: FeatureFlagEvaluationContext,
  ): Promise<T> {
    return this.#provider.getAsync(key, defaultValue, context);
  }
}

export class StaticFeatureFlagProvider implements FeatureFlagProvider {
  constructor(private readonly values: ReadonlyMap<string, unknown> = new Map()) {}

  get<T>(key: string, defaultValue: T): T {
    return coerceFlagValue(this.values.get(key), defaultValue);
  }

  async getAsync<T>(key: string, defaultValue: T): Promise<T> {
    return this.get(key, defaultValue);
  }
}

export const flags = new FeatureFlagClient();

export function coerceFlagValue<T>(value: unknown, defaultValue: T): T {
  if (value === undefined) {
    return defaultValue;
  }
  if (defaultValue === null) {
    return (value ?? defaultValue) as T;
  }
  if (Array.isArray(defaultValue)) {
    return Array.isArray(value) ? (value as T) : defaultValue;
  }
  if (typeof defaultValue === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as T)
      : defaultValue;
  }
  return typeof value === typeof defaultValue ? (value as T) : defaultValue;
}
