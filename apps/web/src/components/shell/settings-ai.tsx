import { cn } from "@/lib/utils";
import { useState, type ReactNode } from "react";
import {
  SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE,
  SettingsField,
  ToggleRow,
  UNAVAILABLE_CONTROL_PROPS,
  UnavailableSettingsButton,
} from "./settings-controls";

/* ---------- Helix AI (provider config) ---------- */

interface AiProvider {
  id: string;
  name: string;
  desc: string;
  needsKey: boolean;
  host?: string;
  placeholder?: string;
}

const AI_PROVIDERS: readonly AiProvider[] = [
  {
    id: "helix",
    name: "Helix AI (managed)",
    desc: "Default. Uses our hosted models — Helix Pro, Fast, Reason.",
    needsKey: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    desc: "Use your own OpenAI API key. Routes all AI features through OpenAI.",
    needsKey: true,
    host: "api.openai.com/v1",
    placeholder: "For example, sk-…",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    desc: "Use your own Anthropic API key. Routes all AI features through Claude.",
    needsKey: true,
    host: "api.anthropic.com/v1",
    placeholder: "For example, sk-ant-…",
  },
  {
    id: "google",
    name: "Google Gemini",
    desc: "Use your own Google AI API key.",
    needsKey: true,
    host: "generativelanguage.googleapis.com",
    placeholder: "For example, AIza…",
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    desc: "Enterprise — point at your own Azure OpenAI deployment.",
    needsKey: true,
    host: "your-resource.openai.azure.com",
    placeholder: "Azure deployment URL",
  },
  {
    id: "custom",
    name: "Custom endpoint",
    desc: "Self-hosted or third-party endpoint (OpenAI-compatible API).",
    needsKey: true,
    host: "https://your-endpoint",
    placeholder: "Bearer token or API key",
  },
];

/* Model ids offered per bring-your-own-key provider. Providers absent from
   this map (custom endpoints) fall back to the generic placeholder. */
const AI_PROVIDER_MODELS: Readonly<Record<string, readonly string[]>> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o3", "o4-mini"],
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  azure: ["(your deployment names)"],
};

function AiModelOptions({ provider }: { provider: string }) {
  const models = AI_PROVIDER_MODELS[provider] ?? ["(your model id)"];
  return (
    <>
      {models.map((model) => (
        <option key={model}>{model}</option>
      ))}
    </>
  );
}

function PrivacyCheckbox({
  name,
  label,
  desc,
  defaultChecked = false,
}: {
  name: string;
  label: string;
  desc: ReactNode;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-start gap-2.5 [font-size:var(--text-meta)] cursor-pointer">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        {...UNAVAILABLE_CONTROL_PROPS}
        className="[accent-color:var(--accent)] mt-0.5"
      />
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-muted-foreground mt-0.5">{desc}</div>
      </div>
    </label>
  );
}

export function AISection() {
  const [provider, setProvider] = useState("helix");

  const selected = AI_PROVIDERS.find((p) => p.id === provider) ?? AI_PROVIDERS[0]!;

  const features = [
    {
      label: "Smart compose in Mail",
      desc: "Inline writing suggestions and draft replies",
      on: true,
    },
    {
      label: "Meeting summaries in Meet",
      desc: "Post-call recap with action items",
      on: true,
    },
    { label: "Smart replies in Chat", desc: "Suggested replies in DMs and spaces", on: false },
  ];

  return (
    <>
      <h1 className="[font-size:var(--text-h2)] font-semibold [margin:0_0_4px]">Helix AI</h1>
      <div className="[font-size:var(--text-body-sm)] text-muted-foreground mb-2">
        Connect Helix AI to your preferred model provider
      </div>

      <SettingsField label="Provider" hint="Where AI requests are sent">
        <div className="grid gap-1.5">
          {AI_PROVIDERS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setProvider(option.id)}
              aria-pressed={provider === option.id}
              aria-description={SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE}
              title={SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE}
              disabled
              className={cn(
                "flex gap-3 [padding:10px_12px] text-left rounded-lg cursor-pointer",
                provider === option.id
                  ? "[background:var(--accent-soft)] [border:1px_solid_var(--accent)]"
                  : "bg-card [border:1px_solid_var(--border)]",
              )}
            >
              <span
                className={cn(
                  "w-4 h-4 [border-radius:999px] mt-0.5 shrink-0",
                  provider === option.id
                    ? "[background:var(--accent)] [border:5px_solid_var(--accent)]"
                    : "bg-transparent [border:5px_solid_var(--border-2)]",
                  provider === option.id
                    ? "[box-shadow:inset_0_0_0_3px_var(--surface)]"
                    : "[box-shadow:inset_0_0_0_4px_var(--surface)]",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="[font-size:var(--text-body-sm)] font-semibold">{option.name}</div>
                <div className="[font-size:var(--text-caption)] text-muted-foreground mt-0.5">
                  {option.desc}
                </div>
              </div>
            </button>
          ))}
        </div>
      </SettingsField>

      {selected.needsKey ? (
        <>
          <SettingsField
            label="Endpoint"
            hint="Base URL for API requests"
            controlId="settings-ai-endpoint"
          >
            <input
              id="settings-ai-endpoint"
              name="aiEndpoint"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              className="input mono"
              defaultValue={selected.host}
              {...UNAVAILABLE_CONTROL_PROPS}
            />
          </SettingsField>
          <SettingsField
            label="API key"
            hint="Stored encrypted. Never sent to Helix servers."
            controlId="settings-ai-api-key"
          >
            <div className="flex gap-2">
              <input
                id="settings-ai-api-key"
                name="aiApiKey"
                className="input mono flex-1"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={selected.placeholder}

                {...UNAVAILABLE_CONTROL_PROPS}
              />
              <UnavailableSettingsButton className="btn">Test Connection</UnavailableSettingsButton>
            </div>
          </SettingsField>
          <SettingsField label="Default model" controlId="settings-ai-model">
            <select
              id="settings-ai-model"
              name="aiModel"
              className="select"
              {...UNAVAILABLE_CONTROL_PROPS}
            >
              <AiModelOptions provider={provider} />
            </select>
          </SettingsField>
        </>
      ) : (
        <SettingsField label="Default model" controlId="settings-ai-model">
          <select
            id="settings-ai-model"
            name="aiModel"
            className="select"
            {...UNAVAILABLE_CONTROL_PROPS}
          >
            <option>Helix Pro — best for analysis and writing</option>
            <option>Helix Fast — quick responses, lower cost</option>
            <option>Helix Reason — multi-step reasoning + planning</option>
          </select>
        </SettingsField>
      )}

      <SettingsField label="Features" hint="Where AI can be used across the workspace">
        {features.map((feature, index) => (
          <ToggleRow
            key={feature.label}
            label={feature.label}
            desc={feature.desc}
            defaultOn={feature.on}
            className={cn(
              "[padding:10px_0]",
              index ? "[border-top:1px_solid_var(--border)]" : "[border-top:none]",
            )}
          />
        ))}
      </SettingsField>

      <SettingsField label="Privacy" hint="Control what data is shared with the provider">
        <div className="grid gap-2">
          <PrivacyCheckbox
            name="aiWorkspaceContext"
            defaultChecked
            label="Use my workspace content for context"
            desc="Mail and files referenced in prompts."
          />
          <PrivacyCheckbox
            name="aiProviderTraining"
            label="Allow provider to train on my data"
            desc={<>Off by default. Most providers don&apos;t train on enterprise data anyway.</>}
          />
        </div>
      </SettingsField>
    </>
  );
}
