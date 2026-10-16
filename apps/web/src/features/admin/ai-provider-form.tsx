import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormPanel } from "@/components/ui/form-panel";
import { AdminField, AdminInput, AdminSelect } from "./console/controls";
import { AdminTable } from "./console/table";
import { ErrorNotice } from "./console/primitives";
import { SettingToggle } from "./console/widgets";
import { parseModelsCsv, type ProviderFormRow } from "./ai-providers-config";

export function AiProviderForm({
  initial,
  creating,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  readonly initial: ProviderFormRow;
  readonly creating: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onSubmit: (provider: ProviderFormRow) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [model, setModel] = useState("");
  const [modelError, setModelError] = useState<string | null>(null);
  const models = [
    ...new Set([draft.defaultModel, ...parseModelsCsv(draft.modelsCsv)].filter(Boolean)),
  ];
  const update = (patch: Partial<ProviderFormRow>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const addModel = () => {
    const id = model.trim();
    if (!id || id.includes(",") || models.includes(id)) {
      setModelError("Enter one unique model ID from your provider.");
      return;
    }
    update({ modelsCsv: [...models, id].join(", "), defaultModel: draft.defaultModel || id });
    setModel("");
    setModelError(null);
  };
  return (
    <FormPanel
      title={creating ? "Add AI provider" : `Edit ${initial.displayName || initial.id}`}
      onClose={onClose}
    >
      <form
        className="admin-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending) void onSubmit(draft);
        }}
      >
        <fieldset className="m-0 grid min-w-0 gap-4 border-0 p-0" disabled={pending}>
          {error ? <ErrorNotice>{error}</ErrorNotice> : null}
          <AdminField label="Connection type">
            <AdminSelect
              value={draft.plugin?.includes("anthropic") ? "anthropic" : "openai"}
              disabled={!creating}
              onChange={(event) => {
                const anthropic = event.target.value === "anthropic";
                update({
                  plugin: `com.helix.ai-provider-${anthropic ? "anthropic" : "openai"}-compat@^1.0.0`,
                  baseUrl: anthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1",
                  modelsCsv: "",
                  defaultModel: "",
                });
              }}
            >
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
            </AdminSelect>
          </AdminField>
          {draft.plugin?.includes("anthropic") ? (
            <p className="admin-muted">
              Native Anthropic currently supports text chat. Workspace tool calling requires an
              OpenAI-compatible connection.
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <AdminField label="Display name">
              <AdminInput
                required
                value={draft.displayName}
                onChange={(event) => update({ displayName: event.target.value })}
              />
            </AdminField>
            <AdminField label="Provider ID">
              <AdminInput
                required
                disabled={!creating}
                value={draft.id}
                onChange={(event) => update({ id: event.target.value })}
                aria-describedby="ai-provider-id-help"
              />
            </AdminField>
          </div>
          <p id="ai-provider-id-help" className="admin-muted">
            The stable ID links routing and stored credentials. It cannot change after saving.
          </p>
          <AdminField label="Base URL">
            <AdminInput
              type="url"
              required
              value={draft.baseUrl}
              onChange={(event) => update({ baseUrl: event.target.value })}
            />
          </AdminField>
          <AdminField label="Processing region">
            <AdminInput
              value={draft.region ?? ""}
              onChange={(event) => update({ region: event.target.value })}
              aria-describedby="ai-provider-region-help"
            />
          </AdminField>
          <p id="ai-provider-region-help" className="admin-muted">
            Optional for development. Regional production deployments require a matching endpoint
            and processing region.
          </p>
          <AdminField label="API key">
            <AdminInput
              type="password"
              autoComplete="new-password"
              value={draft.apiKey}
              onChange={(event) => update({ apiKey: event.target.value })}
              aria-describedby="ai-provider-key-help"
            />
          </AdminField>
          <p id="ai-provider-key-help" className="admin-muted">
            {draft.apiKeyConfigured
              ? "A key is stored. Leave blank to keep it."
              : "Enter a key, or leave blank if this endpoint uses deployment credentials or needs no key."}
          </p>
          <section className="admin-stack" aria-label="Provider models">
            <AdminTable<string>
              label="Provider models"
              rows={models}
              rowKey={(id) => id}
              empty="Add a model ID offered by this provider."
              columns={[
                { id: "model", header: "Model ID", sortValue: (id) => id, cell: (id) => id },
                {
                  id: "default",
                  header: "Default",
                  cell: (id) =>
                    id === draft.defaultModel ? <span className="chip accent">Default</span> : "—",
                },
                {
                  id: "actions",
                  header: "Actions",
                  headerHidden: true,
                  cell: (id) => (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={id === draft.defaultModel}
                      aria-label={`Remove model ${id}`}
                      onClick={() =>
                        update({ modelsCsv: models.filter((entry) => entry !== id).join(", ") })
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  ),
                },
              ]}
            />
            <div className="flex flex-wrap items-end gap-2">
              <AdminField label="Model ID">
                <AdminInput
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addModel();
                    }
                  }}
                  aria-invalid={modelError !== null}
                  aria-describedby="ai-model-help"
                />
              </AdminField>
              <Button type="button" variant="outline" onClick={addModel}>
                <Plus aria-hidden="true" />
                Add model
              </Button>
            </div>
            <p id="ai-model-help" className="admin-muted">
              Use the exact model ID available to your account. Choose another default before
              removing the current one.
            </p>
            {modelError ? <ErrorNotice>{modelError}</ErrorNotice> : null}
            <AdminField label="Default model">
              <AdminSelect
                required
                value={draft.defaultModel}
                onChange={(event) => update({ defaultModel: event.target.value })}
              >
                <option value="" disabled>
                  Select a model
                </option>
                {models.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </AdminSelect>
            </AdminField>
          </section>
          {!draft.plugin?.includes("anthropic") ? (
            <div className="admin-stack">
              <SettingToggle
                label="Supports realtime speech transcription"
                checked={draft.realtimeTranscription === true}
                onCheckedChange={(realtimeTranscription) => update({ realtimeTranscription })}
              />
              <p className="admin-muted">
                Enable only for an endpoint implementing OpenAI’s realtime transcription protocol.
                Add its speech model IDs above, then assign Meeting transcription separately. Chat
                API compatibility alone is insufficient.
              </p>
            </div>
          ) : null}
          <SettingToggle
            label="Enabled"
            checked={draft.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
          />
          <SettingToggle
            label="Offer models in Assistant"
            checked={draft.offerInChat}
            onCheckedChange={(offerInChat) => update({ offerInChat })}
          />
          <p className="admin-muted">Saving also applies pending feature routing settings.</p>
          <div className="flex gap-2">
            <Button type="submit">{pending ? "Saving…" : "Save provider"}</Button>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </fieldset>
      </form>
    </FormPanel>
  );
}
