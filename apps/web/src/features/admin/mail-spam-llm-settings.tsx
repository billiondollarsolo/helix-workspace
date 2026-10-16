import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useServerSeededDraft } from "@/lib/use-server-seeded-draft";
import { AdminField, AdminSelect } from "./console/controls";
import { ErrorNotice, Notice, PanelHeading } from "./console/primitives";
import { SettingToggle } from "./console/widgets";
import {
  adminPlatformConfigQueryOptions,
  adminPlatformConfigQueryKey,
  updatePlatformAiSettings,
} from "./tier-readiness/api";
import { mailAdminQueryKeys } from "./mail-admin-api";

/** The legacy LLM pass has its own route; it never borrows Clef/Jev credentials. */
export function MailSpamLlmSettings({ enabled }: { readonly enabled: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();
  const query = useQuery(adminPlatformConfigQueryOptions());
  const { draft, setDraft, markSaved } = useServerSeededDraft(query.data?.config.ai, (ai) => {
    const route = ai?.routing?.rules?.find((rule) => rule.feature === "mail.spam-ai");
    return {
      enabled: ai?.mailSpamAi?.betaEnabled ?? enabled,
      providerId: route?.primary.providerId ?? "",
      model: route?.primary.model ?? "",
    };
  });
  const providers =
    query.data?.config.ai?.providers?.filter(
      (provider) => provider.enabled !== false && provider.plugin.includes("openai-compat"),
    ) ?? [];
  const provider = providers.find((row) => row.id === draft.providerId);
  const models = [
    ...new Set(
      [
        provider?.config?.defaultModel ?? provider?.config?.model ?? "",
        ...(provider?.config?.models ?? []),
      ].filter((model) => typeof model === "string" && model.length > 0),
    ),
  ];
  const save = useMutation({
    onMutate: () => setError(null),
    onError: (error: Error) => setError(error.message),
    mutationFn: async () => {
      if (draft.enabled && (!provider || !models.includes(draft.model)))
        throw new Error(
          "Choose a configured provider and model before enabling the LLM spam pass.",
        );
      const rules =
        query.data?.config.ai?.routing?.rules?.filter((rule) => rule.feature !== "mail.spam-ai") ??
        [];
      return updatePlatformAiSettings({
        mailSpamAi: { betaEnabled: draft.enabled },
        routing: {
          rules: [
            ...rules,
            ...(provider
              ? [
                  {
                    feature: "mail.spam-ai",
                    primary: { providerId: provider.id, model: draft.model || models[0] },
                  },
                ]
              : []),
          ],
        },
      });
    },
    onSuccess: async (status) => {
      client.setQueryData(adminPlatformConfigQueryKey, status);
      markSaved(draft);
      await client.invalidateQueries({ queryKey: mailAdminQueryKeys.spam() });
    },
  });
  return (
    <section className="admin-stack" aria-label="LLM spam second pass">
      <PanelHeading
        title="LLM spam second pass (beta)"
        subtitle="An optional, separate pass after SpamAssassin. Clef/Jev configuration above does not enable this pass."
      />
      <p className="admin-muted">
        This pass can file high-confidence spam in Spam; it does not have a shadow mode. Provider
        failures keep the rule-based result. Classified content stays local. Use the decision
        model’s shadow mode first to evaluate classification quality.
      </p>
      {query.isError ? <ErrorNotice>{query.error.message}</ErrorNotice> : null}
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      {save.isSuccess ? <Notice>LLM spam settings saved.</Notice> : null}
      <form
        className="admin-stack"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <fieldset
          disabled={query.isPending || query.isError || save.isPending}
          className="m-0 grid min-w-0 gap-3 border-0 p-0"
        >
          <SettingToggle
            label="Enable LLM spam second pass"
            checked={draft.enabled}
            onCheckedChange={(value) => setDraft((current) => ({ ...current, enabled: value }))}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <AdminField label="Spam LLM provider">
              <AdminSelect
                value={draft.providerId}
                onChange={(event) => {
                  const providerId = event.target.value;
                  const selected = providers.find((row) => row.id === providerId);
                  setDraft((current) => ({
                    ...current,
                    providerId,
                    model:
                      selected?.config?.defaultModel ??
                      selected?.config?.model ??
                      selected?.config?.models?.[0] ??
                      "",
                  }));
                }}
              >
                <option value="">Select a provider</option>
                {providers.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.config?.displayName || row.id}
                  </option>
                ))}
              </AdminSelect>
            </AdminField>
            <AdminField label="Spam LLM model">
              <AdminSelect
                value={draft.model}
                onChange={(event) => {
                  const model = event.target.value;
                  setDraft((current) => ({ ...current, model }));
                }}
              >
                <option value="">Select a model</option>
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </AdminSelect>
            </AdminField>
          </div>
          <p className="admin-muted">
            Manage endpoint credentials in Admin → Assistant → Models. This pass requires an
            OpenAI-compatible endpoint and uses its own model assignment.
          </p>
          <div>
            <Button type="submit">{save.isPending ? "Saving…" : "Save LLM spam settings"}</Button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
