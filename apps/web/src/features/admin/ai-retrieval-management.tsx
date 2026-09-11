import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminAiRelatedNav } from "./admin-related-nav";
import { PageHeading, StateBanner } from "./console/primitives";
import {
  testAIRetrieval,
  aiRetrievalStatusQueryOptions,
  reindexJobQueryOptions,
  startAIRetrievalReindex,
  cancelAIRetrievalReindex,
} from "./ai-retrieval-api";
import {
  adminPlatformConfigQueryKey,
  adminPlatformConfigQueryOptions,
  updatePlatformAiSettings,
} from "./tier-readiness/api";
import type { AIConfigStatus, PlatformConfigPatch } from "./tier-readiness/types";

interface RetrievalDraft {
  vectorEnabled: boolean;
  vectorPlugin: "pgvector" | "qdrant";
  vectorUrl: string;
  vectorKey: string;
  clearVectorKey: boolean;
  embeddingUrl: string;
  embeddingModel: string;
  dimensions: string;
  chunkSize: string;
  chunkOverlap: string;
  embeddingKey: string;
  clearEmbeddingKey: boolean;
  webEnabled: boolean;
  webProvider: "brave" | "searxng";
  webUrl: string;
  webKey: string;
  clearWebKey: boolean;
  maxResults: string;
}

function draftFromConfig(ai?: AIConfigStatus): RetrievalDraft {
  return {
    vectorEnabled: ai?.vectorStore?.config.enabled === true,
    vectorPlugin: ai?.vectorStore?.plugin ?? "pgvector",
    vectorUrl: ai?.vectorStore?.config.baseUrl ?? "",
    vectorKey: "",
    clearVectorKey: false,
    embeddingUrl: ai?.embeddingProvider?.config.baseUrl ?? "",
    embeddingModel: ai?.embeddingProvider?.config.defaultModel ?? "",
    dimensions: String(ai?.embeddingProvider?.config.dimensions ?? ""),
    chunkSize: String(ai?.embeddingProvider?.config.maxInputChars ?? 1024),
    chunkOverlap: String(
      ai?.embeddingProvider?.config.chunkOverlapChars ??
        Math.floor((ai?.embeddingProvider?.config.maxInputChars ?? 1024) * 0.15),
    ),
    embeddingKey: "",
    clearEmbeddingKey: false,
    webEnabled: ai?.webSearch?.enabled === true,
    webProvider: ai?.webSearch?.provider ?? "brave",
    webUrl: ai?.webSearch?.baseUrl ?? "",
    webKey: "",
    clearWebKey: false,
    maxResults: String(ai?.webSearch?.maxResults ?? 5),
  };
}

function keyPatch(value: string, clear: boolean) {
  return clear ? { apiKey: null } : value.trim() ? { apiKey: value.trim() } : {};
}

function retrievalPatch(draft: RetrievalDraft): NonNullable<PlatformConfigPatch["ai"]> {
  return {
    vectorStore: {
      plugin: draft.vectorPlugin,
      config: {
        enabled: draft.vectorEnabled,
        ...(draft.vectorPlugin === "qdrant"
          ? { baseUrl: draft.vectorUrl.trim(), ...keyPatch(draft.vectorKey, draft.clearVectorKey) }
          : { apiKey: null }),
      },
    },
    ...(draft.embeddingUrl.trim() || draft.embeddingModel.trim() || draft.vectorEnabled
      ? {
          embeddingProvider: {
            plugin: "openai-compat",
            config: {
              baseUrl: draft.embeddingUrl.trim(),
              defaultModel: draft.embeddingModel.trim(),
              dimensions: Number(draft.dimensions),
              maxInputChars: Number(draft.chunkSize),
              chunkOverlapChars: Number(draft.chunkOverlap),
              ...keyPatch(draft.embeddingKey, draft.clearEmbeddingKey),
            },
          },
        }
      : {}),
    webSearch: {
      enabled: draft.webEnabled,
      provider: draft.webProvider,
      ...(draft.webProvider === "searxng" ? { baseUrl: draft.webUrl.trim() } : {}),
      maxResults: Number(draft.maxResults),
      ...keyPatch(draft.webKey, draft.clearWebKey),
    },
  };
}

