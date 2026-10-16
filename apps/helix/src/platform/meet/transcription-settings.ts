import type { HelixConfig } from "@helix/sdk-types";
import { resolveFeatureProviderCredentials } from "../config/ai-settings.js";

/** Capture and recaps never inherit the Assistant's route or enablement. */
export function meetTranscriptionSettings(
  config: HelixConfig,
  features: Readonly<Record<string, unknown>> | undefined,
  proxyConfigured: boolean,
  allowedHosts: readonly string[] = ["api.openai.com"],
) {
  const route = config.ai?.routing?.rules?.find((rule) => rule.feature === "meet.transcribe");
  const definition = config.ai?.providers?.find(
    (provider) => provider.id === route?.primary.providerId,
  );
  const provider = resolveFeatureProviderCredentials(config, "meet.transcribe");
  const model = route?.primary.model?.trim();
  const models = definition?.config?.models;
  const declared =
    definition?.config?.realtimeTranscription === true &&
    model &&
    model.length <= 200 &&
    !/\p{Cc}/u.test(model) &&
    Array.isArray(models) &&
    models.includes(model);
  let endpoint: string | undefined;
  try {
    const url = new URL(provider.baseUrl ?? "");
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!url.port || url.port === "443") &&
      allowedHosts.includes(url.hostname)
    ) {
      url.protocol = "wss:";
      url.pathname = `${url.pathname.replace(/\/$/u, "")}/realtime`;
      url.searchParams.set("intent", "transcription");
      endpoint = url.href;
    }
  } catch {
    /* Invalid endpoints remain disabled. */
  }
  const enabled = Boolean(
    config.ai?.enabled !== false &&
    proxyConfigured &&
    features?.meet_transcription === true &&
    declared &&
    endpoint &&
    provider.apiKey &&
    config.security.tier !== "sovereign" &&
    config.security.overrides?.localAiOnly !== true,
  );
  const recap = config.ai?.routing?.rules?.find((rule) => rule.feature === "meet.summarize");
  const recapProvider = config.ai?.providers?.find(
    (entry) => entry.id === recap?.primary.providerId,
  );
  return {
    enabled,
    summarize:
      config.ai?.enabled !== false &&
      features?.meet_ai_recaps === true &&
      Boolean(recap?.primary.model?.trim() && recapProvider && recapProvider.enabled !== false),
    ...(enabled ? { apiKey: provider.apiKey, endpoint, model } : {}),
  };
}
