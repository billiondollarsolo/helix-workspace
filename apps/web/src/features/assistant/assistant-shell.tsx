import {
  CircleAlert,
  Bot,
  Check,
  Database,
  FileText,
  History,
  Link2,
  LockKeyhole,
  MessageSquarePlus,
  MoreHorizontal,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useForm } from "@tanstack/react-form";
import { useSuspenseQuery } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useHelixDialog } from "@helix/sdk-web";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { AIProvenanceBadge, type AIProvenanceArtifact } from "@/features/ai/provenance";
import { ToolCallCard } from "@/features/assistant/assistant-tool-card";
import {
  assistantToolPendingId,
  forgetAssistantMemory,
  isAssistantBackendConversationId,
  streamAssistantChat,
  type AssistantTurnResponseWithPendingConfirmations,
} from "@/features/assistant/api";
import {
  assistantConversationListQueryOptions,
  type AssistantCitation,
  type AssistantMessage,
  type AssistantToolCall,
} from "@/features/assistant/queries";
import { applyAssistantToolDecision, type ToolStatus } from "@/features/assistant/tool-decisions";

export { AssistantRightRailPanel } from "./assistant-right-rail-panel";
export type { AssistantCitation, AssistantMessage, AssistantToolCall } from "./queries";

const composerHints = [
  "Ask across mail, docs, drive, chat, and calendar",
  "Use @ to narrow context",
];
const assistantPromptSchema = z.string().trim().min(1, "Prompt is required.");

