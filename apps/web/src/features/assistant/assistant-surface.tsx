import { AssistantComposer } from "./assistant-composer";
import { AssistantConversation } from "./assistant-conversation";
import { cn } from "@/lib/utils";
import { iconMap as Icons } from "@/components/icon-map";
import {
  Pencil as EditPenIcon,
  History as HistoryIcon,
  Ellipsis as MoreIcon,
  EllipsisVertical as MoreVIcon,
  Pin as PinIcon,
  Plus as PlusIcon,
  Search as SearchIcon,
  Sparkles as SparklesIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
/* Assistant conversations and actions use the backend tools. Replies stream
   through streamAssistantChat; selecting a thread continues that conversation. */
import { SurfaceFrame } from "@/components/shell";
import { Dialog } from "@/components/ui/helix-dialog";
import {
  deleteAssistantConversation,
  isAssistantBackendConversationId,
  forgetAssistantMemory,
  renameAssistantConversation,
  setAssistantConversationPinned,
  streamAssistantChat,
  type AssistantConversationListItem,
  type AssistantAttachment,
  type AssistantTurnResponseWithPendingConfirmations,
} from "@/features/assistant/api";
import {
  ASSISTANT_ERROR_FALLBACK,
  ASSISTANT_QUICK_PROMPTS,
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
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bucketThreadsByDate, type ThreadSidebarItem } from "./date-buckets";
import { sessionUserQueryOptions } from "@/lib/auth";
function toThread(item: AssistantConversationListItem): AssistantThread {
  const updatedAtMs = Date.parse(item.updatedAt);
  return {
    id: item.id,
    title: item.title ?? "Untitled chat",
    time: relativeTime(item.updatedAt),
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
    ...(item.pinned ? { pinned: true } : {}),
  };
}
/** Renders an ISO timestamp as a coarse "10m ago" style label. */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "";
  }
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${String(minutes)}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${String(hours)}h ago`;
  }
  const days = Math.round(hours / 24);
  return days === 1 ? "Yesterday" : `${String(days)} days ago`;
}
/* ---------------------------------------------------------------- shell -- */
export function AssistantSurface() {
  const navigate = useNavigate();
  const urlSearch: {
    readonly conversation?: string;
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
      const turnId = `turn-${crypto.randomUUID()}`;
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
                  ? cause.message
                  : ASSISTANT_ERROR_FALLBACK,
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
    initialToolGroups: toolGroups,
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
    >
      <AssistantThreadList
        threadId={threadId}
        threads={threads}
        loading={conversationsQuery.isLoading}
        errored={conversationsQuery.isError}
        search={search}
        onSearchChange={setSearch}
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
            className="flex items-center justify-between gap-3 [padding:8px_32px] [font-size:var(--text-meta)] [color:var(--text-2)] bg-muted [border-bottom:1px_solid_var(--border)]"
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
              <MoreIcon size={16} />
            </button>
          </div>
        )}
        {threadId !== null && !pending && historyQuery.isPending ? (
          <p role="status" className="p-4">
            Loading conversation…
          </p>
        ) : null}
        {threadId !== null && historyQuery.isError ? (
          <p role="alert" className="p-4">
            Could not load this conversation.{" "}
            <button
              className="btn sm"
              type="button"
              onClick={() => {
                void queryClient.invalidateQueries({
                  queryKey: assistantConversationQueryOptions(threadId).queryKey,
                });
              }}
            >
              Retry conversation
            </button>
          </p>
        ) : null}
        {hasMessages ? (
          <AssistantConversation
            conversation={conversation}
            userName={userName}
            pending={pending || approvalBusy}
            onNavigate={navigateToSurface}
            onEdit={setEditing}
            onResend={(message) => {
              void send(
                message.text,
                message.attachments ?? [],
                modelId,
                message.webSearch ?? false,
                message.toolGroups,
                message,
              );
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
/** Builds a UI conversation from a turn's persisted `messages`, or null. */
function hydrateConversation(
  turn: AssistantTurnResponseWithPendingConfirmations,
): readonly AssistantChatMessage[] | null {
  const messages = turn.messages;
  if (messages === undefined || messages.length === 0) {
    return null;
  }
  // Each tool round persists cumulative details; show them once, on the last
  // assistant message before the next user turn, including pending-only replies.
  const finalAssistantIds = new Set<string>();
  let hasLaterAssistant = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") hasLaterAssistant = false;
    if (message?.role === "assistant" && !hasLaterAssistant) {
      finalAssistantIds.add(message.id);
      hasLaterAssistant = true;
    }
  }
  const visible = messages.filter(
    (message) =>
      message.role === "user" ||
      (message.role === "assistant" &&
        (message.content.trim().length > 0 ||
          (finalAssistantIds.has(message.id) &&
            (message.toolActivity?.length || message.sources?.length)))),
  );
  if (visible.length === 0) {
    return null;
  }
  return visible.map((message) => ({
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    text: message.content,
    ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
    ...(message.sources === undefined || !finalAssistantIds.has(message.id)
      ? {}
      : { sources: message.sources }),
    ...(message.toolActivity === undefined || !finalAssistantIds.has(message.id)
      ? {}
      : { toolActivity: message.toolActivity }),
    ...(message.toolGroups === undefined ? {} : { toolGroups: message.toolGroups }),
    ...(message.webSearch === undefined ? {} : { webSearch: message.webSearch }),
    time:
      message.createdAt === undefined
        ? assistantNowTime()
        : assistantNowTime(new Date(message.createdAt)),
  }));
}
/* ----------------------------------------------------------- thread list -- */
interface AssistantThreadListProps {
  readonly threadId: string | null;
  readonly threads: readonly AssistantThread[];
  readonly loading: boolean;
  readonly errored: boolean;
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onNewChat: () => void;
  readonly onTogglePin: (thread: AssistantThread) => void;
  readonly onRename: (thread: AssistantThread) => void;
  readonly onDelete: (thread: AssistantThread) => void;
  readonly onForget: () => void;
  readonly forgetPending: boolean;
}
function AssistantThreadList({
  threadId,
  threads,
  loading,
  errored,
  search,
  onSearchChange,
  onSelect,
  onNewChat,
  onTogglePin,
  onRename,
  onDelete,
  onForget,
  forgetPending,
}: AssistantThreadListProps) {
  const pinned = threads.filter((thread) => thread.pinned === true);
  const recent = threads.filter((thread) => thread.pinned !== true);
  return (
    <aside className="assistant-thread-sidebar w-60 shrink-0 [border-right:1px_solid_var(--border)] bg-card flex flex-col">
      <div className="[padding:12px_12px_8px]">
        <button
          type="button"
          className="btn primary lg w-full"

          onClick={onNewChat}
        >
          <PlusIcon size={16} /> New chat
        </button>
      </div>
      <div className="[padding:0_12px_8px]">
        <div className="search h-7">
          <SearchIcon size={16} />
          <input
            placeholder="Search chats"
            aria-label="Search chats"
            value={search}
            onChange={(event) => {
              onSearchChange(event.target.value);
            }}
          />
        </div>
      </div>
      <VirtualizedThreadList
        loading={loading}
        errored={errored}
        search={search}
        threadId={threadId}
        pinned={pinned}
        recent={recent}
        onSelect={onSelect}
        onTogglePin={onTogglePin}
        onRename={onRename}
        onDelete={onDelete}
      />
      <div className="[padding:8px_12px] [border-top:1px_solid_var(--border)]">
        <button
          type="button"
          className="btn sm w-full"

          disabled={forgetPending}
          onClick={onForget}
        >
          <HistoryIcon size={16} /> {forgetPending ? "Forgetting…" : "Forget memory"}
        </button>
      </div>
    </aside>
  );
}
interface VirtualizedThreadListProps {
  readonly loading: boolean;
  readonly errored: boolean;
  readonly search: string;
  readonly threadId: string | null;
  readonly pinned: readonly AssistantThread[];
  readonly recent: readonly AssistantThread[];
  readonly onSelect: (id: string) => void;
  readonly onTogglePin: (thread: AssistantThread) => void;
  readonly onRename: (thread: AssistantThread) => void;
  readonly onDelete: (thread: AssistantThread) => void;
}
/** Pinned threads render eagerly; recent threads and date headers share a
 * measured virtual list so long histories and wrapped titles stay bounded. */
function VirtualizedThreadList({
  loading,
  errored,
  search,
  threadId,
  pinned,
  recent,
  onSelect,
  onTogglePin,
  onRename,
  onDelete,
}: VirtualizedThreadListProps) {
  const sidebarItems = useMemo<readonly ThreadSidebarItem[]>(
    () => bucketThreadsByDate(recent),
    [recent],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    useFlushSync: false,
    count: sidebarItems.length,
    getScrollElement: () => scrollRef.current,
    // Headers ~28px, threads ~52px on average. Estimate roughly; measureElement
    // refines after first render.
    estimateSize: (index) => (sidebarItems[index]?.kind === "header" ? 28 : 52),
    overscan: 6,
    getItemKey: (index) => {
      const item = sidebarItems[index];
      if (item === undefined) return index;
      return item.kind === "header" ? `h:${item.id}` : `t:${item.thread.id}`;
    },
  });
  if (loading && pinned.length === 0 && recent.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto [padding:4px_8px]" data-testid="assistant-thread-list">
        <div className="[padding:12px_6px] [font-size:var(--text-meta)] text-muted-foreground">
          Loading chats…
        </div>
      </div>
    );
  }
  if (errored && pinned.length === 0 && recent.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto [padding:4px_8px]" data-testid="assistant-thread-list">
        <div className="[padding:12px_6px] [font-size:var(--text-meta)] text-muted-foreground">
          Chats unavailable — try again later.
        </div>
      </div>
    );
  }
  if (!loading && pinned.length === 0 && recent.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto [padding:4px_8px]" data-testid="assistant-thread-list">
        <div className="[padding:12px_6px] [font-size:var(--text-meta)] text-muted-foreground">
          {search.trim().length > 0
            ? `No chats match “${search.trim()}”.`
            : "No chats yet — start a new one."}
        </div>
      </div>
    );
  }
  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto [padding:4px_8px]"
      data-testid="assistant-thread-list"
    >
      {pinned.length > 0 && (
        <>
          <div className="section-label [padding:8px_4px_6px]">Pinned</div>
          {pinned.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              active={threadId === thread.id}
              onSelect={onSelect}
              onTogglePin={onTogglePin}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </>
      )}

      {sidebarItems.length > 0 && (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtual) => {
            const item = sidebarItems[virtual.index];
            if (item === undefined) return null;
            return (
              <div
                key={virtual.key}
                ref={virtualizer.measureElement}
                data-index={virtual.index}
                className="absolute top-0 left-0 w-full has-[[role=menu]]:z-30"
                style={{ transform: `translateY(${String(virtual.start)}px)` }}
              >
                {item.kind === "header" ? (
                  <div className="section-label [padding:8px_4px_6px]">{item.label}</div>
                ) : (
                  <ThreadItem
                    thread={item.thread}
                    active={threadId === item.thread.id}
                    onSelect={onSelect}
                    onTogglePin={onTogglePin}
                    onRename={onRename}
                    onDelete={onDelete}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
interface ThreadItemProps {
  readonly thread: AssistantThread;
  readonly active: boolean;
  readonly onSelect: (id: string) => void;
  readonly onTogglePin: (thread: AssistantThread) => void;
  readonly onRename: (thread: AssistantThread) => void;
  readonly onDelete: (thread: AssistantThread) => void;
}
function ThreadItem({
  thread,
  active,
  onSelect,
  onTogglePin,
  onRename,
  onDelete,
}: ThreadItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const close = () => {
      setMenuOpen(false);
    };
    window.addEventListener("click", close);
    return () => {
      window.removeEventListener("click", close);
    };
  }, [menuOpen]);
  return (
    <div className={cn("relative", menuOpen ? "z-30" : "")}>
      <button
        type="button"
        onClick={() => {
          onSelect(thread.id);
        }}
        aria-current={active ? "true" : undefined}
        className={cn(
          "w-full flex flex-col gap-0.5 [padding:8px_32px_8px_10px] rounded-md text-left",
          active ? "[background:var(--accent-soft)]" : "bg-transparent",
          active ? "text-primary" : "text-foreground",
        )}
        onMouseEnter={(event) => {
          if (!active) {
            event.currentTarget.style.background = "var(--hover)";
          }
        }}
        onMouseLeave={(event) => {
          if (!active) {
            event.currentTarget.style.background = "transparent";
          }
        }}
      >
        <span
          className={cn(
            "truncate",
            "[font-size:var(--text-meta)]",
            active ? "font-semibold" : "font-medium",
          )}
        >
          {thread.pinned === true ? "📌 " : ""}
          {thread.title}
        </span>
        <span className="[font-size:var(--text-caption)] text-muted-foreground">{thread.time}</span>
      </button>
      <button
        type="button"
        className="icon-btn absolute top-1.5 right-1 w-6 h-6"
        aria-label={`Chat options for ${thread.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}

        onClick={(event) => {
          event.stopPropagation();
          setMenuOpen((open) => !open);
        }}
      >
        <MoreVIcon size={16} />
      </button>
      {menuOpen && (
        <div
          role="menu"
          className="absolute top-7 right-1 z-50 min-w-35 rounded-lg border p-1 flex flex-col [background:var(--surface)] [border-color:var(--border)] [box-shadow:var(--shadow-md)]"
        >
          <button
            type="button"
            role="menuitem"
            className="menu-item flex items-center gap-2 w-full [padding:6px_8px] rounded-md [font-size:var(--text-meta)] text-left bg-transparent"

            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              onTogglePin(thread);
            }}
          >
            <PinIcon size={16} /> {thread.pinned === true ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item flex items-center gap-2 w-full [padding:6px_8px] rounded-md [font-size:var(--text-meta)] text-left bg-transparent"

            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              onRename(thread);
            }}
          >
            <EditPenIcon size={16} /> Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item flex items-center gap-2 w-full [padding:6px_8px] rounded-md [font-size:var(--text-meta)] text-left bg-transparent [color:var(--danger,_#dc2626)]"

            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              onDelete(thread);
            }}
          >
            <TrashIcon size={16} /> Archive
          </button>
        </div>
      )}
    </div>
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
      <label className="block [font-size:var(--text-meta)] mb-1.5">Chat title</label>
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
      <p className="[font-size:var(--text-body-sm)] m-0">
        Archive <strong>{thread.title}</strong>? It will disappear from your thread list. The
        conversation history is retained server-side.
      </p>
    </Dialog>
  );
}
/* ------------------------------------------------------------------ hero -- */
interface AssistantHeroProps {
  readonly userName: string;
  readonly onPrompt: (prompt: string) => void;
}
function AssistantHero({ onPrompt, userName }: AssistantHeroProps) {
  return (
    <div className="flex-1 overflow-y-auto [padding:48px_32px]">
      <div className="max-w-180 [margin:0_auto]">
        <div className="w-14 h-14 [border-radius:14px] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] grid [place-items:center] [color:white] mb-5 [box-shadow:var(--shadow-md)]">
          <SparklesIcon size={28} />
        </div>
        <h1 className="[font-size:var(--text-display)] font-bold [letter-spacing:-0.02em] [margin:0_0_8px] [line-height:1.1]">
          What can I help you with
          {userName && (
            <>
              , <span className="text-primary">{userName}</span>
            </>
          )}
          ?
        </h1>
        <p className="[font-size:var(--text-body-lg)] [color:var(--text-2)] [margin:0_0_32px]">
          {"Connected to Mail, Drive, and Chat. Ask about your workspace or pick a prompt below."}
        </p>
        <div className="grid [grid-template-columns:repeat(2,_1fr)] gap-2.5">
          {ASSISTANT_QUICK_PROMPTS.map((prompt) => {
            const PromptIcon = Icons[prompt.icon];
            return (
              <button
                key={prompt.title}
                type="button"
                onClick={() => {
                  onPrompt(prompt.title);
                }}
                className="bg-card [border:1px_solid_var(--border)] [border-radius:10px] p-3.5 flex items-center gap-3 text-left [transition:border-color_0.15s]"
                onMouseEnter={(event) => {
                  event.currentTarget.style.borderColor = "var(--accent-soft-border)";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <span
                  className="w-9 h-9 rounded-lg grid [place-items:center] shrink-0"
                  style={{ background: `${prompt.color}1f`, color: prompt.color }}
                >
                  <PromptIcon size={16} />
                </span>
                <span>
                  <span className="block [font-size:var(--text-body-sm)] font-semibold">
                    {prompt.title}
                  </span>
                  <span className="block [font-size:var(--text-caption)] text-muted-foreground mt-0.5">
                    {prompt.sub}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
