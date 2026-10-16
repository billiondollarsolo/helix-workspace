import type {
  AIConfigStatus,
  AIProviderConfig,
  AIRoutingRule,
  PlatformConfigPatch,
} from "./tier-readiness/types";

export const OPENAI_COMPAT_PLUGIN = "com.helix.ai-provider-openai-compat@^1.0.0";

/** The models field is one free-text line; blank entries are dropped so a
 *  trailing comma does not become an empty model id. */
export function parseModelsCsv(csv: string): string[] {
  return csv
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Product slots operators assign in Admin. */
export const AI_FEATURE_SLOTS = [
  {
    feature: "assistant.chat",
    label: "Assistant chat (default model)",
    hint: "Default model when a user opens Assistant.",
  },
  {
    feature: "mail.spam-ai",
    label: "Mail spam AI (beta)",
    hint: "Second-pass after SpamAssassin. Enable the beta toggle below.",
  },
  {
    feature: "mail.compose-help",
    label: "Mail compose assist",
    hint: "Rewrite / suggest for compose (when that feature is wired).",
  },
  {
    feature: "meet.transcribe",
    label: "Meeting transcription",
    hint: "Speech model for live captions and transcripts. Requires a realtime speech-compatible provider and Meet transcription enabled.",
  },
  {
    feature: "meet.summarize",
    label: "Meeting summaries",
    hint: "Separate text model for recaps and action items. Enable AI meeting recaps in Admin → Meet. Unassigned means off.",
  },
] as const;

export type AiFeatureSlotId = (typeof AI_FEATURE_SLOTS)[number]["feature"];

export interface ProviderFormRow {
  readonly original?: AIProviderConfig;
  readonly plugin?: string;
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly region?: string;
  readonly defaultModel: string;
  /** Comma-separated model ids offered under this provider. */
  readonly modelsCsv: string;
  readonly apiKey: string;
  readonly enabled: boolean;
  /** When true, models appear in the Assistant model picker. */
  readonly offerInChat: boolean;
  readonly realtimeTranscription?: boolean;
  readonly apiKeyConfigured: boolean;
  /** Stable React key for the row; the editable id can't be the key or typing in it remounts the row.
   *  Saved rows key on their stored id so a refetch keeps the same rows mounted. */
  readonly rowKey?: string;
}

let nextProviderRowKey = 0;
function providerRowKey(): string {
  nextProviderRowKey += 1;
  return `provider-row-${String(nextProviderRowKey)}`;
}

export interface FeatureRouteFormRow {
  readonly feature: AiFeatureSlotId;
  readonly providerId: string;
  readonly model: string;
}

export interface AiProvidersEditorState {
  readonly originalRules?: readonly AIRoutingRule[];
  readonly maxToolRounds: string;
  readonly providers: readonly ProviderFormRow[];
  readonly routes: readonly FeatureRouteFormRow[];
  readonly spamBetaMode: "env" | "on" | "off";
}

export function emptyProviderRow(index = 0): ProviderFormRow {
  return {
    id: index === 0 ? "openai-compatible.default" : `provider-${String(index + 1)}`,
    displayName: index === 0 ? "Default OpenAI-compatible" : `Provider ${String(index + 1)}`,
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    modelsCsv: "gpt-4o-mini",
    apiKey: "",
    enabled: true,
    offerInChat: true,
    apiKeyConfigured: false,
    rowKey: providerRowKey(),
  };
}

/* Named providers when the config has them; otherwise the env-bootstrapped
   operator default shown as a single editable row, or nothing at all when there
   is not even that. */
function providerRowsFrom(ai: AIConfigStatus | undefined): ProviderFormRow[] {
  const providersRaw = ai?.providers ?? [];
  if (providersRaw.length > 0) {
    return providersRaw.map((provider, index) => providerToFormRow(provider, index));
  }
  if (ai?.operatorLlm === undefined) {
    return [];
  }
  return [
    {
      id: "openai-compatible.default",
      displayName: "Operator default",
      baseUrl: ai.operatorLlm.baseUrl ?? "https://api.openai.com/v1",
      defaultModel: ai.operatorLlm.model ?? "gpt-4o-mini",
      modelsCsv: ai.operatorLlm.model ?? "gpt-4o-mini",
      apiKey: "",
      enabled: true,
      offerInChat: true,
      apiKeyConfigured: ai.operatorLlm.apiKeyConfigured === true,
      rowKey: "server:operator-default",
    },
  ];
}

export function editorStateFromAiConfig(ai: AIConfigStatus | undefined): AiProvidersEditorState {
  const providers = providerRowsFrom(ai);

  const rules = ai?.routing?.rules ?? [];
  const routes: FeatureRouteFormRow[] = AI_FEATURE_SLOTS.map((slot) => {
    const rule = rules.find((entry) => entry.feature === slot.feature);
    return {
      feature: slot.feature,
      providerId:
        rule?.primary.providerId ??
        (slot.feature === "assistant.chat" ? (providers[0]?.id ?? "") : ""),
      model:
        rule?.primary.model ??
        (slot.feature === "assistant.chat" ? (providers[0]?.defaultModel ?? "") : ""),
    };
  });

  /* Three states, not two: an unset `betaEnabled` means the env default is
     still in charge, which is a different answer from an explicit off. */
  const betaEnabled = ai?.mailSpamAi?.betaEnabled;
  const spamBetaMode: AiProvidersEditorState["spamBetaMode"] =
    betaEnabled === true ? "on" : betaEnabled === false ? "off" : "env";

  return {
    originalRules: rules,
    providers,
    routes,
    spamBetaMode,
    maxToolRounds: String(ai?.assistant?.maxToolRounds ?? 128),
  };
}

function providerToFormRow(provider: AIProviderConfig, index: number): ProviderFormRow {
  const cfg = provider.config ?? {};
  const models = Array.isArray(cfg.models)
    ? cfg.models.filter((entry): entry is string => typeof entry === "string")
    : [];
  const defaultModel = cfg.defaultModel ?? cfg.model ?? models[0] ?? "gpt-4o-mini";
  const modelsCsv =
    models.length > 0 ? models.join(", ") : defaultModel.length > 0 ? defaultModel : "";
  const tags = provider.tags ?? [];
  return {
    original: provider,
    plugin: provider.plugin,
    id: provider.id || `provider-${String(index + 1)}`,
    displayName:
      (typeof cfg.displayName === "string" && cfg.displayName) ||
      provider.id ||
      `Provider ${String(index + 1)}`,
    baseUrl: cfg.baseUrl ?? "https://api.openai.com/v1",
    ...(typeof cfg.region === "string"
      ? { region: cfg.region }
      : typeof cfg.location === "string"
        ? { region: cfg.location }
        : {}),
    defaultModel,
    modelsCsv,
    apiKey: "",
    enabled: provider.enabled !== false,
    offerInChat: tags.includes("assistant") || tags.length === 0,
    apiKeyConfigured: cfg.apiKeyConfigured === true,
    realtimeTranscription: cfg.realtimeTranscription === true,
    rowKey: `server:${provider.id || String(index)}`,
  };
}

/**
 * Build platform-config AI PATCH from the editor. Empty provider apiKey omits
 * the secret so the API keeps the stored key.
 */
export function buildMultiProviderAiPatch(
  state: AiProvidersEditorState,
  baseline: AiProvidersEditorState,
): NonNullable<PlatformConfigPatch["ai"]> | string {
  const maxToolRounds = Number(state.maxToolRounds);
  if (!Number.isInteger(maxToolRounds) || maxToolRounds < 1 || maxToolRounds > 256)
    return "Assistant tool steps must be a whole number from 1 to 256.";
  if (state.providers.length === 0) {
    return "Add at least one provider, or clear routing assignments first.";
  }
  const ids = new Set<string>();
  for (const provider of state.providers) {
    const id = provider.id.trim();
    if (id.length === 0) {
      return "Each provider needs a stable id (e.g. openai-primary).";
    }
    if (ids.has(id)) {
      return `Duplicate provider id “${id}”.`;
    }
    ids.add(id);
    if (!editableProvider(provider)) continue;
    if (provider.baseUrl.trim().length > 0) {
      try {
        const url = new URL(provider.baseUrl.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return `Provider ${id}: base URL must use http or https.`;
        }
      } catch {
        return `Provider ${id}: base URL is not a valid URL.`;
      }
    }
    if (provider.defaultModel.trim().length === 0) {
      return `Provider ${id}: default model is required.`;
    }
  }

  const providers: AIProviderConfig[] = state.providers.map((provider) => {
    if (!editableProvider(provider) && provider.original) return provider.original;
    const models = parseModelsCsv(provider.modelsCsv);
    const defaultModel = provider.defaultModel.trim();
    const modelList = [...new Set([defaultModel, ...models])];
    const tags = provider.offerInChat ? (["assistant"] as const) : (["backend"] as const);
    const apiKey = provider.apiKey.trim();
    return {
      id: provider.id.trim(),
      plugin: provider.plugin ?? OPENAI_COMPAT_PLUGIN,
      enabled: provider.enabled,
      tags: [
        ...new Set([
          ...(provider.original?.tags ?? []).filter(
            (tag) => tag !== "assistant" && tag !== "backend",
          ),
          ...tags,
        ]),
      ],
      config: {
        ...provider.original?.config,
        displayName: provider.displayName.trim() || provider.id.trim(),
        baseUrl: provider.baseUrl.trim(),
        ...(provider.region?.trim() ? { region: provider.region.trim() } : {}),
        defaultModel,
        models: modelList,
        ...(provider.realtimeTranscription === undefined
          ? {}
          : { realtimeTranscription: provider.realtimeTranscription }),
        ...(apiKey.length > 0 ? { apiKey } : {}),
      },
    };
  });

  const rules: AIRoutingRule[] = (state.originalRules ?? []).filter(
    (rule) => !AI_FEATURE_SLOTS.some((slot) => slot.feature === rule.feature),
  );
  for (const route of state.routes) {
    if (route.providerId.trim().length === 0) {
      continue;
    }
    if (!ids.has(route.providerId.trim())) {
      return `Routing for ${route.feature} points at unknown provider “${route.providerId}”.`;
    }
    if (route.feature.startsWith("meet.")) {
      const selected = state.providers.find((provider) => provider.id === route.providerId.trim());
      if (
        !selected?.enabled ||
        !route.model.trim() ||
        !parseModelsCsv(selected.modelsCsv).includes(route.model.trim())
      )
        return `Choose an enabled provider and a configured model for ${route.feature}.`;
      if (!providerSupportsFeature(selected, route.feature))
        return "Meeting transcription requires a provider marked as supporting realtime speech transcription.";
    }
    const fallback = state.originalRules?.find((rule) => rule.feature === route.feature)?.fallback;
    rules.push({
      ...(fallback && ids.has(fallback.providerId) ? { fallback } : {}),
      feature: route.feature,
      primary: {
        providerId: route.providerId.trim(),
        ...(route.model.trim().length > 0 ? { model: route.model.trim() } : {}),
      },
    });
  }

  const spamChanged = state.spamBetaMode !== baseline.spamBetaMode;
  const mailSpamAi =
    !spamChanged || state.spamBetaMode === "env"
      ? undefined
      : { betaEnabled: state.spamBetaMode === "on" };

  // Keep operatorLlm mirrored from assistant.chat (or first provider) for
  // older consumers that only read the shared defaults.
  const assistantRoute = rules.find((rule) => rule.feature === "assistant.chat");
  const defaultProvider =
    providers.find((provider) => provider.id === assistantRoute?.primary.providerId) ??
    providers[0];
  const operatorLlm =
    defaultProvider === undefined || !defaultProvider.plugin.includes("openai-compat")
      ? undefined
      : {
          baseUrl: defaultProvider.config?.baseUrl,
          model: assistantRoute?.primary.model ?? defaultProvider.config?.defaultModel,
          ...(typeof defaultProvider.config?.apiKey === "string" &&
          defaultProvider.config.apiKey.length > 0
            ? { apiKey: defaultProvider.config.apiKey }
            : {}),
        };

  return {
    providers,
    routing: { rules },
    ...(state.maxToolRounds === baseline.maxToolRounds ? {} : { assistant: { maxToolRounds } }),
    ...(mailSpamAi === undefined ? {} : { mailSpamAi }),
    ...(operatorLlm === undefined ? {} : { operatorLlm }),
  };
}

export function editableProvider(provider: ProviderFormRow): boolean {
  return (
    (provider.plugin === undefined || /openai-compat|anthropic-compat/u.test(provider.plugin)) &&
    (provider.original?.config?.models?.every((model) => typeof model === "string") ?? true)
  );
}

export function providerProtocolLabel(provider: ProviderFormRow): string {
  if (provider.plugin?.includes("anthropic")) return "Anthropic";
  if (provider.plugin?.includes("bedrock")) return "Amazon Bedrock";
  if (provider.plugin?.includes("vertex")) return "Google Vertex AI";
  return editableProvider(provider) ? "OpenAI-compatible" : "Deployment managed";
}

/** Speech APIs and text APIs are separate capabilities, even at the same provider. */
export function providerSupportsFeature(
  provider: ProviderFormRow,
  feature: AiFeatureSlotId,
): boolean {
  if (feature === "meet.transcribe")
    return (
      (provider.plugin ?? OPENAI_COMPAT_PLUGIN).includes("openai-compat") &&
      provider.realtimeTranscription === true
    );
  return (
    feature === "assistant.chat" ||
    feature === "meet.summarize" ||
    (provider.plugin ?? OPENAI_COMPAT_PLUGIN).includes("openai-compat")
  );
}