export function AssistantShell() {
  const dialog = useHelixDialog();
  const { data: conversations } = useSuspenseQuery(assistantConversationListQueryOptions());
  const [selectedConversationId, setSelectedConversationId] = useState(conversations[0]?.id ?? "");
  const [messagesByConversation, setMessagesByConversation] = useState(() =>
    Object.fromEntries(
      conversations.map((conversation) => [conversation.id, conversation.messages]),
    ),
  );
  const [toolStatuses, setToolStatuses] = useState<Readonly<Record<string, ToolStatus>>>({});
  const [toolErrors, setToolErrors] = useState<Readonly<Record<string, string | undefined>>>({});
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const [memoryCleared, setMemoryCleared] = useState(false);
  const [backendConversationIds, setBackendConversationIds] = useState<
    Readonly<Record<string, string | undefined>>
  >({});

  const selectedConversation = useMemo(
    () =>
      conversations.find((conversation) => conversation.id === selectedConversationId) ??
      conversations[0],
    [selectedConversationId],
  );
  const visibleMessages = selectedConversation
    ? (messagesByConversation[selectedConversation.id] ?? [])
    : [];

  const updateToolStatus = useCallback((toolId: string, status: ToolStatus) => {
    setToolStatuses((current) => ({ ...current, [toolId]: status }));
  }, []);
  const updateToolError = useCallback((toolId: string, message: string | undefined) => {
    setToolErrors((current) => ({ ...current, [toolId]: message }));
  }, []);
  const decideToolCall = useCallback(
    (toolId: string, decision: "confirm" | "cancel") => {
      if (!selectedConversation) {
        return;
      }

      const backendConversationId = backendConversationIds[selectedConversation.id];
      if (backendConversationId === undefined) {
        return;
      }

      void applyAssistantToolDecision({
        conversationId: backendConversationId,
        decision,
        setToolError: updateToolError,
        setToolStatus: updateToolStatus,
        pendingId: visibleMessages
          .flatMap((message) => message.toolCalls ?? [])
          .find((toolCall) => toolCall.id === toolId)?.pendingId,
        toolCallId: toolId,
      }).catch(() => undefined);
    },
    [
      backendConversationIds,
      selectedConversation,
      updateToolError,
      updateToolStatus,
      visibleMessages,
    ],
  );

  const submitDraft = useCallback(
    (draft: string) => {
      const body = draft.trim();
      if (!selectedConversation || body.length === 0) {
        return false;
      }

      const localId = Date.now();
      const conversationId = selectedConversation.id;
      const userMessage: AssistantMessage = {
        id: `msg-local-user-${localId}`,
        role: "user",
        author: "You",
        body,
        sentAt: "Now",
      };
      const streamingMessageId = `msg-local-ai-${localId}`;
      const streamingPlaceholder: AssistantMessage = {
        id: streamingMessageId,
        role: "assistant",
        author: "Helix Assistant",
        body: "",
        sentAt: "Now",
        streaming: true,
      };

      setMessagesByConversation((current) => ({
        ...current,
        [conversationId]: [
          ...(current[conversationId] ?? []),
          userMessage,
          streamingPlaceholder,
        ],
      }));

      const replaceStreamingMessage = (next: AssistantMessage) => {
        setMessagesByConversation((current) => ({
          ...current,
          [conversationId]: (current[conversationId] ?? []).map((message) =>
            message.id === streamingMessageId ? next : message,
          ),
        }));
      };
      const appendStreamingDelta = (text: string) => {
        setMessagesByConversation((current) => ({
          ...current,
          [conversationId]: (current[conversationId] ?? []).map((message) =>
            message.id === streamingMessageId
              ? { ...message, body: message.body + text }
              : message,
          ),
        }));
      };

      void streamAssistantChat(
        {
          conversationId: backendConversationIds[conversationId],
          memoryOptIn: memoryEnabled,
          message: body,
        },
        { onDelta: appendStreamingDelta },
      )
        .then((turn) => {
          const backendConversationId = turn.conversation?.id;
          const finalMessage =
            assistantMessageFromTurn(turn, localId, streamingMessageId) ??
            assistantBackendUnavailableMessage(
              localId,
              "Assistant backend returned no response.",
              turn,
            );

          if (isAssistantBackendConversationId(backendConversationId)) {
            setBackendConversationIds((current) => ({
              ...current,
              [conversationId]: backendConversationId,
            }));
          }
          replaceStreamingMessage(finalMessage);
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Assistant chat failed.";
          replaceStreamingMessage(assistantBackendUnavailableMessage(localId, message));
        });

      return true;
    },
    [backendConversationIds, memoryEnabled, selectedConversation],
  );

  const composerForm = useForm({
    defaultValues: { body: "" },
    onSubmit: ({ value, formApi }) => {
      if (submitDraft(value.body)) {
        formApi.reset();
      }
    },
  });

  const forgetMemory = () => {
    const backendConversationId =
      selectedConversation === undefined
        ? undefined
        : backendConversationIds[selectedConversation.id];
    if (backendConversationId !== undefined) {
      void forgetAssistantMemory({ conversationId: backendConversationId }).catch(() => undefined);
    }
    setMemoryEnabled(false);
    setMemoryCleared(true);
  };

  const confirmForgetMemory = () => {
    void dialog
      .confirm({
        title: "Forget assistant memory?",
        description: "This clears saved preferences for future assistant replies in this workspace.",
        confirmLabel: "Forget",
        cancelLabel: "Cancel",
        destructive: true,
      })
      .then((confirmed) => {
        if (confirmed) {
          forgetMemory();
        }
      });
  };

  return (
    <section className="assistant-page">
      <aside className="assistant-sidebar" aria-label="Assistant conversations">
        <header className="assistant-sidebar-header">
          <div>
            <h1 id="assistant-title">Assistant</h1>
            <p>Workspace-aware answers with source trails.</p>
          </div>
          <button className="icon-button" aria-label="Start new conversation" type="button">
            <MessageSquarePlus aria-hidden="true" size={17} />
          </button>
        </header>

        <label className="assistant-search">
          <Search aria-hidden="true" size={16} />
          <input placeholder="Search assistant" />
        </label>

        <div className="assistant-conversation-list" aria-label="Conversation list">
          {conversations.map((conversation) => (
            <button
              className={
                conversation.id === selectedConversation?.id
                  ? "assistant-conversation active"
                  : "assistant-conversation"
              }
              key={conversation.id}
              onClick={() => setSelectedConversationId(conversation.id)}
              type="button"
            >
              <span>
                <strong>{conversation.title}</strong>
                <time>{conversation.updatedAt}</time>
              </span>
              <small>{conversation.summary}</small>
              {conversation.pinned ? <b>Pinned</b> : null}
            </button>
          ))}
        </div>

        <MemoryPanel
          memoryCleared={memoryCleared}
          memoryEnabled={memoryEnabled}
          onForget={confirmForgetMemory}
          onToggle={() => {
            setMemoryCleared(false);
            setMemoryEnabled((current) => !current);
          }}
        />
      </aside>

      <div className="assistant-workspace" role="main" aria-labelledby="assistant-title">
        <header className="assistant-workspace-header">
          <div className="assistant-room-title">
            <span className="assistant-room-icon">
              <Bot aria-hidden="true" size={21} />
            </span>
            <div>
              <h2>{selectedConversation?.title ?? "Assistant"}</h2>
              <p>{selectedConversation?.summary ?? "Ask a workspace question."}</p>
            </div>
          </div>
          <div className="assistant-header-actions">
            <button className="helix-button helix-button-secondary" type="button">
              <History aria-hidden="true" size={16} />
              History
            </button>
            <button className="icon-button" aria-label="More assistant actions" type="button">
              <MoreHorizontal aria-hidden="true" size={17} />
            </button>
          </div>
        </header>

        <div className="assistant-context-strip" aria-label="Assistant context">
          <span>
            <ShieldCheck aria-hidden="true" size={15} />
            Provenance on
          </span>
          <span>
            <LockKeyhole aria-hidden="true" size={15} />
            Memory {memoryEnabled ? "opted in" : "off"}
          </span>
          <span>
            <Database aria-hidden="true" size={15} />4 workspace sources available
          </span>
        </div>

        <AssistantMessageHistory
          messages={visibleMessages}
          onToolDecision={decideToolCall}
          toolErrors={toolErrors}
          toolStatuses={toolStatuses}
        />

        <form
          className="assistant-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void composerForm.handleSubmit();
          }}
        >
          <div className="assistant-composer-column">
            <div className="assistant-editor" aria-label="Message composer">
              <composerForm.Field
                name="body"
                validators={{
                  onChange: validateStringWith(assistantPromptSchema),
                  onSubmit: validateStringWith(assistantPromptSchema),
                }}
              >
                {(field) => (
                  <>
                    <label className="sr-only" htmlFor="assistant-composer-body">
                      Assistant prompt
                    </label>
                    <textarea
                      aria-describedby="assistant-composer-error"
                      aria-invalid={field.state.meta.errors.length > 0}
                      id="assistant-composer-body"
                      onChange={(event) => field.handleChange(event.target.value)}
                      placeholder={composerHints[0]}
                      value={field.state.value}
                    />
                    <FieldErrors id="assistant-composer-error" errors={field.state.meta.errors} />
                  </>
                )}
              </composerForm.Field>
              <div className="assistant-editor-footer">
                <div className="assistant-editor-toolbar" aria-label="Composer tools">
                  <button aria-label="Attach workspace source" type="button">
                    <Link2 aria-hidden="true" size={16} />
                  </button>
                  <button aria-label="Use prompt template" type="button">
                    <Sparkles aria-hidden="true" size={16} />
                  </button>
                </div>
                <composerForm.Subscribe selector={(state) => state.values.body}>
                  {(body) => (
                    <button
                      aria-label="Send message"
                      className="assistant-send-button"
                      disabled={body.trim().length === 0}
                      type="submit"
                    >
                      <Send aria-hidden="true" size={17} />
                      <span className="sr-only">Send</span>
                    </button>
                  )}
                </composerForm.Subscribe>
              </div>
            </div>
            <p className="assistant-composer-hint">{composerHints[1]}</p>
          </div>
        </form>
      </div>
    </section>
  );
}

