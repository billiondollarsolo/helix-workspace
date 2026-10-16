import { AssistantComposer } from "./assistant-composer";
import { AssistantConversation } from "./assistant-conversation";
import { Sparkles as SparklesIcon, X as CloseIcon } from "lucide-react";
/* Assistant conversations and actions use the backend tools. Replies stream
   through streamAssistantChat; selecting a thread continues that conversation.
   `/assistant?prompt=…` (the side panel's suggestions) starts a new chat. */
import { SurfaceFrame } from "@/components/shell";
import { Dialog } from "@/components/ui/helix-dialog";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import {
  deleteAssistantConversation,
  isAssistantBackendConversationId,
  forgetAssistantMemory,
  renameAssistantConversation,
  setAssistantConversationPinned,
  streamAssistantChat,
  type AssistantConversationListItem,
  type AssistantAttachment,
} from "@/features/assistant/api";
import {
  ASSISTANT_ERROR_FALLBACK,
  assistantNowTime,
  type AssistantChatMessage,
  type AssistantThread,
} from "@/features/assistant/assistant-data";
import {
  PendingApprovalsPanel,
  pendingItemsFromTurn,
  type PendingApprovalItem,
} from "@/features/assistant/pending-approvals";
import {
  ASSISTANT_QUERY_ROOT,
  assistantConversationsQueryOptions,
  assistantConversationQueryOptions,
} from "@/features/assistant/queries";
import { applyAssistantToolDecision } from "@/features/assistant/tool-decisions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssistantHero } from "./assistant-hero";
import { AssistantThreadList } from "./assistant-thread-list";
import { AssistantRequestError } from "./tool-limit";
import { hydrateConversation } from "./conversation-history";
import { sessionUserQueryOptions } from "@/lib/auth";
import { randomId } from "@/lib/random-id";
function toThread(item: AssistantConversationListItem): AssistantThread {
  const updatedAtMs = Date.parse(item.updatedAt);
  return {
    id: item.id,
    title: item.title ?? "Untitled chat",
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
    ...(item.pinned ? { pinned: true } : {}),
  };
}
/* ---------------------------------------------------------------- shell -- */
export function AssistantSurface() {
  const navigate = useNavigate();
  const urlSearch: {
    readonly conversation?: string;
    readonly prompt?: string;
  } = useSearch({ strict: false });
  const queryClient = useQueryClient();
  const userName = useQuery(sessionUserQueryOptions()).data?.name.trim() ?? "";
  const [threadId, setThreadId] = useState<string | null>(urlSearch.conversation ?? null);
  const [conversation, setConversation] = useState<readonly AssistantChatMessage[]>([]);
  const [hasMessages, setHasMessages] = useState(() => urlSearch.conversation !== undefined);
  const [pending, setPending] = useState(false);
  const [toolGroups, setToolGroups] = useState<readonly string[] | undefined>();
  const [webSearch, setWebSearch] = useState(false);
  const [modelId, setModelId] = useState("");
  const [editing, setEditing] = useState<AssistantChatMessage | null>(null);
  const streamController = useRef<AbortController | null>(null);
  const [search, setSearch] = useState("");
  const [renameTarget, setRenameTarget] = useState<AssistantThread | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssistantThread | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<readonly PendingApprovalItem[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const conversationIdRef = useRef<string | undefined>(urlSearch.conversation);
  const pushConversationUrl = useCallback(
    (conversationId: string | null) => {
      void navigate({
        to: "/assistant",
        search: conversationId === null ? {} : { conversation: conversationId },
        replace: false,
      });
    },
    [navigate],
  );
  useEffect(
    () => () => {
      streamController.current?.abort();
    },
    [],
  );
  // URL navigation and sidebar selection both hydrate the persisted conversation.
  useEffect(() => {
    const fromUrl = urlSearch.conversation;
    if (conversationIdRef.current === fromUrl) return;
    streamController.current?.abort();
    streamController.current = null;
    setPending(false);
    conversationIdRef.current = fromUrl;
    setThreadId(fromUrl ?? null);
    setHasMessages(fromUrl !== undefined);
    setConversation([]);
    setToolGroups(undefined);
    setWebSearch(false);
    setEditing(null);
    setPendingApprovals([]);
  }, [urlSearch.conversation]);
  const historyQuery = useQuery({
    ...assistantConversationQueryOptions(threadId),
    enabled: threadId !== null && !pending,
  });
  useEffect(() => {
    if (!pending && conversation.length === 0 && historyQuery.data !== undefined) {
      const hydrated = hydrateConversation(historyQuery.data);
      if (hydrated !== null) {
        setConversation(hydrated);
        const lastUser = [...hydrated].reverse().find((message) => message.role === "user");
        setToolGroups(lastUser?.toolGroups);
        setWebSearch(lastUser?.webSearch === true);
      }
    }
  }, [historyQuery.data, pending, conversation.length]);
  const trimmedSearch = search.trim();
  const conversationsQuery = useQuery(
    assistantConversationsQueryOptions(trimmedSearch.length === 0 ? {} : { query: trimmedSearch }),
  );
  const invalidateConversations = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [ASSISTANT_QUERY_ROOT, "conversations"] });
  }, [queryClient]);
  /* The backend list is the source of truth. On error or while loading the
       sidebar renders an empty list (the surface shows its own loading/error
       affordances elsewhere). */
  const threads: readonly AssistantThread[] = useMemo(
    () =>
      conversationsQuery.data !== undefined ? conversationsQuery.data.items.map(toThread) : [],
    [conversationsQuery.data],
  );
  const send = useCallback(
    (
      raw: string,
      attachments: readonly AssistantAttachment[] = [],
      requestedModelId = modelId,
      webSearch = false,
      selectedToolGroups = toolGroups,
      editedMessage: AssistantChatMessage | null = null,
    ): Promise<boolean> => {
      const text = raw.trim();
      if (text.length === 0 || pending || streamController.current !== null) {
        return Promise.resolve(false);
      }
      const controller = new AbortController();
      streamController.current = controller;
      void queryClient.cancelQueries({
        queryKey: [ASSISTANT_QUERY_ROOT, "conversation", threadId],
      });
      setHasMessages(true);
      const turnId = `turn-${randomId()}`;
      const userMessage: AssistantChatMessage = {
        id: `${turnId}-user`,
        role: "user",
        text,
        attachments,
        webSearch,
        ...(selectedToolGroups === undefined ? {} : { toolGroups: selectedToolGroups }),
        time: assistantNowTime(),
      };
      const assistantId = `${turnId}-assistant`;
      const originalConversation = conversation;
      setConversation((prev) => [
        ...(editedMessage === null
          ? prev
          : prev.slice(
              0,
              Math.max(
                0,
                prev.findIndex((message) => message.id === editedMessage.id),
              ),
            )),
        userMessage,
        {
          id: assistantId,
          role: "assistant",
          text: "",
          time: assistantNowTime(),
          streaming: true,
        },
      ]);
      setPending(true);
      const patch = (changes: Partial<AssistantChatMessage>) => {
        setConversation((prev) =>
          prev.map((message) =>
            message.id === assistantId ? { ...message, ...changes } : message,
          ),
        );
      };
      return streamAssistantChat(
        {
          conversationId: conversationIdRef.current,
          message: text,
          ...(isAssistantBackendConversationId(editedMessage?.id)
            ? { editMessageId: editedMessage.id }
            : {}),
          ...(requestedModelId ? { modelId: requestedModelId } : {}),
          webSearch,
          ...(selectedToolGroups === undefined ? {} : { toolGroups: selectedToolGroups }),
          attachmentObjectIds: attachments.map(({ objectId }) => objectId),
        },
        {
          signal: controller.signal,
          onTool: (activity) => {
            if (controller.signal.aborted || streamController.current !== controller) return;
            setConversation((prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      toolActivity: [
                        ...(message.toolActivity ?? []).filter(
                          (entry) => entry.toolCallId !== activity.toolCallId,
                        ),
                        activity,
                      ],
                    }
                  : message,
              ),
            );
          },
          onDelta: (fragment) => {
            if (controller.signal.aborted || streamController.current !== controller) return;
            setConversation((prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? { ...message, text: message.text + fragment }
                  : message,
              ),
            );
          },
        },
      )
        .then((turn) => {
          if (controller.signal.aborted || streamController.current !== controller) return false;
          setEditing(null);
          setToolGroups(selectedToolGroups);
          const finalText = turn.response?.content;
          const backendId = turn.conversation?.id;
          conversationIdRef.current = backendId ?? conversationIdRef.current;
          if (backendId !== undefined) {
            queryClient.setQueryData(assistantConversationQueryOptions(backendId).queryKey, turn);
            setThreadId(backendId);
            pushConversationUrl(backendId);
          }
          // Hydrate the full persisted history when the turn carries it; this
          // is how a continued conversation keeps every prior message.
          const hydrated = hydrateConversation(turn);
          if (hydrated !== null) {
            setConversation(hydrated);
          } else {
            patch({
              streaming: false,
              ...(turn.sources === undefined ? {} : { sources: turn.sources }),
              ...(finalText !== undefined && finalText.length > 0 ? { text: finalText } : {}),
            });
          }
          setPendingApprovals(pendingItemsFromTurn(turn));
          invalidateConversations();
          return true;
        })
        .catch((cause: unknown) => {
          if (streamController.current === controller && editedMessage !== null) {
            setConversation(originalConversation);
            setNotice(
              controller.signal.aborted
                ? "Response stopped. Your original conversation is unchanged."
                : cause instanceof Error
                  ? cause.message
                  : ASSISTANT_ERROR_FALLBACK,
            );
          } else if (streamController.current === controller)
            patch({
              streaming: false,
              errored: !controller.signal.aborted,
              error: controller.signal.aborted
                ? "Response stopped."
                : cause instanceof Error
                  ? `${cause.message} Your message wasn't saved; your draft is kept below for retry.`
                  : ASSISTANT_ERROR_FALLBACK,
              ...(cause instanceof AssistantRequestError && cause.toolLimit !== undefined
                ? { toolLimit: cause.toolLimit }
                : {}),
            });
          return false;
        })
        .finally(() => {
          if (streamController.current === controller) {
            streamController.current = null;
            setPending(false);
          }
        });
    },
    [
      pending,
      modelId,
      toolGroups,
      queryClient,
      threadId,
      conversation,
      invalidateConversations,
      pushConversationUrl,
    ],
  );
  const decidePending = useCallback(
    async (
      item: PendingApprovalItem,
      decision: "confirm" | "cancel",
      metadata?: Record<string, unknown>,
    ) => {
      const conversationId = conversationIdRef.current;
      if (conversationId === undefined) {
        return;
      }
      setApprovalBusy(true);
      setPendingApprovals((prev) =>
        prev.map((entry) =>
          entry.id === item.id ? { ...entry, status: "running", error: undefined } : entry,
        ),
      );
      try {
        const result = await applyAssistantToolDecision({
          conversationId,
          pendingId: item.id,
          toolCallId: item.toolCallId ?? item.id,
          decision,
          ...(metadata === undefined ? {} : { metadata }),
          setToolError: (_toolCallId, message) => {
            setPendingApprovals((prev) =>
              prev.map((entry) =>
                entry.id === item.id
                  ? {
                      ...entry,
                      status: "pending",
                      ...(message === undefined ? {} : { error: message }),
                    }
                  : entry,
              ),
            );
          },
          setToolStatus: (_toolCallId, status) => {
            setPendingApprovals((prev) =>
              prev.map((entry) => (entry.id === item.id ? { ...entry, status } : entry)),
            );
          },
        });
        if (result.turn !== undefined) {
          queryClient.setQueryData(
            assistantConversationQueryOptions(conversationId).queryKey,
            result.turn,
          );
        }
        if (conversationIdRef.current !== conversationId) return;
        if (result.turn !== undefined) {
          const hydrated = hydrateConversation(result.turn);
          if (hydrated !== null) setConversation(hydrated);
        }
        if (result.error !== undefined) setNotice(result.error);
        setPendingApprovals((prev) =>
          prev.map((entry) => (entry.id === item.id ? { ...entry, status: result.status } : entry)),
        );
        invalidateConversations();
      } catch {
        // Error state already set via setToolError when possible.
      } finally {
        setApprovalBusy(false);
      }
    },
    [queryClient, invalidateConversations],
  );
  const openThread = useCallback(
    (id: string) => {
      setThreadId(id);
      setHasMessages(true);
      streamController.current?.abort();
      streamController.current = null;
      setPending(false);
      setPendingApprovals([]);
      conversationIdRef.current = id;
      setConversation([]);
      setToolGroups(undefined);
      setWebSearch(false);
      setEditing(null);
      pushConversationUrl(id);
    },
    [pushConversationUrl],
  );
  const startNewChat = useCallback(() => {
    streamController.current?.abort();
    streamController.current = null;
    setPending(false);
    setPendingApprovals([]);
    setThreadId(null);
    setConversation([]);
    setToolGroups(undefined);
    setWebSearch(false);
    setEditing(null);
    setHasMessages(false);
    conversationIdRef.current = undefined;
    pushConversationUrl(null);
  }, [pushConversationUrl]);
  // The side panel hands a prompt over in the URL; send it once as a new chat.
  const handedPrompt = urlSearch.prompt;
  const handledPrompt = useRef<string | null>(null);
  useEffect(() => {
    if (handedPrompt === undefined || handledPrompt.current === handedPrompt) return;
    handledPrompt.current = handedPrompt;
    void navigate({ to: "/assistant", search: {}, replace: true });
    void send(handedPrompt);
  }, [handedPrompt, navigate, send]);
  /** The user message an answer replies to. */
  const promptFor = useCallback(
    (answer: AssistantChatMessage) => {
      const index = conversation.findIndex((message) => message.id === answer.id);
      return conversation
        .slice(0, Math.max(0, index))
        .reverse()
        .find((message) => message.role === "user");
    },
    [conversation],
  );
  const resend = useCallback(
    (message: AssistantChatMessage, groups = message.toolGroups) => {
      void send(
        message.text,
        message.attachments ?? [],
        modelId,
        message.webSearch ?? false,
        groups,
        message,
      );
    },
    [send, modelId],
  );
  const navigateToSurface = useCallback(
    (target: string) => {
      void navigate({ to: `/${target}` });
    },
    [navigate],
  );
  /* ------------------------------------------------------------- mutations */
  const clearNotice = useCallback(() => {
    setNotice(null);
  }, []);
  const pinMutation = useMutation({
    mutationFn: (input: { readonly conversationId: string; readonly pinned: boolean }) =>
      setAssistantConversationPinned(input),
    onMutate: clearNotice,
    onSuccess: invalidateConversations,
    onError: () => {
      setNotice("Couldn't update the pin. Try again.");
    },
  });
  const renameMutation = useMutation({
    mutationFn: (input: { readonly conversationId: string; readonly title: string }) =>
      renameAssistantConversation(input),
    onMutate: clearNotice,
    onSuccess: () => {
      setRenameTarget(null);
      invalidateConversations();
    },
    onError: () => {
      setNotice("Couldn't rename the chat. Try again.");
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (input: { readonly conversationId: string }) => deleteAssistantConversation(input),
    onMutate: clearNotice,
    onSuccess: (_result, input) => {
      setDeleteTarget(null);
      if (conversationIdRef.current === input.conversationId) {
        startNewChat();
      }
      invalidateConversations();
    },
    onError: () => {
      setNotice("Couldn't delete the chat. Try again.");
    },
  });
  const forgetMutation = useMutation({
    mutationFn: () =>
      forgetAssistantMemory(
        conversationIdRef.current === undefined
          ? {}
          : { conversationId: conversationIdRef.current },
      ),
    onMutate: clearNotice,
    onSuccess: (result) => {
      setNotice(`Forgot ${String(result.forgottenCount ?? 0)} saved memories. Memory is now off.`);
    },
    onError: () => {
      setNotice("Couldn't forget memory. Try again.");
    },
  });
  const togglePin = useCallback(
    (thread: AssistantThread) => {
      pinMutation.mutate({
        conversationId: thread.id,
        pinned: thread.pinned !== true,
      });
    },
    [pinMutation],
  );
  const composerProps = {
    toolGroups,
    onToolGroupsChange: setToolGroups,
    pending,
    disabled:
      approvalBusy || (threadId !== null && (historyQuery.isPending || historyQuery.isError)),
    onStop: () => streamController.current?.abort(),
    modelId,
    onModelChange: setModelId,
    onNewChat: startNewChat,
    onCancelEdit: () => setEditing(null),
  };
  return (
    <SurfaceFrame
      title="Helix AI"
      icon={<SparklesIcon size={16} />}
      searchPlaceholder="Search chats"
      searchValue={search}
      onSearchChange={setSearch}
    >
      <AssistantThreadList
        threadId={threadId}
        threads={threads}
        loading={conversationsQuery.isLoading}
        errored={conversationsQuery.isError}
        retrying={conversationsQuery.isFetching}
        onRetry={invalidateConversations}
        search={search}
        onSelect={openThread}
        onNewChat={startNewChat}
        onTogglePin={togglePin}
        onRename={setRenameTarget}
        onDelete={setDeleteTarget}
        onForget={() => {
          forgetMutation.mutate();
        }}
        forgetPending={forgetMutation.isPending}
      />
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        {notice !== null && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 [padding:8px_32px] type-meta [color:var(--text-2)] bg-muted [border-bottom:1px_solid_var(--border)]"
          >
            <span>{notice}</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Dismiss notice"
              onClick={() => {
                setNotice(null);
              }}
            >
              <CloseIcon size={16} />
            </button>
          </div>
        )}
        {threadId !== null && !pending && historyQuery.isPending ? (
          <Skeleton
            variant="text"
            count={6}
            label="Loading conversation"
            className="mx-auto w-full max-w-200 px-3 py-6 sm:px-8"
          />
        ) : null}
        {threadId !== null && historyQuery.isError ? (
          <InlineError
            className="mx-3 my-4 sm:mx-8"
            title="Couldn't load this conversation"
            message="Check your connection and try again."
            retryLabel="Retry conversation"
            retrying={historyQuery.isFetching}
            onRetry={() => {
              void queryClient.invalidateQueries({
                queryKey: assistantConversationQueryOptions(threadId).queryKey,
              });
            }}
          />
        ) : null}
        {hasMessages ? (
          <AssistantConversation
            conversationId={threadId}
            conversation={conversation}
            userName={userName}
            pending={pending || approvalBusy}
            onNavigate={navigateToSurface}
            onEdit={setEditing}
            onResend={resend}
            onRegenerate={(answer) => {
              const prompt = promptFor(answer);
              if (prompt !== undefined) resend(prompt);
            }}
            onTurnOffToolGroup={(answer, groupId) => {
              const prompt = promptFor(answer);
              if (prompt === undefined) return;
              const groups = (
                prompt.toolGroups ??
                answer.toolLimit?.groups.map((group) => group.id) ??
                []
              ).filter((id) => id !== groupId);
              setToolGroups(groups);
              resend(prompt, groups);
            }}
          />
        ) : (
          <AssistantHero
            onPrompt={(text) => {
              void send(text);
            }}
            userName={userName}
          />
        )}
        <PendingApprovalsPanel
          items={pendingApprovals}
          busy={approvalBusy}
          onConfirm={(item, metadata) => {
            void decidePending(item, "confirm", metadata);
          }}
          onCancel={(item) => {
            void decidePending(item, "cancel");
          }}
        />
        <div hidden={editing !== null} className="shrink-0">
          <AssistantComposer
            {...composerProps}
            key={threadId ?? "new"}
            webSearch={webSearch}
            onWebSearchChange={setWebSearch}
            onSend={send}
          />
        </div>
        {editing !== null ? (
          <AssistantComposer
            {...composerProps}
            key={editing.id}
            editing={editing}
            onSend={(text, attachments, selectedModel, searchEnabled, selectedGroups) =>
              send(text, attachments, selectedModel, searchEnabled, selectedGroups, editing)
            }
          />
        ) : null}
      </div>
      {renameTarget !== null && (
        <RenameDialog
          thread={renameTarget}
          pending={renameMutation.isPending}
          onCancel={() => {
            setRenameTarget(null);
          }}
          onSubmit={(title) => {
            renameMutation.mutate({ conversationId: renameTarget.id, title });
          }}
        />
      )}
      {deleteTarget !== null && (
        <DeleteDialog
          thread={deleteTarget}
          pending={deleteMutation.isPending}
          onCancel={() => {
            setDeleteTarget(null);
          }}
          onConfirm={() => {
            deleteMutation.mutate({ conversationId: deleteTarget.id });
          }}
        />
      )}
    </SurfaceFrame>
  );
}
/* ------------------------------------------------------- rename / delete -- */
interface RenameDialogProps {
  readonly thread: AssistantThread;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (title: string) => void;
}
function RenameDialog({ thread, pending, onCancel, onSubmit }: RenameDialogProps) {
  const [value, setValue] = useState(thread.title);
  const trimmed = value.trim();
  const submit = () => {
    if (trimmed.length > 0 && !pending) {
      onSubmit(trimmed);
    }
  };
  return (
    <Dialog
      modal={false}
      title="Rename chat"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={pending || trimmed.length === 0}
            onClick={submit}
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <label className="block type-meta mb-1.5">Chat title</label>
      <input
        className="input w-full"
        aria-label="Chat title"
        value={value}
        autoFocus

        onChange={(event) => {
          setValue(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
      />
    </Dialog>
  );
}
interface DeleteDialogProps {
  readonly thread: AssistantThread;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}
function DeleteDialog({ thread, pending, onCancel, onConfirm }: DeleteDialogProps) {
  return (
    <Dialog
      title="Archive chat"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn danger" disabled={pending} onClick={onConfirm}>
            {pending ? "Archiving…" : "Archive"}
          </button>
        </>
      }
    >
      <p className="type-body-sm m-0">
        Archive <strong>{thread.title}</strong>? It will disappear from your thread list. The
        conversation history is retained server-side.
      </p>
    </Dialog>
  );
}
