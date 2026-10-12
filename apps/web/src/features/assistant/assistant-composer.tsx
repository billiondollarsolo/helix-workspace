import { useEffect, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Plus, Send, Square, X, MessageSquarePlus, Globe, Check } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { uploadDriveFile } from "@/features/drive/upload";
import { driveUploadStatusQueryOptions } from "@/features/drive/queries";
import { assistantModelsQueryOptions, assistantToolsQueryOptions } from "./queries";
import type { AssistantAttachment } from "./api";
import { assistantModelNames } from "./model-name";
import { randomId } from "@/lib/random-id";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const TEXT_EXTENSIONS =
  /\.(?:txt|md|rst|csv|tsv|json|log|yaml|yml|js|mjs|cjs|ts|tsx|jsx|py|sql|rs|go|java|kt|kts|c|cc|cpp|h|hpp|cs|css|html|htm|xml|sh|bash|zsh|toml|ini|conf|env|php|rb|swift|scala|lua|pl|pm|r|dart|vue|svelte|hs|ex|exs|proto|graphql|tf|hcl|bat|ps1|cmd)$/iu;
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp)$/iu;
const TEXT_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

function isAllowedComposerFile(file: File): boolean {
  if (
    file.type.startsWith("text/") ||
    TEXT_TYPES.has(file.type) ||
    IMAGE_TYPES.has(file.type) ||
    file.type === "application/pdf"
  )
    return true;
  return (
    (!file.type || file.type === "application/octet-stream") &&
    (TEXT_EXTENSIONS.test(file.name) ||
      IMAGE_EXTENSIONS.test(file.name) ||
      /\.pdf$/iu.test(file.name))
  );
}
interface Upload {
  readonly id: string;
  readonly file: File;
  readonly controller: AbortController;
  readonly attachment?: AssistantAttachment;
  readonly error?: string;
}