function assistantMessageFromTurn(
  turn: AssistantTurnResponseWithPendingConfirmations,
  localId: number,
  fallbackId: string,
): AssistantMessage | undefined {
  const responseContent = turn.response?.content?.trim();
  if (responseContent === undefined || responseContent.length === 0) {
    return undefined;
  }

  return {
    id: turn.response?.id ?? fallbackId,
    role: "assistant",
    author: "Helix Assistant",
    body: responseContent,
    sentAt:
      turn.response?.createdAt === undefined ? "Now" : formatAssistantTime(turn.response.createdAt),
    toolCalls: toolCallsFromTurn(turn),
    provenance: provenanceFromTurn(turn, localId),
  };
}

function assistantBackendUnavailableMessage(
  localId: number,
  message: string,
  turn?: AssistantTurnResponseWithPendingConfirmations,
): AssistantMessage {
  return {
    id: `msg-backend-unavailable-${localId}`,
    role: "assistant",
    author: "Helix Assistant",
    body: `Assistant backend unavailable. ${message}`,
    sentAt: "Now",
    status: "error",
    toolCalls: turn === undefined ? undefined : toolCallsFromTurn(turn),
  };
}

function toolCallsFromTurn(
  turn: AssistantTurnResponseWithPendingConfirmations,
): readonly AssistantToolCall[] | undefined {
  const toolCalls = (turn.toolCalls ?? [])
    .filter((toolCall) => toolCall.status === "pending_confirmation" || toolCall.pending)
    .map((toolCall) => ({
      id: toolCall.toolCallId,
      pendingId: assistantToolPendingId(turn, toolCall),
      name: toolCall.toolId,
      description: `Confirm ${toolCall.toolId} before it runs.`,
      risk: "Requires confirmation",
      status: "pending" as const,
    }));

  return toolCalls.length === 0 ? undefined : toolCalls;
}

