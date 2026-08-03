/**
 * Admin › AI providers — named LLM providers + per-feature routing.
 *
 * Operators configure one or more OpenAI-compatible providers, then assign
 * which provider/model each product slot uses (Assistant chat, mail spam AI,
 * mail compose assist). Chat can offer multiple models via the `assistant` tag.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Save, Shield, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminAiRelatedNav } from "@/features/admin/admin-related-nav";
import { PageHeading, StateBanner } from "@/features/admin/console/primitives";
import {
  adminPlatformConfigQueryKey,
  adminPlatformConfigQueryOptions,
  updatePlatformAiSettings,
} from "@/features/admin/tier-readiness/api";
import type {
  AIConfigStatus,
  AIProviderConfig,
  AIRoutingRule,
  PlatformConfigPatch,
  PlatformConfigStatus,
} from "@/features/admin/tier-readiness/types";

const OPENAI_COMPAT_PLUGIN = "com.helix.ai-provider-openai-compat@^1.0.0";

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
] as const;

export type AiFeatureSlotId = (typeof AI_FEATURE_SLOTS)[number]["feature"];

export interface ProviderFormRow {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  /** Comma-separated model ids offered under this provider. */
  readonly modelsCsv: string;
  readonly apiKey: string;
  readonly enabled: boolean;
  /** When true, models appear in the Assistant model picker. */
  readonly offerInChat: boolean;
  readonly apiKeyConfigured: boolean;
}

export interface FeatureRouteFormRow {
  readonly feature: AiFeatureSlotId;
  readonly providerId: string;
  readonly model: string;
}

export interface AiProvidersEditorState {
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
  };
}