function SecretInput({
  label,
  value,
  clear,
  configured,
  onChange,
  onClear,
}: {
  readonly label: string;
  readonly value: string;
  readonly clear: boolean;
  readonly configured: boolean;
  readonly onChange: (value: string) => void;
  readonly onClear: (value: boolean) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="grid gap-1 text-sm">
        {label}
        <Input
          type="password"
          autoComplete="new-password"
          value={value}
          disabled={clear}
          placeholder={configured ? "Stored key — leave blank to keep" : "API key"}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {configured ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={clear}
            onChange={(event) => onClear(event.target.checked)}
          />
          Clear stored {label.toLowerCase()}
        </label>
      ) : null}
    </div>
  );
}

export function AIRetrievalManagement() {
  const queryClient = useQueryClient();
  const configQuery = useQuery({ ...adminPlatformConfigQueryOptions(), throwOnError: false });
  // A null draft follows the shared cache; editing takes a snapshot that refetches cannot erase.
  const runtime = useQuery(aiRetrievalStatusQueryOptions());
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useQuery(reindexJobQueryOptions(jobId));
  // eslint-disable-next-line helix/mutation-discipline -- Durable jobs are server-owned; render mutation errors without optimistic updates.
  const reindex = useMutation({
    mutationFn: startAIRetrievalReindex,
    onSuccess: (result) => {
      queryClient.setQueryData(reindexJobQueryOptions(result.id).queryKey, result);
      setJobId(result.id);
    },
  });
  // eslint-disable-next-line helix/mutation-discipline -- Cancellation is acknowledged by the server; errors remain inline.
  const cancel = useMutation({
    mutationFn: cancelAIRetrievalReindex,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reindexJobQueryOptions(jobId).queryKey });
    },
  });
  const jobRunning =
    jobId !== null && !["completed", "dead_lettered", "cancelled"].includes(job.data?.status ?? "");
  const [draft, setDraft] = useState<RetrievalDraft | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const ai = configQuery.data?.config.ai;
  const current = draft ?? draftFromConfig(ai);
  const dirty = draft !== null;
  // eslint-disable-next-line helix/mutation-discipline -- Keep the dirty draft until a successful server response; errors are rendered below.
  const save = useMutation({
    mutationFn: updatePlatformAiSettings,
    onSuccess: (status) => {
      queryClient.setQueryData(adminPlatformConfigQueryKey, status);
      setDraft(null);
      setSavedNotice(true);
      void queryClient.invalidateQueries({ queryKey: ["admin", "ai-retrieval"] });
      void queryClient.invalidateQueries({ queryKey: ["assistant", "models"] });
    },
  });
  // eslint-disable-next-line helix/mutation-discipline -- This read-only probe has no optimistic state; render its result or error.
  const connection = useMutation({ mutationFn: testAIRetrieval });
  function change<K extends keyof RetrievalDraft>(key: K, value: RetrievalDraft[K]) {
    setDraft({ ...current, [key]: value });
    setSavedNotice(false);
    save.reset();
    connection.reset();
  }
  const selectClass = "h-10 w-full rounded-md border border-border bg-background px-2 text-sm";
  const busy = save.isPending || connection.isPending || reindex.isPending;
  return (
    <div className="space-y-6">
      <PageHeading
        title="AI retrieval"
        subtitle="Configure semantic workspace search and optional web search for Assistant."
      />
      <AdminAiRelatedNav current="ai-retrieval" />
      {configQuery.isPending ? (
        <StateBanner kind="loading">Loading retrieval settings…</StateBanner>
      ) : null}
      {configQuery.isError ? (
        <StateBanner kind="error">
          {configQuery.error.message}{" "}
          <Button
            variant="outline"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: adminPlatformConfigQueryKey });
            }}
          >
            Retry
          </Button>
        </StateBanner>
      ) : null}
      {runtime.isError ? (
        <StateBanner kind="error">
          Could not read active retrieval status. {runtime.error.message}{" "}
          <Button
            variant="outline"
            onClick={() => {
              void queryClient.invalidateQueries({
                queryKey: aiRetrievalStatusQueryOptions().queryKey,
              });
            }}
          >
            Retry status
          </Button>
        </StateBanner>
      ) : null}
      {runtime.data ? (
        <StateBanner kind="info">
          Active semantic search:{" "}
          {runtime.data.vector.enabled
            ? `${runtime.data.vector.backend ?? "configured"} · ${runtime.data.vector.embeddingModel ?? "model unavailable"} · ${runtime.data.vector.dimensions ?? "unknown"} dimensions`
            : "Disabled"}
          . Web search: {runtime.data.web.enabled ? "Enabled" : "Disabled"}.
        </StateBanner>
      ) : null}
      {configQuery.data ? (
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            connection.reset();
            save.mutate(retrievalPatch(current));
          }}
        >
          <fieldset disabled={busy} className="min-w-0 space-y-6">
            <section
              aria-labelledby="semantic-search-title"
              className="space-y-4 rounded-lg border p-4"
            >
              <h2 id="semantic-search-title" className="text-base font-semibold">
                Semantic search
              </h2>
              <p className="text-sm text-muted-foreground">
                Find related workspace content using an embedding model and a vector database.
                Existing content needs indexing after this is enabled or its model changes.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={current.vectorEnabled}
                  onChange={(event) => change("vectorEnabled", event.target.checked)}
                />{" "}
                Enable semantic search
              </label>
              <label className="grid gap-1 text-sm">
                Vector database
                <select
                  className={selectClass}
                  value={current.vectorPlugin}
                  onChange={(event) =>
                    change("vectorPlugin", event.target.value as RetrievalDraft["vectorPlugin"])
                  }
                >
                  <option value="pgvector">pgvector (Helix database)</option>
                  <option value="qdrant">Qdrant</option>
                </select>
              </label>
              {current.vectorPlugin === "qdrant" ? (
                <>
                  <label className="grid gap-1 text-sm">
                    Qdrant endpoint
                    <Input
                      type="url"
                      required={current.vectorEnabled}
                      value={current.vectorUrl}
                      onChange={(event) => change("vectorUrl", event.target.value)}
                      placeholder="https://qdrant.example.com"
                    />
                  </label>
                  <SecretInput
                    label="Qdrant API key"
                    value={current.vectorKey}
                    clear={current.clearVectorKey}
                    configured={ai?.vectorStore?.config.apiKeyConfigured === true}
                    onChange={(value) => change("vectorKey", value)}
                    onClear={(value) => change("clearVectorKey", value)}
                  />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Uses the existing Helix PostgreSQL database with pgvector enabled.
                </p>
              )}
              <h3 className="text-sm font-semibold">Embedding model</h3>
              <p className="text-sm text-muted-foreground">
                Configure a model that supports embeddings separately from your chat models.
                Dimensions must match that model’s output.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  Embedding endpoint
                  <Input
                    type="url"
                    required={current.vectorEnabled}
                    value={current.embeddingUrl}
                    onChange={(event) => change("embeddingUrl", event.target.value)}
                    placeholder="https://api.example.com/v1"
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  Embedding model
                  <Input
                    required={current.vectorEnabled}
                    value={current.embeddingModel}
                    onChange={(event) => change("embeddingModel", event.target.value)}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  Embedding dimensions
                  <Input
                    type="number"
                    min={1}
                    max={65536}
                    step={1}
                    required={current.vectorEnabled}
                    value={current.dimensions}
                    onChange={(event) => change("dimensions", event.target.value)}
                  />
                </label>
                <SecretInput
                  label="Embedding API key"
                  value={current.embeddingKey}
                  clear={current.clearEmbeddingKey}
                  configured={ai?.embeddingProvider?.config.apiKeyConfigured === true}
                  onChange={(value) => change("embeddingKey", value)}
                  onClear={(value) => change("clearEmbeddingKey", value)}
                />
              </div>
              <h3 className="text-sm font-semibold">Document chunks</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  Chunk size (characters)
                  <Input
                    type="number"
                    min={64}
                    max={32768}
                    step={1}
                    required
                    value={current.chunkSize}
                    onChange={(event) => change("chunkSize", event.target.value)}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  Chunk overlap (characters)
                  <Input
                    type="number"
                    min={0}
                    max={Math.max(0, Number(current.chunkSize) - 1)}
                    step={1}
                    required
                    value={current.chunkOverlap}
                    onChange={(event) => change("chunkOverlap", event.target.value)}
                  />
                </label>
              </div>
              <p className="text-sm text-muted-foreground">
                Overlap must be smaller than chunk size. Save these settings, then reindex workspace
                content to apply them. Supported UTF-8 text and code file contents are indexed in
                chunks; unsupported binary formats are indexed by metadata only.
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={dirty || ai?.vectorStore?.config.enabled !== true}
                onClick={() => connection.mutate("vector")}
              >
                Test saved vector connection
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={dirty || runtime.data?.vector.enabled !== true || jobRunning}
                onClick={() => {
                  cancel.reset();
                  reindex.mutate();
                }}
              >
                Index workspace content
              </Button>
              <p className="text-sm text-muted-foreground">
                Splits supported source text into chunks of{" "}
                {runtime.data?.vector.maxInputChars ?? 1024} characters with{" "}
                {runtime.data?.vector.chunkOverlapChars ??
                  Math.floor((runtime.data?.vector.maxInputChars ?? 1024) * 0.15)}{" "}
                characters of overlap. Every retrieved source remains subject to current access
                permissions. Indexing runs in the background and may incur embedding provider usage
                charges.
              </p>
              {reindex.isError ? (
                <StateBanner kind="error">{reindex.error.message}</StateBanner>
              ) : null}
              {job.data ? (
                <StateBanner kind={job.data.status === "dead_lettered" ? "error" : "info"}>
                  Indexing {job.data.status === "dead_lettered" ? "failed" : job.data.status} ·{" "}
                  {job.data.phase} · {job.data.totalDocuments} documents. {job.data.lastError}
                </StateBanner>
              ) : null}
              {job.isError ? (
                <StateBanner kind="error">
                  Could not read indexing progress. {job.error.message}{" "}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      void queryClient.invalidateQueries({
                        queryKey: reindexJobQueryOptions(jobId).queryKey,
                      });
                    }}
                  >
                    Retry indexing status
                  </Button>
                </StateBanner>
              ) : null}
              {jobRunning ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={cancel.isPending}
                  onClick={() => {
                    if (jobId !== null) cancel.mutate(jobId);
                  }}
                >
                  Cancel indexing
                </Button>
              ) : null}
              {cancel.isError ? (
                <StateBanner kind="error">{cancel.error.message}</StateBanner>
              ) : null}
            </section>
            <section aria-labelledby="web-search-title" className="space-y-4 rounded-lg border p-4">
              <h2 id="web-search-title" className="text-base font-semibold">
                Web search
              </h2>
              <p className="text-sm text-muted-foreground">
                Allow people to opt in from the Assistant + menu. Their search query is sent to this
                provider only when selected for a message. Assistant can also read public pages for
                that message. Private network pages and unsupported page formats are blocked.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={current.webEnabled}
                  onChange={(event) => change("webEnabled", event.target.checked)}
                />{" "}
                Enable web search
              </label>
              <label className="grid gap-1 text-sm">
                Search provider
                <select
                  className={selectClass}
                  value={current.webProvider}
                  onChange={(event) =>
                    change("webProvider", event.target.value as RetrievalDraft["webProvider"])
                  }
                >
                  <option value="brave">Brave Search</option>
                  <option value="searxng">SearXNG</option>
                </select>
              </label>
              {current.webProvider === "searxng" ? (
                <label className="grid gap-1 text-sm">
                  SearXNG endpoint
                  <Input
                    type="url"
                    required={current.webEnabled}
                    value={current.webUrl}
                    onChange={(event) => change("webUrl", event.target.value)}
                    placeholder="https://search.example.com"
                  />
                </label>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Uses the official Brave Search API endpoint.
                </p>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <SecretInput
                  label="Search API key"
                  value={current.webKey}
                  clear={current.clearWebKey}
                  configured={ai?.webSearch?.apiKeyConfigured === true}
                  onChange={(value) => change("webKey", value)}
                  onClear={(value) => change("clearWebKey", value)}
                />
                <label className="grid gap-1 text-sm">
                  Maximum search results
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    step={1}
                    required
                    value={current.maxResults}
                    onChange={(event) => change("maxResults", event.target.value)}
                  />
                </label>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={dirty || ai?.webSearch?.enabled !== true}
                onClick={() => connection.mutate("web")}
              >
                Test saved web connection
              </Button>
            </section>
            <p className="text-sm text-muted-foreground">
              Save changes before testing. Connection tests check saved settings without indexing or
              changing workspace content. Re-enter or clear a stored API key when changing its
              provider or endpoint.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!dirty}>
                {save.isPending ? "Saving…" : "Save retrieval settings"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!dirty}
                onClick={() => {
                  setDraft(null);
                  save.reset();
                }}
              >
                Discard changes
              </Button>
            </div>
          </fieldset>
          {save.isError ? <StateBanner kind="error">{save.error.message}</StateBanner> : null}
          {savedNotice ? <StateBanner kind="info">Retrieval settings saved.</StateBanner> : null}
          {connection.isPending ? (
            <StateBanner kind="loading">
              Testing saved {connection.variables} connection…
            </StateBanner>
          ) : null}
          {connection.isError ? (
            <StateBanner kind="error">{connection.error.message}</StateBanner>
          ) : null}
          {connection.data ? (
            <StateBanner kind={connection.data.ok ? "info" : "error"}>
              {connection.data.message} · {connection.data.latencyMs} ms · Checked{" "}
              {new Date(connection.data.checkedAt).toLocaleString()}
            </StateBanner>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
