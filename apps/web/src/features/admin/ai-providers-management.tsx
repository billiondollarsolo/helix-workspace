/**
 * Admin › AI providers — named LLM providers + per-feature routing.
 *
 * Operators configure one or more OpenAI-compatible providers, then assign
 * which provider/model each product slot uses (Assistant chat, mail spam AI,
 * mail compose assist). Chat can offer multiple models via the `assistant` tag.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AiProviderForm } from "./ai-provider-form";
import { AdminTable } from "./console/table";
import { AdminInput, AdminSelect, AdminToolbar } from "./console/controls";
import { Dialog } from "@/components/ui/helix-dialog";
import { Plus, Save, Shield, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useServerSeededDraft } from "@/lib/use-server-seeded-draft";
import {
  PanelHeading,
  ErrorNotice,
  LoadingState,
  Notice,
} from "@/features/admin/console/primitives";
import {
  adminPlatformConfigQueryKey,
  adminPlatformConfigQueryOptions,
  updatePlatformAiSettings,
} from "@/features/admin/tier-readiness/api";
import type { PlatformConfigPatch } from "./tier-readiness/types";
import {
  providerSupportsFeature,
  AI_FEATURE_SLOTS,
  buildMultiProviderAiPatch,
  editorStateFromAiConfig,
  emptyProviderRow,
  parseModelsCsv,
  editableProvider,
  providerProtocolLabel,
  type AiFeatureSlotId,
  type AiProvidersEditorState,
  type FeatureRouteFormRow,
  type ProviderFormRow,
} from "./ai-providers-config";

export function AIProvidersManagement() {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<ProviderFormRow | null>(null);
  const [removing, setRemoving] = useState<ProviderFormRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const configQuery = useQuery(adminPlatformConfigQueryOptions());
  /* Refetches (realtime config events, another section's save) must not wipe
     unsaved edits. `baseline` is the config the edit started from, so fields
     left untouched are not sent back over someone else's newer value. */
  const {
    draft: editor,
    setDraft: setEditor,
    baseline,
    markSaved,
  } = useServerSeededDraft(
    configQuery.data === undefined ? undefined : (configQuery.data.config.ai ?? null),
    (ai) => editorStateFromAiConfig(ai ?? undefined),
  );

  const saveMutation = useMutation({
    mutationFn: (ai: NonNullable<PlatformConfigPatch["ai"]>) => updatePlatformAiSettings(ai),
    onMutate: () => {
      setFormError(null);
      setSavedNotice(null);
    },
    onSuccess: async (status) => {
      queryClient.setQueryData(adminPlatformConfigQueryKey, status);
      await queryClient.invalidateQueries({ queryKey: adminPlatformConfigQueryKey });
      await queryClient.invalidateQueries({ queryKey: ["assistant"] });
      setSavedNotice("Saved. AI settings now apply to new requests.");
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : "Failed to save AI settings.");
    },
  });

  const providerOptions = useMemo(
    () => editor.providers.filter((provider) => provider.enabled && provider.id.trim().length > 0),
    [editor.providers],
  );

  const openProvider = (provider: ProviderFormRow, isNew = false) => {
    setFormError(null);
    setCreating(isNew);
    setEditing(provider);
  };
  const removeProvider = async (provider: ProviderFormRow) => {
    const providers = editor.providers.filter((row) => row.rowKey !== provider.rowKey);
    const fallback = providers.find((row) => row.enabled);
    const next = {
      ...editor,
      providers,
      routes: editor.routes.map((route) =>
        route.providerId === provider.id
          ? {
              ...route,
              providerId: route.feature.startsWith("meet.") ? "" : (fallback?.id ?? ""),
              model: route.feature.startsWith("meet.") ? "" : (fallback?.defaultModel ?? ""),
            }
          : route,
      ),
    };
    if (await onSave(next)) setRemoving(null);
  };
  const saveProvider = async (provider: ProviderFormRow) => {
    const next = {
      ...editor,
      providers: creating
        ? [...editor.providers, provider]
        : editor.providers.map((row) => (row.rowKey === provider.rowKey ? provider : row)),
      routes: editor.routes.map((route) =>
        route.providerId === provider.id &&
        !route.feature.startsWith("meet.") &&
        !parseModelsCsv(provider.modelsCsv).includes(route.model)
          ? { ...route, model: provider.defaultModel }
          : route,
      ),
    };
    if (await onSave(next)) setEditing(null);
  };

  const updateRoute = (feature: AiFeatureSlotId, patch: Partial<FeatureRouteFormRow>) => {
    setEditor((current) => ({
      ...current,
      routes: current.routes.map((route) =>
        route.feature === feature ? { ...route, ...patch } : route,
      ),
    }));
  };

  const onSave = async (submitted = editor): Promise<boolean> => {
    const patch = buildMultiProviderAiPatch(submitted, baseline);
    if (typeof patch === "string") {
      setFormError(patch);
      return false;
    }
    setFormError(null);
    try {
      await saveMutation.mutateAsync(patch);
      markSaved(editor);
      return true;
    } catch {
      return false;
    }
  };

  return (
    <section className="grid gap-4">
      <PanelHeading
        title="Models"
        subtitle="Model providers, and which model each Assistant feature uses."
      />

      {configQuery.isPending ? <LoadingState label="Loading AI configuration…" /> : null}
      {configQuery.isError ? (
        <ErrorNotice>
          {configQuery.error instanceof Error
            ? configQuery.error.message
            : "Could not load platform configuration."}
        </ErrorNotice>
      ) : null}
      {formError !== null && editing === null && removing === null ? (
        <ErrorNotice>{formError}</ErrorNotice>
      ) : null}
      {savedNotice !== null ? <Notice>{savedNotice}</Notice> : null}

      <section aria-label="Provider catalog" className="admin-stack">
        <AdminToolbar label="Provider filters">
          <AdminInput
            type="search"
            className="min-w-0 flex-1"
            aria-label="Search providers"
            placeholder="Search providers or models…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className="admin-muted">{editor.providers.length} providers</span>
          <Button
            type="button"
            size="sm"
            disabled={
              configQuery.isPending ||
              configQuery.isError ||
              editing !== null ||
              saveMutation.isPending
            }
            onClick={() => openProvider(emptyProviderRow(editor.providers.length), true)}
          >
            <Plus aria-hidden="true" />
            Add provider
          </Button>
        </AdminToolbar>
        <p className="admin-muted">
          OpenAI-compatible and Anthropic endpoints. Keys stay private after saving. Cloud-managed
          providers keep their deployment configuration.
        </p>
        <AdminTable<ProviderFormRow>
          label="AI providers"
          rows={editor.providers.filter((provider) =>
            `${provider.displayName} ${provider.id} ${provider.modelsCsv}`
              .toLowerCase()
              .includes(search.toLowerCase().trim()),
          )}
          rowKey={(row) => row.rowKey ?? row.id}
          empty={
            search
              ? "No providers match your search."
              : "No providers yet. Add a provider to enable workspace AI."
          }
          columns={[
            {
              id: "name",
              header: "Provider",
              sortValue: (row) => row.displayName || row.id,
              cell: (row) => (
                <div>
                  <strong>{row.displayName || row.id}</strong>
                  <div className="admin-muted">{row.id}</div>
                </div>
              ),
            },
            { id: "protocol", header: "Connection", cell: (row) => providerProtocolLabel(row) },
            {
              id: "models",
              header: "Models",
              sortValue: (row) => parseModelsCsv(row.modelsCsv).length,
              cell: (row) => (
                <div>
                  {row.defaultModel}
                  <div className="admin-muted">
                    {parseModelsCsv(row.modelsCsv).length} available ·{" "}
                    {row.offerInChat ? "Assistant" : "Backend only"}
                  </div>
                </div>
              ),
            },
            {
              id: "status",
              header: "Status",
              sortValue: (row) => (row.enabled ? 1 : 0),
              cell: (row) => (
                <span className={`chip ${row.enabled ? "success" : "warning"}`}>
                  {row.enabled ? "Enabled" : "Disabled"}
                </span>
              ),
            },
            {
              id: "key",
              header: "API key",
              cell: (row) => (row.apiKeyConfigured ? "Stored" : "Deployment / none"),
            },
            {
              id: "actions",
              header: "Actions",
              headerHidden: true,
              cell: (row) => (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`Edit provider ${row.id}`}
                    disabled={!editableProvider(row) || editing !== null || saveMutation.isPending}
                    onClick={() => openProvider(row)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove provider ${row.id}`}
                    disabled={
                      editor.providers.length < 2 || editing !== null || saveMutation.isPending
                    }
                    onClick={() => {
                      setFormError(null);
                      setRemoving(row);
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </section>
      {editing !== null ? (
        <AiProviderForm
          initial={editing}
          creating={creating}
          pending={saveMutation.isPending}
          error={formError}
          onClose={() => {
            if (!saveMutation.isPending) {
              setEditing(null);
              setFormError(null);
            }
          }}
          onSubmit={saveProvider}
        />
      ) : null}
      {removing !== null ? (
        <Dialog
          title="Remove provider?"
          onClose={() => {
            if (!saveMutation.isPending) setRemoving(null);
          }}
          footer={
            <>
              <Button
                variant="outline"
                disabled={saveMutation.isPending}
                onClick={() => setRemoving(null)}
              >
                Cancel
              </Button>
              <Button
                disabled={saveMutation.isPending}
                onClick={() => void removeProvider(removing)}
              >
                Remove provider
              </Button>
            </>
          }
        >
          <p>
            Remove {removing.displayName || removing.id}? Its feature routes will use the next
            enabled provider’s default model, except meeting routes, which are cleared. This also
            saves pending routing settings.
          </p>
          {formError ? <ErrorNotice>{formError}</ErrorNotice> : null}
        </Dialog>
      ) : null}

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
          dedicated route (fallback to shared defaults / env). Meeting features require explicit
          assignments and remain off when unassigned.
        </p>
        <div className="grid gap-3">
          {AI_FEATURE_SLOTS.map((slot) => {
            const route = editor.routes.find((entry) => entry.feature === slot.feature) ?? {
              feature: slot.feature,
              providerId: "",
              model: "",
            };
            const routeProviders = providerOptions.filter((provider) =>
              providerSupportsFeature(provider, slot.feature),
            );
            const selected = routeProviders.find((provider) => provider.id === route.providerId);
            const modelChoices = selected ? parseModelsCsv(selected.modelsCsv) : [];
            return (
              <div
                key={slot.feature}
                className="grid gap-2 rounded-md border border-border/80 p-3 sm:grid-cols-[1.4fr_1fr_1fr]"
              >
                <div>
                  <div className="text-xs font-semibold">{slot.label}</div>
                  <div className="type-caption text-muted-foreground">{slot.hint}</div>
                </div>
                <label className="grid gap-1 text-xs">
                  <span className="font-medium">Provider</span>
                  <AdminSelect
                    aria-label={`${slot.label} provider`}
                    value={route.providerId}
                    onChange={(event) =>
                      updateRoute(slot.feature, {
                        providerId: event.currentTarget.value,
                        model:
                          providerOptions.find(
                            (provider) => provider.id === event.currentTarget.value,
                          )?.defaultModel ?? "",
                      })
                    }
                  >
                    <option value="">— not assigned —</option>
                    {routeProviders.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.displayName || provider.id}
                      </option>
                    ))}
                  </AdminSelect>
                </label>
                <label className="grid gap-1 text-xs">
                  <span className="font-medium">Model</span>
                  {modelChoices.length > 0 ? (
                    <AdminSelect
                      aria-label={`${slot.label} model`}
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
                    </AdminSelect>
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
          <AdminSelect
            aria-label="Mail spam AI beta mode"
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
            <option value="env">Use the deployment default</option>
            <option value="on">Enabled</option>
            <option value="off">Disabled in Admin</option>
          </AdminSelect>
        </label>
      </section>

      <section
        aria-labelledby="assistant-tool-settings-heading"
        className="grid gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
      >
        <h2 id="assistant-tool-settings-heading" className="m-0 text-sm font-semibold">
          Assistant tool use
        </h2>
        <label className="grid max-w-xs gap-1 text-xs">
          <span className="font-medium">Maximum tool steps per reply</span>
          <Input
            type="number"
            min={1}
            max={256}
            step={1}
            value={editor.maxToolRounds}
            onChange={(event) => {
              const maxToolRounds = event.target.value;
              setEditor((current) => ({ ...current, maxToolRounds }));
            }}
            aria-describedby="assistant-tool-steps-help"
          />
        </label>
        <p id="assistant-tool-steps-help" className="m-0 text-xs text-muted-foreground">
          Default 128. A step lets the model call tools and inspect their results before continuing.
          Higher limits allow longer research and use more time and model tokens. At the limit,
          Assistant summarizes what it found. Changes apply to new replies after saving.
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={
            saveMutation.isPending ||
            configQuery.isPending ||
            configQuery.isError ||
            editing !== null
          }
          type="button"
          onClick={() => void onSave()}
        >
          <Save aria-hidden="true" />
          {saveMutation.isPending ? "Saving…" : "Save AI settings"}
        </Button>
      </div>
    </section>
  );
}