function provenanceFromTurn(
  turn: AssistantTurnResponseWithPendingConfirmations,
  localId: number,
): AIProvenanceArtifact | undefined {
  const ai = turn.ai;
  if (ai === undefined || ai.providerId === undefined || ai.model === undefined) {
    return undefined;
  }

  return {
    artifactId: turn.response?.id ?? `ai-artifact-backend-${localId}`,
    feature: "assistant.chat",
    providerId: ai.providerId,
    model: ai.model,
    promptHash: stringMetadataValue(ai.metadata, "promptHash") ?? "backend-not-provided",
    createdAt: turn.response?.createdAt ?? new Date().toISOString(),
    actorName: "Local User",
    classification: classificationMetadataValue(ai.metadata),
    inputTokens: ai.usage?.inputTokens,
    outputTokens: ai.usage?.outputTokens,
    costUsdMicros: ai.usage?.costCents === undefined ? undefined : ai.usage.costCents * 10_000,
    traceId: stringMetadataValue(ai.metadata, "traceId"),
    sources: turn.sources?.map((source) => ({
      id: source.id,
      title: source.title ?? source.id,
      type: source.type,
      reference: source.url ?? source.id,
    })),
    tools: turn.toolCalls
      ?.filter((toolCall) => toolCall.status !== "pending_confirmation")
      .map((toolCall) => ({
        id: toolCall.toolCallId,
        name: toolCall.toolId,
        status:
          toolCall.status === "failed"
            ? "failed"
            : toolCall.status === "skipped"
              ? "skipped"
              : "succeeded",
      })),
  };
}

function stringMetadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function classificationMetadataValue(
  metadata: Record<string, unknown> | undefined,
): AIProvenanceArtifact["classification"] | undefined {
  const value = metadata?.classification;
  return value === "public" ||
    value === "standard" ||
    value === "confidential" ||
    value === "restricted"
    ? value
    : undefined;
}

function formatAssistantTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Now";
  }
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function MemoryPanel({
  memoryCleared,
  memoryEnabled,
  onForget,
  onToggle,
}: {
  readonly memoryCleared: boolean;
  readonly memoryEnabled: boolean;
  readonly onForget: () => void;
  readonly onToggle: () => void;
}) {
  return (
    <section className="assistant-memory-panel" aria-label="Assistant memory">
      <header>
        <div>
          <strong>Memory</strong>
          <p>
            {memoryEnabled ? "Assistant can remember preferences." : "Opt in to save preferences."}
          </p>
        </div>
        <button
          aria-label="Toggle assistant memory"
          aria-pressed={memoryEnabled}
          className={memoryEnabled ? "assistant-switch on" : "assistant-switch"}
          onClick={onToggle}
          type="button"
        >
          <span />
        </button>
      </header>
      <button
        className="assistant-memory-forget"
        disabled={!memoryEnabled && !memoryCleared}
        onClick={onForget}
        type="button"
      >
        <Trash2 aria-hidden="true" size={15} />
        Forget saved memory
      </button>
      {memoryCleared ? (
        <p className="assistant-memory-status">
          <Check aria-hidden="true" size={14} />
          Memory cleared
        </p>
      ) : null}
    </section>
  );
}

