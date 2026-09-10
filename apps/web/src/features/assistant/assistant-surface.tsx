import { cn } from "@/lib/utils";
import { iconMap as Icons } from "@/components/icon-map";
import {
  FileText as DocIcon,
  Pencil as EditPenIcon,
  History as HistoryIcon,
  Ellipsis as MoreIcon,
  EllipsisVertical as MoreVIcon,
  Pin as PinIcon,
  Plus as PlusIcon,
  Search as SearchIcon,
  Send as SendIcon,
  Sparkles as SparklesIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
/* Helix AI assistant surface.
   Recreated from the design handoff prototype (`app-assistant.jsx`) as
   production TSX: a 240px thread list, an empty/new hero state, a streaming
   conversation view with rich blocks, and an inline-model composer.

   The thread list (Pinned + Recent sections, "Search chats" input) is wired to
   the real `assistant.conversations.list` tool via TanStack Query, with
   pin/unpin/rename/delete and memory-forget all hitting `POST /api/tools/...`.
   Live replies stream from `streamAssistantChat`; selecting a past thread
   reopens it and continues the same backend conversation. */
import { SurfaceFrame } from "@/components/shell";
import { Avatar } from "@/components/ui/avatar";
import { Dialog } from "@/components/ui/helix-dialog";
import {
  deleteAssistantConversation,
  forgetAssistantMemory,
  renameAssistantConversation,
  setAssistantConversationPinned,
  streamAssistantChat,
  type AssistantConversationListItem,
  type AssistantTurnResponseWithPendingConfirmations,
} from "@/features/assistant/api";
import {
  ASSISTANT_ERROR_FALLBACK,
  ASSISTANT_QUICK_PROMPTS,
  assistantNowTime,
  type AssistantBlock,
  type AssistantChatMessage,
  type AssistantThread,
} from "@/features/assistant/assistant-data";
import {
  PendingApprovalsPanel,
  type PendingApprovalItem,
} from "@/features/assistant/pending-approvals";
import {
  ASSISTANT_QUERY_ROOT,
  assistantConversationsQueryOptions,
} from "@/features/assistant/queries";
import { applyAssistantToolDecision } from "@/features/assistant/tool-decisions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { bucketThreadsByDate, type ThreadSidebarItem } from "./date-buckets";
const USER_NAME = "You";
/** Maps a backend conversation list item to the seed thread shape. */
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
  const [threadId, setThreadId] = useState<string | null>(urlSearch.conversation ?? null);
  const [conversation, setConversation] = useState<readonly AssistantChatMessage[]>([]);
  const [hasMessages, setHasMessages] = useState(() => urlSearch.conversation !== undefined);
  const [pending, setPending] = useState(false);
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
  // Deep link: if the URL conversation id changes (back/forward/share), open it.
  useEffect(() => {
    const fromUrl = urlSearch.conversation;
    if (fromUrl === undefined) {
      return;
    }
    if (conversationIdRef.current === fromUrl && threadId === fromUrl) {
      return;
    }
    conversationIdRef.current = fromUrl;
    setThreadId(fromUrl);
    setHasMessages(true);
    setConversation([
      {
        id: `resume-${fromUrl}`,
        role: "assistant",
        text: "Conversation reopened. Send a message to pick up where you left off.",
        time: assistantNowTime(),
      },
    ]);
  }, [threadId, urlSearch.conversation]);
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
    (raw: string) => {
      const text = raw.trim();
      if (text.length === 0 || pending) {
        return;
      }
      setHasMessages(true);
      const turnId = `turn-${String(Date.now())}`;
      const userMessage: AssistantChatMessage = {
        id: `${turnId}-user`,
        role: "user",
        text,
        time: assistantNowTime(),
      };
      const assistantId = `${turnId}-assistant`;
      setConversation((prev) => [
        ...prev,
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
      void streamAssistantChat(
        { conversationId: conversationIdRef.current, message: text },
        {
          onDelta: (fragment) => {
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
          const finalText = turn.response?.content;
          const backendId = turn.conversation?.id;
          conversationIdRef.current = backendId ?? conversationIdRef.current;
          if (backendId !== undefined) {
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
              ...(finalText !== undefined && finalText.length > 0 ? { text: finalText } : {}),
            });
          }
          // A12: surface pending tool confirmations for explicit approve/deny.
          const fromTurn: PendingApprovalItem[] = (turn.pendingConfirmations ?? []).map(
            (pending) => ({
              id: pending.id,
              toolId: pending.toolId,
              status: "pending" as const,
            }),
          );
          const fromCalls: PendingApprovalItem[] = [];
          for (const call of turn.toolCalls ?? []) {
            if (call.pending !== undefined) {
              fromCalls.push({
                id: call.pending.id,
                toolId: call.pending.toolId,
                toolCallId: call.toolCallId,
                status: "pending",
              });
            }
          }
          setPendingApprovals(fromTurn.length > 0 ? fromTurn : fromCalls);
          invalidateConversations();
        })
        .catch(() => {
          patch({ streaming: false, errored: true, text: ASSISTANT_ERROR_FALLBACK });
        })
        .finally(() => {
          setPending(false);
        });
    },
    [pending, invalidateConversations, pushConversationUrl],
  );
  const decidePending = useCallback(
    async (item: PendingApprovalItem, decision: "confirm" | "cancel") => {
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
        await applyAssistantToolDecision({
          conversationId,
          pendingId: item.id,
          toolCallId: item.toolCallId ?? item.id,
          decision,
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
        setPendingApprovals((prev) =>
          prev.map((entry) =>
            entry.id === item.id
              ? { ...entry, status: decision === "confirm" ? "confirmed" : "cancelled" }
              : entry,
          ),
        );
      } catch {
        // Error state already set via setToolError when possible.
      } finally {
        setApprovalBusy(false);
      }
    },
    [],
  );
  const openThread = useCallback(
    (id: string) => {
      setThreadId(id);
      setHasMessages(true);
      // Reopen and continue this backend conversation. The full message history
      // hydrates from the next turn's persisted `messages`; until then we show a
      // resume hint so the user knows which conversation is active.
      conversationIdRef.current = id;
      setConversation([
        {
          id: `resume-${id}`,
          role: "assistant",
          text: "Conversation reopened. Send a message to pick up where you left off.",
          time: assistantNowTime(),
        },
      ]);
      pushConversationUrl(id);
    },
    [pushConversationUrl],
  );
  const startNewChat = useCallback(() => {
    setThreadId(null);
    setConversation([]);
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
        {hasMessages ? (
          <AssistantConversation
            conversation={conversation}
            pending={pending}
            onNavigate={navigateToSurface}
          />
        ) : (
          <AssistantHero onPrompt={send} />
        )}
        <PendingApprovalsPanel
          items={pendingApprovals}
          busy={approvalBusy}
          onConfirm={(item) => {
            void decidePending(item, "confirm");
          }}
          onCancel={(item) => {
            void decidePending(item, "cancel");
          }}
        />
        <AssistantComposer onSend={send} pending={pending || approvalBusy} />
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
  const visible = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (visible.length === 0) {
    return null;
  }
  return visible.map((message) => ({
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    text: message.content,
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
/**
 * ChatGPT-style virtualized thread list.
 *
 * The Pinned section is rendered eagerly (small, sticky-feeling). The Recent
 * section is grouped into date buckets (Today / Yesterday / Previous 7 Days /
 * Previous 30 Days / Month YYYY) and windowed via `useVirtualizer` so a
 * 10k-conversation history doesn't put 10k DOM rows on the page.
 *
 * Headers and rows share one virtualized index; the virtualizer measures each
 * element after mount so variable row heights (long titles wrap) lay out
 * correctly without us pre-computing sizes.
 */
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
                className="absolute top-0 left-0 w-full"
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
    <div className="relative">
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
        className="icon-btn absolute top-1.5 right-1 w-5.5 h-5.5"
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
          className="absolute top-7 right-1 [z-index:20] min-w-35 bg-card [border:1px_solid_var(--border)] rounded-lg [box-shadow:var(--shadow-md)] p-1 flex flex-col"
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
  readonly onPrompt: (prompt: string) => void;
}
function AssistantHero({ onPrompt }: AssistantHeroProps) {
  return (
    <div className="flex-1 overflow-y-auto [padding:48px_32px]">
      <div className="max-w-180 [margin:0_auto]">
        <div className="w-14 h-14 [border-radius:14px] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] grid [place-items:center] [color:white] mb-5 [box-shadow:var(--shadow-md)]">
          <SparklesIcon size={28} />
        </div>
        <h1 className="[font-size:var(--text-display)] font-bold [letter-spacing:-0.02em] [margin:0_0_8px] [line-height:1.1]">
          What can I help you with, <span className="text-primary">Alex</span>?
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
/* ---------------------------------------------------------- conversation -- */
interface AssistantConversationProps {
  readonly conversation: readonly AssistantChatMessage[];
  readonly pending: boolean;
  readonly onNavigate: (target: string) => void;
}
function AssistantConversation({ conversation, pending, onNavigate }: AssistantConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamingText = conversation
    .filter((message) => message.streaming === true)
    .map((message) => message.text)
    .join("");
  // Total virtualized count = N messages + 1 disclaimer footer row.
  const totalRows = conversation.length + 1;
  const virtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollRef.current,
    // ChatGPT-ish: bot replies are usually 200-400px tall, user prompts ~80px.
    // measureElement refines after first paint; estimate is just for layout.
    estimateSize: (index) => (index === conversation.length ? 56 : 240),
    overscan: 4,
    getItemKey: (index) =>
      index === conversation.length
        ? "disclaimer"
        : (conversation[index]?.id ?? `m:${String(index)}`),
  });
  // Streaming: keep the bottom row in view while the assistant types. We use
  // the virtualizer's scrollToIndex (not raw scrollTop) so the windowed list
  // measures + renders the target row before we land on it.
  useEffect(() => {
    if (totalRows === 0) return;
    virtualizer.scrollToIndex(totalRows - 1, { align: "end" });
    // We intentionally depend on length + streaming text + pending so every
    // delta nudges us back to the bottom even mid-stream.
  }, [virtualizer, totalRows, pending, streamingText]);
  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto [padding:24px_32px]"
      data-testid="assistant-conversation"
    >
      <div
        className="relative max-w-200 [margin:0_auto] w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtual) => {
          const isFooter = virtual.index === conversation.length;
          const message = isFooter ? null : conversation[virtual.index];
          if (!isFooter && message === undefined) return null;
          return (
            <div
              key={virtual.key}
              ref={virtualizer.measureElement}
              data-index={virtual.index}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${String(virtual.start)}px)` }}
            >
              {isFooter ? (
                <div className="flex justify-center [padding:16px_0]">
                  <span className="[font-size:var(--text-caption)] text-muted-foreground flex items-center gap-2">
                    <SparklesIcon size={16} /> Helix AI may produce inaccurate information. Verify
                    important details.
                  </span>
                </div>
              ) : (
                <ChatMessage message={message as AssistantChatMessage} onNavigate={onNavigate} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
interface ChatMessageProps {
  readonly message: AssistantChatMessage;
  readonly onNavigate: (target: string) => void;
}
function ChatMessage({ message, onNavigate }: ChatMessageProps) {
  if (message.role === "user") {
    return (
      <div className="flex gap-3 mb-5 justify-end">
        <div className="[background:var(--accent-soft)] text-foreground [padding:10px_14px] [border-radius:12px] max-w-130 [font-size:var(--text-body-sm)] [line-height:1.55] [border:1px_solid_var(--accent-soft-border)] whitespace-pre-wrap">
          {message.text}
        </div>
        <Avatar name={USER_NAME} size={28} />
      </div>
    );
  }
  const isPending = message.streaming === true && message.text.length === 0;
  return (
    <div className="flex gap-3 mb-6">
      <div className="w-7 h-7 rounded-lg shrink-0 [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [color:white] grid [place-items:center]">
        <SparklesIcon size={14} />
      </div>
      <div className="flex-1 min-w-0">
        {isPending ? (
          <PendingDots />
        ) : (
          <>
            {message.text.length > 0 && (
              <div className="[font-size:var(--text-body-sm)] [line-height:1.6] mb-3 whitespace-pre-wrap">
                {message.text}
              </div>
            )}
            {message.blocks?.map((block, index) => (
              <MessageBlock
                key={`${message.id}-block-${String(index)}`}
                block={block}
                onNavigate={onNavigate}
              />
            ))}
            {message.streaming !== true && (
              <div className="flex gap-1 mt-3">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Copy response"
                  onClick={() => {
                    void navigator.clipboard?.writeText(message.text);
                  }}
                >
                  <DocIcon size={16} />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
function PendingDots() {
  return (
    <div
      className="inline-flex gap-1 items-center [padding:10px_0]"
      role="status"
      aria-label="Helix AI is thinking"
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="w-1.5 h-1.5 [border-radius:999px] [background:var(--text-3)]"
          style={{ animation: `helix-pending 1.2s ${String(index * 0.15)}s infinite` }}
        />
      ))}
    </div>
  );
}
/* ----------------------------------------------------------------- block -- */
interface MessageBlockProps {
  readonly block: AssistantBlock;
  readonly onNavigate: (target: string) => void;
}
function MessageBlock({ block, onNavigate }: MessageBlockProps) {
  if (block.kind === "list") {
    return (
      <div className="bg-card [border:1px_solid_var(--border)] rounded-lg [padding:12px_14px] mb-2">
        <div className="font-semibold [font-size:var(--text-body-sm)] mb-2">{block.title}</div>
        <ul className="m-0 pl-4.5 [font-size:var(--text-meta)] [line-height:1.6]">
          {block.items.map((item, index) => (
            <li key={index} className="mb-1">
              {item}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (block.kind === "draft") {
    return (
      <div className="bg-card [border:1px_solid_var(--border)] rounded-lg mb-2 overflow-hidden">
        <div className="bg-muted [padding:8px_14px] [border-bottom:1px_solid_var(--border)] flex items-center gap-1.5 [font-size:var(--text-meta)]">
          <EditPenIcon size={16} />
          <span className="font-semibold">{block.title}</span>
          <span className="chip accent ml-auto">Draft</span>
        </div>
        <div className="[padding:12px_14px] whitespace-pre-wrap [font-size:var(--text-meta)] [line-height:1.6]">
          {block.body}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-1.5 flex-wrap">
      {block.items.map((action, index) => {
        const ActionIcon = Icons[action.icon];
        return (
          <button
            key={`${action.label}-${String(index)}`}
            type="button"
            className="btn sm"
            onClick={() => {
              if (action.target !== undefined) {
                onNavigate(action.target);
              }
            }}
          >
            <ActionIcon size={16} /> {action.label}
          </button>
        );
      })}
    </div>
  );
}
/* -------------------------------------------------------------- composer -- */
interface AssistantComposerProps {
  readonly onSend: (text: string) => void;
  readonly pending: boolean;
}
function AssistantComposer({ onSend, pending }: AssistantComposerProps) {
  const [text, setText] = useState("");
  const submit = useCallback(() => {
    if (text.trim().length === 0 || pending) {
      return;
    }
    onSend(text);
    setText("");
  }, [text, pending, onSend]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    [submit],
  );
  return (
    <div className="[padding:12px_32px_20px] shrink-0">
      <div className="max-w-200 [margin:0_auto]">
        <div className="[border:1px_solid_var(--border)] [border-radius:14px] bg-card p-1 [box-shadow:var(--shadow-sm)]">
          <textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything…"
            aria-label="Message Helix AI"
            className="w-full [padding:12px_14px] [border:none] outline-none bg-transparent [font-size:var(--text-body)] [line-height:1.5] [resize:none] min-h-15 [font-family:inherit] text-foreground"
          />
          <div className="flex [padding:4px_8px_6px] gap-1 items-center">
            <div className="flex-1" />
            <span className="[font-size:var(--text-caption)] text-muted-foreground">
              <span className="kbd">↵</span> send · <span className="kbd">⇧↵</span> newline
            </span>
            <button
              type="button"
              className={cn("btn primary sm", pending ? "[opacity:0.5]" : "[opacity:1]")}
              disabled={pending}
              onClick={submit}
              aria-label="Send message"
            >
              <SendIcon size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