export function AssistantComposer({
  onSend,
  pending,
  disabled,
  onStop,
  modelId,
  onModelChange,
  onNewChat,
  editing,
  onCancelEdit,
  toolGroups,
  onToolGroupsChange,
  webSearch: webSearchProp,
  onWebSearchChange,
}: {
  readonly onSend: (
    text: string,
    attachments: readonly AssistantAttachment[],
    modelId: string,
    webSearch: boolean,
    toolGroups: readonly string[] | undefined,
  ) => Promise<boolean>;
  /** The chosen tool groups; undefined lets the server pick within the limit. */
  readonly toolGroups: readonly string[] | undefined;
  readonly onToolGroupsChange: (groups: readonly string[] | undefined) => void;
  readonly webSearch?: boolean;
  readonly onWebSearchChange?: (enabled: boolean) => void;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onStop: () => void;
  readonly modelId: string;
  readonly onModelChange: (value: string) => void;
  readonly onNewChat: () => void;
  readonly editing?: {
    readonly toolGroups?: readonly string[];
    readonly webSearch?: boolean;
    readonly text: string;
    readonly attachments?: readonly AssistantAttachment[];
  } | null;
  readonly onCancelEdit: () => void;
}) {
  const [uncontrolledWebSearch, setUncontrolledWebSearch] = useState(editing?.webSearch ?? false);
  const webSearch =
    onWebSearchChange === undefined ? uncontrolledWebSearch : (webSearchProp ?? false);
  const setWebSearch = onWebSearchChange ?? setUncontrolledWebSearch;
  // An edit keeps its own choice; the main composer's choice lives with the conversation.
  const [editGroups, setEditGroups] = useState<readonly string[] | undefined>(editing?.toolGroups);
  const chosenGroups = editing ? editGroups : toolGroups;
  const setChosenGroups = editing ? setEditGroups : onToolGroupsChange;
  const tools = useQuery(assistantToolsQueryOptions());
  const availableGroups = (tools.data?.groups ?? []).filter((group) => group.count > 0);
  const automaticGroups = chosenGroups === undefined;
  const selectedGroups = (
    chosenGroups ?? availableGroups.filter((group) => group.defaultEnabled).map((group) => group.id)
  ).filter((id) => availableGroups.some((group) => group.id === id));
  const selectedToolCount = availableGroups
    .filter((group) => selectedGroups.includes(group.id))
    .reduce((total, group) => total + group.count, 0);
  const toolLimit = tools.data?.limit;
  // Only people with admin tools can see raw model ids.
  const showModelIds = availableGroups.some((group) => group.id === "admin");
  const [text, setText] = useState(editing?.text ?? "");
  const [retainedAttachments, setRetainedAttachments] = useState(editing?.attachments ?? []);
  const [uploads, setUploads] = useState<readonly Upload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Set<AbortController>());
  const models = useQuery(assistantModelsQueryOptions());
  const queryClient = useQueryClient();
  const statuses = useQueries({
    queries: uploads.map((upload) =>
      driveUploadStatusQueryOptions(upload.attachment?.objectId ?? null),
    ),
  });
  const ready = uploads.every(
    (upload, index) =>
      upload.attachment !== undefined &&
      statuses[index]?.data?.state === "active" &&
      statuses[index]?.data?.available === true &&
      !statuses[index]?.isError,
  );
  const modelNames = assistantModelNames(models.data?.models ?? []);
  const selectedModel =
    models.data?.models.find((model) => model.id === modelId)?.id ??
    models.data?.defaultModelId ??
    models.data?.models[0]?.id ??
    "";
  const canSend =
    text.trim().length > 0 && !pending && !disabled && ready && selectedModel.length > 0;

  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active) controller.abort();
    };
  }, []);

  async function upload(item: Upload) {
    controllers.current.add(item.controller);
    try {
      const result = await uploadDriveFile({
        file: item.file,
        folderId: null,
        signal: item.controller.signal,
      });
      if (item.controller.signal.aborted) return;
      const attachment = {
        objectId: result.objectId,
        name: result.name,
        mimeType: result.mimeType,
        byteSize: result.byteSize,
      };
      setUploads((current) =>
        current.map((entry) => (entry.id === item.id ? { ...entry, attachment } : entry)),
      );
    } catch (cause) {
      if (!item.controller.signal.aborted)
        setUploads((current) =>
          current.map((entry) =>
            entry.id === item.id
              ? {
                  ...entry,
                  error:
                    cause instanceof Error
                      ? cause.message
                      : "Upload failed. Remove the file and try again.",
                }
              : entry,
          ),
        );
    } finally {
      controllers.current.delete(item.controller);
    }
  }

  function attach(files: readonly File[]) {
    setError(null);
    if (uploads.length + retainedAttachments.length + files.length > MAX_FILES) {
      setError(`Attach up to ${String(MAX_FILES)} files.`);
      return;
    }
    if (
      files.some((file) => file.size > MAX_FILE_BYTES) ||
      [...uploads.map(({ file }) => file), ...files].reduce((size, file) => size + file.size, 0) >
        MAX_TOTAL_BYTES -
          retainedAttachments.reduce((size, attachment) => size + attachment.byteSize, 0)
    ) {
      setError("Use files up to 10 MB each and 25 MB total.");
      return;
    }
    if (files.some((file) => !isAllowedComposerFile(file))) {
      setError("Use text, images, or PDFs.");
      return;
    }
    const additions = files.map((file) => ({
      id: randomId(),
      file,
      controller: new AbortController(),
    }));
    setUploads((current) => [...current, ...additions]);
    // The batch is capped at five; Drive owns upload, finalization, and scan polling.
    for (const item of additions) void upload(item);
  }

  async function submit() {
    if (!canSend) return;
    onModelChange(selectedModel);
    if (
      await onSend(
        text,
        [
          ...retainedAttachments,
          ...uploads.flatMap(({ attachment }) => (attachment === undefined ? [] : [attachment])),
        ],
        selectedModel,
        webSearch && models.data?.webSearchEnabled === true,
        // Until the tool list loads, an explicit choice is sent as saved.
        chosenGroups === undefined || !tools.data ? chosenGroups : selectedGroups,
      )
    ) {
      setText("");
      setUploads([]);
      setRetainedAttachments([]);
      setError(null);
    }
  }

  return (
    <div className="px-3 py-3 sm:px-8 shrink-0">
      <div className="max-w-200 mx-auto rounded-xl border bg-card p-2 shadow-sm">
        {models.isError ? (
          <p role="alert" className="p-2 text-sm">
            Could not load models.{" "}
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                void queryClient.invalidateQueries({
                  queryKey: assistantModelsQueryOptions().queryKey,
                });
              }}
            >
              Retry models
            </button>
          </p>
        ) : null}
        {!models.isPending && !models.isError && selectedModel.length === 0 ? (
          <p className="p-2 text-sm">
            Configure a provider in Settings → Helix AI to send messages.
          </p>
        ) : null}
        {editing ? (
          <div className="flex items-start gap-2 px-3 pt-2 text-xs text-muted-foreground">
            <p className="flex-1">
              Resending starts a new conversation from this message. Your original stays available.
            </p>
            <button type="button" className="btn sm" disabled={pending} onClick={onCancelEdit}>
              Cancel edit
            </button>
          </div>
        ) : null}
        <textarea
          autoFocus={editing != null}
          value={text}
          disabled={pending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="Ask anything…"
          aria-label="Message Helix AI"
          className="w-full p-3 border-none bg-transparent text-base resize-none min-h-15 text-foreground"
        />
        {retainedAttachments.length > 0 ? (
          <ul aria-label="Saved attachments to send" className="space-y-2 p-2">
            {retainedAttachments.map((attachment) => (
              <li key={attachment.objectId} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 break-all">{attachment.name}</span>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={pending}
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() =>
                    setRetainedAttachments((current) =>
                      current.filter((item) => item.objectId !== attachment.objectId),
                    )
                  }
                >
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {uploads.length > 0 ? (
          <ul aria-label="Attachments to send" className="space-y-2 p-2">
            {uploads.map((item, index) => {
              const status = statuses[index];
              const scanFailed = status?.data?.terminal === true && status.data.state !== "active";
              return (
                <li key={item.id} className="flex items-start gap-2 text-sm">
                  <span className="min-w-0 flex-1 break-all">
                    {item.file.name}
                    <span
                      className="block text-muted-foreground"
                      role={item.error || scanFailed || status?.isError ? "alert" : "status"}
                    >
                      {item.error ??
                        (status?.isError
                          ? "Could not check file scan."
                          : scanFailed
                            ? "File is unavailable after scanning. Remove it and choose another file."
                            : status?.data?.state === "active"
                              ? "Ready"
                              : item.attachment
                                ? "Scanning…"
                                : "Uploading…")}
                    </span>
                  </span>
                  {status?.isError ? (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        void queryClient.invalidateQueries({
                          queryKey: driveUploadStatusQueryOptions(item.attachment?.objectId ?? null)
                            .queryKey,
                        });
                      }}
                      aria-label={`Retry scan for ${item.file.name}`}
                    >
                      Retry
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={pending}
                    aria-label={`Remove ${item.file.name}`}
                    onClick={() => {
                      item.controller.abort();
                      setUploads((current) => current.filter((entry) => entry.id !== item.id));
                    }}
                  >
                    <X size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="p-2 text-sm">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2 items-center px-2">
          <input
            ref={fileInput}
            className="sr-only"
            tabIndex={-1}
            type="file"
            multiple
            accept="text/*,image/png,image/jpeg,image/gif,image/webp,application/pdf,.txt,.md,.csv,.json,.py,.rs,.go,.ts,.tsx,.js,.png,.jpg,.jpeg,.gif,.webp,.pdf"
            aria-label="Attach"
            disabled={pending || disabled}
            onChange={(event) => {
              attach(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="icon-btn"
                aria-label="More composer options"
                disabled={pending || disabled}
              >
                <Plus size={20} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <section aria-label="Composer options">
                <DropdownMenu.Content
                  side="top"
                  align="start"
                  sideOffset={8}
                  className="z-50 min-w-56 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
                >
                  <DropdownMenu.Item
                    className="flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm outline-none focus:bg-accent"
                    onSelect={() => fileInput.current?.click()}
                  >
                    <Paperclip size={16} /> Files
                  </DropdownMenu.Item>
                  {models.data?.webSearchEnabled === true ? (
                    <DropdownMenu.CheckboxItem
                      checked={webSearch}
                      onCheckedChange={setWebSearch}
                      className="flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm outline-none focus:bg-accent"
                    >
                      <Globe size={16} /> Search
                      <DropdownMenu.ItemIndicator className="ml-auto">
                        <Check size={16} />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.CheckboxItem>
                  ) : null}
                  <DropdownMenu.Sub>
                    <DropdownMenu.SubTrigger className="flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm outline-none focus:bg-accent">
                      Tools
                    </DropdownMenu.SubTrigger>
                    <DropdownMenu.Portal>
                      <section aria-label="Tool choices">
                        <DropdownMenu.SubContent
                          aria-label="Available tools"
                          className="z-50 min-w-56 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
                        >
                          {tools.isPending ? (
                            <p role="status" className="p-2 text-sm">
                              Loading tools…
                            </p>
                          ) : null}
                          {tools.isError ? (
                            <DropdownMenu.Item
                              className="p-2 text-sm"
                              onSelect={() => {
                                void queryClient.invalidateQueries({
                                  queryKey: assistantToolsQueryOptions().queryKey,
                                });
                              }}
                            >
                              Could not load tools. Retry
                            </DropdownMenu.Item>
                          ) : null}
                          {tools.data && availableGroups.length > 0 ? (
                            <>
                              <DropdownMenu.Label className="px-2 pt-1.5 pb-1 type-caption text-muted-foreground">
                                {automaticGroups
                                  ? `Helix AI picks up to ${String(toolLimit)} tools for each request`
                                  : `${String(selectedToolCount)} of ${String(toolLimit)} tools on`}
                              </DropdownMenu.Label>
                              <DropdownMenu.CheckboxItem
                                checked={automaticGroups}
                                onSelect={(event) => event.preventDefault()}
                                onCheckedChange={(checked) => {
                                  setChosenGroups(checked ? undefined : selectedGroups);
                                }}
                                className="flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm outline-none focus:bg-accent"
                              >
                                Choose automatically
                                <DropdownMenu.ItemIndicator className="ml-auto">
                                  <Check size={16} />
                                </DropdownMenu.ItemIndicator>
                              </DropdownMenu.CheckboxItem>
                              <DropdownMenu.Separator className="my-1 h-px bg-border" />
                            </>
                          ) : null}
                          {availableGroups.map((group) => (
                            <DropdownMenu.CheckboxItem
                              key={group.id}
                              checked={selectedGroups.includes(group.id)}
                              onSelect={(event) => event.preventDefault()}
                              onCheckedChange={(checked) => {
                                setChosenGroups(
                                  checked
                                    ? [...selectedGroups, group.id]
                                    : selectedGroups.filter((id) => id !== group.id),
                                );
                              }}
                              className="flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm outline-none focus:bg-accent"
                            >
                              {group.label}{" "}
                              <span className="text-muted-foreground">({group.count})</span>
                              <DropdownMenu.ItemIndicator className="ml-auto">
                                <Check size={16} />
                              </DropdownMenu.ItemIndicator>
                            </DropdownMenu.CheckboxItem>
                          ))}
                          {tools.data && availableGroups.length === 0 ? (
                            <p className="p-2 text-sm">No workspace tools available.</p>
                          ) : null}
                          {toolLimit !== undefined &&
                          !automaticGroups &&
                          selectedToolCount > toolLimit ? (
                            <p role="status" className="max-w-56 p-2 type-caption text-destructive">
                              {`${String(selectedToolCount - toolLimit)} over the limit. Turn off a group before sending.`}
                            </p>
                          ) : null}
                        </DropdownMenu.SubContent>
                      </section>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Sub>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  <DropdownMenu.Item
                    className="flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm outline-none focus:bg-accent"
                    onSelect={onNewChat}
                  >
                    <MessageSquarePlus size={16} /> New chat
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </section>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          {webSearch && models.data?.webSearchEnabled === true ? (
            <button
              type="button"
              className="chip"
              disabled={pending}
              onClick={() => setWebSearch(false)}
              aria-label="Turn off web search"
            >
              <Globe size={14} /> Search <X size={12} />
            </button>
          ) : null}
          <label className="ml-auto min-w-0 text-xs">
            <span className="sr-only">Model</span>
            <select
              aria-label="Assistant model"
              title={showModelIds && selectedModel.length > 0 ? selectedModel : undefined}
              value={selectedModel}
              onChange={(event) => onModelChange(event.target.value)}
              disabled={pending || models.isPending || selectedModel.length === 0}
              className="max-w-36 sm:max-w-52 rounded-md border-0 bg-transparent p-2 text-xs text-foreground"
            >
              {selectedModel.length === 0 ? (
                <option value="">
                  {models.isPending ? "Loading models…" : "No models available"}
                </option>
              ) : null}
              {models.data?.models.map((model) => (
                <option key={model.id} value={model.id} title={showModelIds ? model.id : undefined}>
                  {modelNames.get(model.id) ?? model.label}
                </option>
              ))}
            </select>
          </label>
          {pending ? (
            <button type="button" className="btn sm" onClick={onStop}>
              <Square size={14} /> Stop response
            </button>
          ) : (
            <button
              type="button"
              className="btn primary sm"
              disabled={!canSend}
              onClick={() => {
                void submit();
              }}
              aria-label={editing ? "Resend message" : "Send message"}
            >
              <Send size={16} />
            </button>
          )}
        </div>
      </div>
      <p className="mx-auto mt-2 max-w-200 text-center text-xs text-muted-foreground">
        Helix AI may produce inaccurate information. Verify important details.
      </p>
    </div>
  );
}