function validateStringWith(schema: z.ZodString) {
  return ({ value }: { readonly value: string }) => {
    const result = schema.safeParse(value);
    return result.success ? undefined : result.error.issues[0]?.message;
  };
}

function FieldErrors({ errors, id }: { readonly errors: readonly unknown[]; readonly id: string }) {
  const messages = errors.filter((error): error is string => typeof error === "string");
  return messages.length === 0 ? null : (
    <span id={id} role="alert">
      {messages.join(" ")}
    </span>
  );
}

export function AssistantMessageHistory({
  messages,
  onToolDecision,
  toolErrors,
  toolStatuses,
}: {
  readonly messages: readonly AssistantMessage[];
  readonly onToolDecision: (toolId: string, decision: "confirm" | "cancel") => void;
  readonly toolErrors: Readonly<Record<string, string | undefined>>;
  readonly toolStatuses: Readonly<Record<string, ToolStatus>>;
}) {
  return (
    <div className="assistant-thread" aria-label="Assistant conversation">
      <div className="assistant-thread-column">
        {messages.map((message) => (
          <article
            className={[
              "assistant-message",
              message.role === "user" ? "user-message" : "ai-message",
              message.status === "error" ? "assistant-message-error" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={message.id}
          >
            <header>
              <span className="assistant-message-avatar" aria-hidden="true">
                {message.role === "user" ? null : <Bot size={15} />}
              </span>
              <strong>{message.author}</strong>
              <time>{message.sentAt}</time>
            </header>
            <div className="assistant-message-body">
            {message.status === "error" ? (
              <p className="assistant-backend-error" role="alert">
                <CircleAlert aria-hidden="true" size={16} />
                Backend unavailable
              </p>
            ) : null}
            {message.streaming === true ? (
              <StreamingMessageBody body={message.body} />
            ) : (
              <ReadOnlyMessageBody body={message.body} />
            )}
            {message.citations?.length ? <CitationList citations={message.citations} /> : null}
            {message.toolCalls?.length ? (
              <div className="assistant-tool-list" aria-label="Tool calls">
                {message.toolCalls.map((toolCall) => (
                  <ToolCallCard
                    error={toolErrors[toolCall.id]}
                    key={toolCall.id}
                    onDecision={onToolDecision}
                    status={toolStatuses[toolCall.id] ?? toolCall.status}
                    toolCall={toolCall}
                  />
                ))}
              </div>
            ) : null}
            </div>
            {message.provenance ? <AIProvenanceBadge provenance={message.provenance} /> : null}
          </article>
        ))}
      </div>
    </div>
  );
}

function ReadOnlyMessageBody({ body }: { readonly body: string }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: tiptapDocumentFromText(body),
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "assistant-message-prose",
        "aria-label": "Message text",
      },
    },
  });

  return editor === null ? <p>{body}</p> : <EditorContent editor={editor} />;
}

/**
 * Renders an in-progress assistant response. Incrementally updating plain text
 * with a live cursor — re-initialising the rich-text editor per streamed
 * delta would be needlessly expensive.
 */
function StreamingMessageBody({ body }: { readonly body: string }) {
  if (body.length === 0) {
    return (
      <p className="assistant-streaming-status" aria-live="polite">
        <Sparkles aria-hidden="true" size={14} />
        Assistant is responding…
      </p>
    );
  }
  return (
    <p className="assistant-message-prose assistant-message-streaming" aria-live="polite">
      {body}
      <span className="assistant-stream-cursor" aria-hidden="true" />
    </p>
  );
}

function tiptapDocumentFromText(body: string) {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  return {
    type: "doc",
    content:
      paragraphs.length === 0
        ? [{ type: "paragraph" }]
        : paragraphs.map((paragraph) => ({
            type: "paragraph",
            content: [{ type: "text", text: paragraph }],
          })),
  };
}

function CitationList({ citations }: { readonly citations: readonly AssistantCitation[] }) {
  return (
    <div className="assistant-citations" aria-label="Retrieved sources">
      {citations.map((citation) => (
        <button
          className="assistant-citation-chip"
          key={citation.id}
          title={`${citation.source} (${citation.confidence})`}
          type="button"
        >
          <FileText aria-hidden="true" size={13} />
          <span>{citation.label}</span>
        </button>
      ))}
    </div>
  );
}