export function editorStateFromAiConfig(ai: AIConfigStatus | undefined): AiProvidersEditorState {
  const providersRaw = ai?.providers ?? [];
  const providers: ProviderFormRow[] =
    providersRaw.length === 0
      ? ai?.operatorLlm !== undefined
        ? [
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
            },
          ]
        : []
      : providersRaw.map((provider, index) => providerToFormRow(provider, index));

  const rules = ai?.routing?.rules ?? [];
  const routes: FeatureRouteFormRow[] = AI_FEATURE_SLOTS.map((slot) => {
    const rule = rules.find((entry) => entry.feature === slot.feature);
    return {
      feature: slot.feature,
      providerId: rule?.primary.providerId ?? providers[0]?.id ?? "",
      model: rule?.primary.model ?? providers[0]?.defaultModel ?? "",
    };
  });

  const spamBetaMode: AiProvidersEditorState["spamBetaMode"] =
    ai?.mailSpamAi?.betaEnabled === true
      ? "on"
      : ai?.mailSpamAi?.betaEnabled === false
        ? "off"
        : "env";

  return { providers, routes, spamBetaMode };
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
    id: provider.id || `provider-${String(index + 1)}`,
    displayName:
      (typeof cfg.displayName === "string" && cfg.displayName) ||
      provider.id ||
      `Provider ${String(index + 1)}`,
    baseUrl: cfg.baseUrl ?? "https://api.openai.com/v1",
    defaultModel,
    modelsCsv,
    apiKey: "",
    enabled: provider.enabled !== false,
    offerInChat: tags.includes("assistant") || tags.length === 0,
    apiKeyConfigured: cfg.apiKeyConfigured === true,
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
    const models = provider.modelsCsv
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const defaultModel = provider.defaultModel.trim();
    const modelList = models.length > 0 ? models : [defaultModel];
    const tags = provider.offerInChat ? (["assistant"] as const) : (["backend"] as const);
    const apiKey = provider.apiKey.trim();
    return {
      id: provider.id.trim(),
      plugin: OPENAI_COMPAT_PLUGIN,
      enabled: provider.enabled,
      tags: [...tags],
      config: {
        displayName: provider.displayName.trim() || provider.id.trim(),
        baseUrl: provider.baseUrl.trim(),
        defaultModel,
        models: modelList,
        ...(apiKey.length > 0 ? { apiKey } : {}),
      },
    };
  });

  const rules: AIRoutingRule[] = [];
  for (const route of state.routes) {
    if (route.providerId.trim().length === 0) {
      continue;
    }
    if (!ids.has(route.providerId.trim())) {
      return `Routing for ${route.feature} points at unknown provider “${route.providerId}”.`;
    }
    rules.push({
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
    defaultProvider === undefined
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
    ...(mailSpamAi === undefined ? {} : { mailSpamAi }),
    ...(operatorLlm === undefined ? {} : { operatorLlm }),
  };
}

export function AIProvidersManagement() {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const configQuery = useQuery(adminPlatformConfigQueryOptions());
  const [editor, setEditor] = useState<AiProvidersEditorState>(() =>
    editorStateFromAiConfig(undefined),
  );
  const [baseline, setBaseline] = useState<AiProvidersEditorState>(() =>
    editorStateFromAiConfig(undefined),
  );

  useEffect(() => {
    if (configQuery.data === undefined) {
      return;
    }
    const next = editorStateFromAiConfig(configQuery.data.config.ai);
    setEditor(next);
    setBaseline(next);
  }, [configQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (ai: NonNullable<PlatformConfigPatch["ai"]>) => updatePlatformAiSettings(ai),
    onMutate: () => {
      setFormError(null);
      setSavedNotice(null);
    },
    onSuccess: async (status) => {
      queryClient.setQueryData(adminPlatformConfigQueryKey, status);
      await queryClient.invalidateQueries({ queryKey: adminPlatformConfigQueryKey });
      setSavedNotice(
        "Saved. Feature routing and provider credentials hot-reload for spam AI. Assistant provider list is built at API process start — restart Helix after adding a brand-new provider if chat does not list it yet.",
      );
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : "Failed to save AI settings.");
    },
  });

  const providerOptions = useMemo(
    () => editor.providers.filter((provider) => provider.enabled && provider.id.trim().length > 0),
    [editor.providers],
  );

  const updateProvider = (index: number, patch: Partial<ProviderFormRow>) => {
    setEditor((current) => ({
      ...current,
      providers: current.providers.map((provider, i) =>
        i === index ? { ...provider, ...patch } : provider,
      ),
    }));
  };

  const removeProvider = (index: number) => {
    setEditor((current) => {
      const removed = current.providers[index]?.id;
      const providers = current.providers.filter((_, i) => i !== index);
      const fallback = providers[0]?.id ?? "";
      return {
        ...current,
        providers,
        routes: current.routes.map((route) =>
          route.providerId === removed ? { ...route, providerId: fallback } : route,
        ),
      };
    });
  };

  const addProvider = () => {
    setEditor((current) => ({
      ...current,
      providers: [...current.providers, emptyProviderRow(current.providers.length)],
    }));
  };

  const updateRoute = (feature: AiFeatureSlotId, patch: Partial<FeatureRouteFormRow>) => {
    setEditor((current) => ({
      ...current,
      routes: current.routes.map((route) =>
        route.feature === feature ? { ...route, ...patch } : route,
      ),
    }));
  };

  const onSave = async () => {
    const patch = buildMultiProviderAiPatch(editor, baseline);
    if (typeof patch === "string") {
      setFormError(patch);
      return;
    }
    setFormError(null);
    await saveMutation.mutateAsync(patch);
  };

  return (
    <section className="grid gap-4">
      <PageHeading
        title="AI providers"
        subtitle="Register OpenAI-compatible endpoints, then assign which provider and model each Helix AI feature uses. Assistant can offer multiple models when providers are tagged for chat."
      />
      <AdminAiRelatedNav current="ai-providers" />

      {configQuery.isPending ? (
        <StateBanner kind="loading">Loading AI configuration…</StateBanner>
      ) : null}
      {configQuery.isError ? (
        <StateBanner kind="error">
          {configQuery.error instanceof Error
            ? configQuery.error.message
            : "Could not load platform configuration."}
        </StateBanner>
      ) : null}
      {formError !== null ? <StateBanner kind="error">{formError}</StateBanner> : null}
      {savedNotice !== null ? <StateBanner kind="info">{savedNotice}</StateBanner> : null}

      <section
        aria-labelledby="ai-providers-list-heading"
        className="grid gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2
            className="m-0 flex items-center gap-2 text-sm font-semibold"
            id="ai-providers-list-heading"
          >
            <Sparkles aria-hidden="true" size={16} />
            Providers
          </h2>
          <Button size="sm" type="button" variant="outline" onClick={addProvider}>
            <Plus aria-hidden="true" />
            Add provider
          </Button>
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          Each row is an OpenAI-compatible endpoint (OpenAI, Azure OpenAI, Ollama, Groq, etc.).
          Secrets are write-only after save.
        </p>

        {editor.providers.length === 0 ? (
          <StateBanner kind="info">
            No providers yet. Add one, or set OPENAI_* env vars as bootstrap until you save here.
          </StateBanner>
        ) : null}

        <div className="grid gap-4">
          {editor.providers.map((provider, index) => (
            <article
              key={`${provider.id}-${String(index)}`}
              className="grid gap-3 rounded-md border border-border/80 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-muted-foreground">
                  Provider {String(index + 1)}
                  {provider.apiKeyConfigured ? " · key stored" : ""}
                </span>
                <Button
                  aria-label={`Remove provider ${provider.id}`}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => removeProvider(index)}
                >
                  <Trash2 aria-hidden="true" />
                  Remove
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-xs">
                  <span className="font-medium">Id</span>
                  <Input
                    aria-label={`Provider ${String(index + 1)} id`}
                    value={provider.id}
                    onChange={(event) => updateProvider(index, { id: event.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-xs">
                  <span className="font-medium">Display name</span>
                  <Input
                    aria-label={`Provider ${String(index + 1)} display name`}
                    value={provider.displayName}
                    onChange={(event) => updateProvider(index, { displayName: event.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-xs sm:col-span-2">
                  <span className="font-medium">Base URL</span>
                  <Input
                    aria-label={`Provider ${String(index + 1)} base URL`}
                    value={provider.baseUrl}
                    onChange={(event) => updateProvider(index, { baseUrl: event.target.value })}
                    placeholder="https://api.openai.com/v1"
                  />
                </label>
                <label className="grid gap-1 text-xs">
                  <span className="font-medium">Default model</span>
                  <Input
                    aria-label={`Provider ${String(index + 1)} default model`}
                    value={provider.defaultModel}
                    onChange={(event) =>
                      updateProvider(index, { defaultModel: event.target.value })
                    }
                  />
                </label>
                <label className="grid gap-1 text-xs">
                  <span className="font-medium">Models (comma-separated)</span>
                  <Input
                    aria-label={`Provider ${String(index + 1)} models`}
                    value={provider.modelsCsv}
                    onChange={(event) => updateProvider(index, { modelsCsv: event.target.value })}
                    placeholder="gpt-4o-mini, gpt-4o"
                  />
                </label>
                <label className="grid gap-1 text-xs sm:col-span-2">
                  <span className="font-medium">API key</span>
                  <Input
                    aria-label={`Provider ${String(index + 1)} API key`}
                    type="password"
                    autoComplete="new-password"
                    value={provider.apiKey}
                    onChange={(event) => updateProvider(index, { apiKey: event.target.value })}
                    placeholder={
                      provider.apiKeyConfigured
                        ? "•••••••• (leave blank to keep)"
                        : "sk-… or provider token"
                    }
                  />
                </label>
                <label className="flex min-h-8 items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={provider.enabled}
                    aria-label={`Provider ${String(index + 1)} enabled`}
                    onChange={(event) =>
                      updateProvider(index, { enabled: event.currentTarget.checked })
                    }
                  />
                  <span>Enabled</span>
                </label>
                <label className="flex min-h-8 items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={provider.offerInChat}
                    aria-label={`Provider ${String(index + 1)} offer in chat`}
                    onChange={(event) =>
                      updateProvider(index, { offerInChat: event.currentTarget.checked })
                    }
                  />
                  <span>Offer models in Assistant chat picker</span>
                </label>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="ai-providers-routing-heading"
        className="grid gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
      >
        <h2
          className="m-0 flex items-center gap-2 text-sm font-semibold"
          id="ai-providers-routing-heading"
        >
          <Shield aria-hidden="true" size={16} />
          Feature routing
        </h2>
        <p className="m-0 text-xs text-muted-foreground">
          Assign which provider and model each Helix AI feature uses. Leave provider empty to skip a
          dedicated route (fallback to shared defaults / env).
        </p>
        <div className="grid gap-3">
          {AI_FEATURE_SLOTS.map((slot) => {
            const route = editor.routes.find((entry) => entry.feature === slot.feature) ?? {
              feature: slot.feature,
              providerId: "",
              model: "",
            };
            const selected = providerOptions.find((provider) => provider.id === route.providerId);
            const modelChoices = selected
              ? selected.modelsCsv
                  .split(",")
                  .map((part) => part.trim())
                  .filter((part) => part.length > 0)
              : [];
            return (
              <div
                key={slot.feature}
                className="grid gap-2 rounded-md border border-border/80 p-3 sm:grid-cols-[1.4fr_1fr_1fr]"
              >
                <div>
                  <div className="text-xs font-semibold">{slot.label}</div>
                  <div className="text-[0.7rem] text-muted-foreground">{slot.hint}</div>
                  <code className="text-[0.65rem] text-muted-foreground">{slot.feature}</code>
                </div>
                <label className="grid gap-1 text-xs">
                  <span className="font-medium">Provider</span>
                  <select
                    aria-label={`${slot.label} provider`}
                    className="h-10 w-full rounded-md border border-border bg-background px-2 text-sm"
                    value={route.providerId}
                    onChange={(event) =>
                      updateRoute(slot.feature, { providerId: event.currentTarget.value })
                    }
                  >
                    <option value="">— not assigned —</option>
                    {providerOptions.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.displayName || provider.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs">
                  <span className="font-medium">Model</span>
                  {modelChoices.length > 0 ? (
                    <select
                      aria-label={`${slot.label} model`}
                      className="h-10 w-full rounded-md border border-border bg-background px-2 text-sm"
                      value={route.model}
                      onChange={(event) =>
                        updateRoute(slot.feature, { model: event.currentTarget.value })
                      }
                    >
                      {modelChoices.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      aria-label={`${slot.label} model`}
                      value={route.model}
                      onChange={(event) => updateRoute(slot.feature, { model: event.target.value })}
                      placeholder="model id"
                    />
                  )}
                </label>
              </div>
            );
          })}
        </div>

        <label className="grid max-w-md gap-1 text-xs">
          <span className="font-medium">Mail spam AI beta</span>
          <select
            aria-label="Mail spam AI beta mode"
            className="h-10 w-full rounded-md border border-border bg-background px-2 text-sm"
            value={editor.spamBetaMode}
            onChange={(event) => {
              /* Read the value before the updater, not inside it.
                 React nulls `currentTarget` once the handler returns, and a
                 state updater runs later — during render — so reading it in
                 there threw "Cannot read properties of null (reading 'value')"
                 whenever the update was not processed synchronously. That is
                 timing-dependent, which is exactly why this test was flaky
                 rather than simply broken. */
              const mode = event.target.value as AiProvidersEditorState["spamBetaMode"];
              setEditor((current) => ({ ...current, spamBetaMode: mode }));
            }}
          >
            <option value="env">Use environment default</option>
            <option value="on">Enabled</option>
            <option value="off">Disabled in Admin</option>
          </select>
        </label>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={saveMutation.isPending || configQuery.isPending}
          type="button"
          onClick={() => void onSave()}
        >
          <Save aria-hidden="true" />
          {saveMutation.isPending ? "Saving…" : "Save AI settings"}
        </Button>
      </div>

      <AiCatalogSummary status={configQuery.data} />
    </section>
  );
}

function AiCatalogSummary({ status }: { readonly status: PlatformConfigStatus | undefined }) {
  if (status === undefined) {
    return null;
  }
  const ai = status.config.ai;
  const providers = ai?.providers ?? [];
  const rules = ai?.routing?.rules ?? [];
  return (
    <section
      aria-labelledby="ai-providers-summary-heading"
      className="grid gap-2 rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      <h2 className="m-0 text-sm font-semibold" id="ai-providers-summary-heading">
        Saved catalog
      </h2>
      <p className="m-0 text-xs text-muted-foreground">
        {providers.length === 0
          ? "No named providers stored yet (env bootstrap only)."
          : `${String(providers.length)} provider(s), ${String(rules.length)} routing rule(s).`}
      </p>
      {providers.length === 0 ? null : (
        <ul className="m-0 grid list-none gap-1 p-0 text-xs">
          {providers.map((provider) => (
            <li
              key={provider.id}
              className="flex flex-wrap justify-between gap-2 border-b border-border/50 py-1"
            >
              <span className="font-medium">{provider.id}</span>
              <span className="text-muted-foreground">
                {provider.config?.defaultModel ?? provider.config?.model ?? "—"}
                {provider.config?.apiKeyConfigured === true ? " · key" : ""}
                {provider.enabled === false ? " · disabled" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rules.length === 0 ? null : (
        <ul className="m-0 mt-2 grid list-none gap-1 p-0 text-xs">
          {rules.map((rule) => (
            <li
              key={rule.feature}
              className="flex flex-wrap justify-between gap-2 border-b border-border/50 py-1"
            >
              <code>{rule.feature}</code>
              <span className="text-muted-foreground">
                {rule.primary.providerId}
                {rule.primary.model ? ` / ${rule.primary.model}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
