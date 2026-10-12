import type { LLMProviderCapability } from "@helix/sdk-types";
import { z } from "zod";
import { actorHasScope } from "../../api/scopes.js";
import { isProbeableProvider, type ProviderProbeResult } from "../ai/providers/probe.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";

const objectJsonSchema = { type: "object", additionalProperties: true } as const;
const statusInputSchema = z.object({}).strict();
const adminConfigScope = "admin.config.read";

/** How long one provider probe may take before the provider counts as unreachable. */
export const ASSISTANT_PROBE_TIMEOUT_MS = 3_000;
/** How long a probe outcome is reused before the providers are asked again. */
export const ASSISTANT_PROBE_TTL_MS = 60_000;

export const ASSISTANT_NOT_CONFIGURED_MEMBER_MESSAGE =
  "Helix AI isn't set up for this workspace yet. Ask your administrator to set up Helix AI.";
export const ASSISTANT_UNREACHABLE_MEMBER_MESSAGE =
  "Helix AI is unavailable right now. Ask your administrator to set up Helix AI.";

export type AssistantAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: "not_configured" }
  | {
      readonly available: false;
      readonly reason: "unreachable";
      /** `credentials` when every failing provider refused Helix's credentials. */
      readonly cause: "network" | "credentials";
      readonly providerIds: readonly string[];
    };

export interface AssistantAvailabilityCheckOptions {
  /** The providers the Assistant routes to, from the same router that serves chat. */
  readonly providers: () => readonly LLMProviderCapability[];
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * Whether the Assistant has a provider that answers. Providers are created from
 * configuration alone (an `OLLAMA_BASE_URL` or `OPENAI_API_KEY` is enough), so
 * presence says nothing about whether chat will work; HTTP providers are asked
 * for their model listing instead. Providers without a cheap probe (cloud SDK
 * providers) count as reachable. The outcome is cached per process and shared
 * by concurrent callers, and re-probed when the provider set changes.
 */
export function createAssistantAvailabilityCheck(
  options: AssistantAvailabilityCheckOptions,
): () => Promise<AssistantAvailability> {
  const timeoutMs = options.timeoutMs ?? ASSISTANT_PROBE_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? ASSISTANT_PROBE_TTL_MS;
  const now = options.now ?? Date.now;
  let cached:
    | {
        readonly key: string;
        readonly expiresAt: number;
        readonly result: Promise<AssistantAvailability>;
      }
    | undefined;

  return () => {
    const providers = options.providers();
    const key = providers.map((provider) => provider.id).join("\n");
    if (cached !== undefined && cached.key === key && cached.expiresAt > now()) {
      return cached.result;
    }
    const result = probeProviders(providers, timeoutMs);
    cached = { key, expiresAt: now() + ttlMs, result };
    return result;
  };
}

async function probeProviders(
  providers: readonly LLMProviderCapability[],
  timeoutMs: number,
): Promise<AssistantAvailability> {
  if (providers.length === 0) return { available: false, reason: "not_configured" };
  const signal = AbortSignal.timeout(timeoutMs);
  const outcomes = await Promise.all(
    providers.map(async (provider): Promise<readonly [string, ProviderProbeResult]> => [
      provider.id,
      isProbeableProvider(provider) ? await provider.probe(signal) : "reachable",
    ]),
  );
  if (outcomes.some(([, outcome]) => outcome === "reachable")) return { available: true };
  return {
    available: false,
    reason: "unreachable",
    cause: outcomes.every(([, outcome]) => outcome === "rejected_credentials")
      ? "credentials"
      : "network",
    providerIds: outcomes.map(([id]) => id),
  };
}

/** The env-configured providers, by the settings an administrator changes. */
const ENV_PROVIDER_SETTINGS: Readonly<
  Record<string, { readonly address: string; readonly key: string }>
> = {
  "ollama.local": { address: "OLLAMA_BASE_URL", key: "OLLAMA_BASE_URL" },
  "openai-compatible.default": { address: "OPENAI_BASE_URL", key: "OPENAI_API_KEY" },
};

function providerSettings(providerIds: readonly string[], kind: "address" | "key"): string {
  return providerIds
    .map((id) => ENV_PROVIDER_SETTINGS[id]?.[kind] ?? `the "${id}" provider in Admin → Assistant`)
    .join(", ");
}

/** What an administrator does next, naming the setting behind each failing provider. */
export function assistantUnavailableAdminMessage(
  status: Exclude<AssistantAvailability, { readonly available: true }>,
): string {
  if (status.reason === "not_configured") {
    return (
      "Helix AI has no model provider. Add one in Admin → Assistant, or set OLLAMA_BASE_URL " +
      "(a local Ollama server) or OPENAI_API_KEY (an OpenAI-compatible service) and restart Helix."
    );
  }
  if (status.cause === "credentials") {
    return (
      "The AI provider rejected Helix's credentials. Update " +
      `${providerSettings(status.providerIds, "key")} and restart Helix.`
    );
  }
  return (
    "Helix can't reach its AI provider. Check that the server set by " +
    `${providerSettings(status.providerIds, "address")} is running and reachable from Helix; ` +
    "private or local addresses also need HELIX_AI_ALLOW_PRIVATE_NETWORK=true."
  );
}

/**
 * `assistant.status`: whether Helix AI can answer. Registered with the
 * Assistant app so the web app hides its entry points instead of letting a
 * chat fail, and says why — configuration steps for admins, whom to ask for
 * members.
 */
export function registerAssistantStatusTool(
  registry: RuntimeToolRegistry,
  options: { readonly check: () => Promise<AssistantAvailability> },
): void {
  registry.register(
    defineTool<z.output<typeof statusInputSchema>, unknown>({
      id: "assistant.status",
      description:
        "Whether Helix AI has a reachable model provider and, when it does not, what an administrator must configure.",
      permission: "assistant.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(statusInputSchema, objectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), objectJsonSchema),
      handler: async (_input, ctx) => {
        const status = await options.check();
        if (status.available) return { available: true };
        const admin = actorHasScope(ctx.actor, adminConfigScope);
        return {
          available: false,
          reason: status.reason,
          message: admin
            ? assistantUnavailableAdminMessage(status)
            : status.reason === "not_configured"
              ? ASSISTANT_NOT_CONFIGURED_MEMBER_MESSAGE
              : ASSISTANT_UNREACHABLE_MEMBER_MESSAGE,
        };
      },
    }),
  );
}
