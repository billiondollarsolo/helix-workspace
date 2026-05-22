/* Helix AI assistant surface.
   Recreated from the design handoff prototype (`app-assistant.jsx`) as
   production TSX: a 240px thread list, an empty/new hero state, a streaming
   conversation view with rich blocks, and an inline-model composer.

   The thread list (Pinned + Recent sections, "Search chats" input) is wired to
   the real `assistant.conversations.list` tool via TanStack Query, with
   pin/unpin/rename/delete and memory-forget all hitting `POST /api/tools/...`.
   Live replies stream from `streamAssistantChat`; selecting a past thread
   reopens it and continues the same backend conversation. The typed seed
   conversation/threads are an offline fallback only. */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Dialog } from "@/components/ui/helix-dialog";
import { SurfaceFrame } from "@/components/shell";
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
  ASSISTANT_QUERY_ROOT,
  assistantConversationsQueryOptions,
} from "@/features/assistant/queries";
import {
  ASSISTANT_ERROR_FALLBACK,
  ASSISTANT_MODELS,
  ASSISTANT_QUICK_PROMPTS,
  ASSISTANT_THREADS,
  assistantNowTime,
  type AssistantBlock,
  type AssistantChatMessage,
  type AssistantThread,
} from "@/features/assistant/assistant-data";

const USER_NAME = "Alex Park";

/** Maps a backend conversation list item to the seed thread shape. */
function toThread(item: AssistantConversationListItem): AssistantThread {
  return {
    id: item.id,
    title: item.title ?? "Untitled chat",
    time: relativeTime(item.updatedAt),
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
  const minutes = Math.round(diffMs / 60_000);
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
  const queryClient = useQueryClient();
  const [threadId, setThreadId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<readonly AssistantChatMessage[]>([]);
  const [hasMessages, setHasMessages] = useState(false);
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState("");
  const [renameTarget, setRenameTarget] = useState<AssistantThread | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssistantThread | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const conversationIdRef = useRef<string | undefined>(undefined);

  const trimmedSearch = search.trim();
  const conversationsQuery = useQuery(
    assistantConversationsQueryOptions(trimmedSearch.length === 0 ? {} : { query: trimmedSearch }),
  );

  const invalidateConversations = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [ASSISTANT_QUERY_ROOT, "conversations"] });
  }, [queryClient]);

  /* The backend list is the source of truth; the typed seed is an offline
     fallback shown only when the list query fails with no cached data. */
  const offline = conversationsQuery.isError && conversationsQuery.data === undefined;
  const threads: readonly AssistantThread[] = useMemo(() => {
    if (conversationsQuery.data !== undefined) {
      return conversationsQuery.data.items.map(toThread);
    }
    if (offline) {
      return ASSISTANT_THREADS;
    }
    return [];
  }, [conversationsQuery.data, offline]);

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
          }
          // Hydrate the full persisted history when the turn carries it; this
          // is how a continued conversation keeps every prior message.
          const hydrated = hydrateConversation(turn);
          if (hydrated !== null) {
            setConversation(hydrated);
          } else {
            patch({
              streaming: false,
              ...(finalText !== undefined && finalText.length > 0
                ? { text: finalText }
                : {}),
            });
          }
          invalidateConversations();
        })
        .catch(() => {
          patch({ streaming: false, errored: true, text: ASSISTANT_ERROR_FALLBACK });
        })
        .finally(() => {
          setPending(false);
        });
    },
    [pending, invalidateConversations],
  );

  const openThread = useCallback((id: string) => {
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
  }, []);

  const startNewChat = useCallback(() => {
    setThreadId(null);
    setConversation([]);
    setHasMessages(false);
    conversationIdRef.current = undefined;
  }, []);

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
    mutationFn: (input: { readonly conversationId: string }) =>
      deleteAssistantConversation(input),
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
      setNotice(
        `Forgot ${String(result.forgottenCount ?? 0)} saved memories. Memory is now off.`,
      );
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
      icon={<Icons.Sparkles />}
      searchPlaceholder="Search chats"
    >
      <AssistantThreadList
        threadId={threadId}
        threads={threads}
        loading={conversationsQuery.isLoading}
        offline={offline}
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
      <div style={mainPaneStyle}>
        {notice !== null && (
          <div role="status" style={noticeStyle}>
            <span>{notice}</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Dismiss notice"
              onClick={() => {
                setNotice(null);
              }}
            >
              <Icons.More />
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
        <AssistantComposer onSend={send} pending={pending} />
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

const mainPaneStyle: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  background: "var(--bg)",
};

const noticeStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "8px 32px",
  fontSize: 12,
  color: "var(--text-2)",
  background: "var(--surface-2)",
  borderBottom: "1px solid var(--border)",
};

/* ----------------------------------------------------------- thread list -- */

interface AssistantThreadListProps {
  readonly threadId: string | null;
  readonly threads: readonly AssistantThread[];
  readonly loading: boolean;
  readonly offline: boolean;
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
  offline,
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
    <aside style={threadListStyle}>
      <div style={{ padding: "12px 12px 8px" }}>
        <button
          type="button"
          className="btn primary lg"
          style={{ width: "100%" }}
          onClick={onNewChat}
        >
          <Icons.Plus /> New chat
        </button>
      </div>
      <div style={{ padding: "0 12px 8px" }}>
        <div className="search" style={{ height: 28 }}>
          <Icons.Search />
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
      <div style={threadScrollStyle} data-testid="assistant-thread-list">
        {loading && threads.length === 0 && (
          <div style={threadEmptyStyle}>Loading chats…</div>
        )}
        {offline && (
          <div style={threadEmptyStyle}>Offline — showing example chats.</div>
        )}
        {pinned.length > 0 && (
          <>
            <div className="section-label" style={sectionLabelStyle}>
              Pinned
            </div>
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
        {recent.length > 0 && (
          <>
            <div className="section-label" style={sectionLabelStyle}>
              Recent
            </div>
            {recent.map((thread) => (
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
        {!loading && threads.length === 0 && (
          <div style={threadEmptyStyle}>
            {search.trim().length > 0
              ? `No chats match “${search.trim()}”.`
              : "No chats yet — start a new one."}
          </div>
        )}
      </div>
      <div style={threadFooterStyle}>
        <button
          type="button"
          className="btn sm"
          style={{ width: "100%" }}
          disabled={forgetPending}
          onClick={onForget}
        >
          <Icons.History /> {forgetPending ? "Forgetting…" : "Forget memory"}
        </button>
      </div>
    </aside>
  );
}

const threadListStyle: CSSProperties = {
  width: 240,
  flexShrink: 0,
  borderRight: "1px solid var(--border)",
  background: "var(--surface)",
  display: "flex",
  flexDirection: "column",
};

const threadScrollStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "4px 8px",
};

const threadFooterStyle: CSSProperties = {
  padding: "8px 12px",
  borderTop: "1px solid var(--border)",
};

const sectionLabelStyle: CSSProperties = { padding: "8px 4px 6px" };

const threadEmptyStyle: CSSProperties = {
  padding: "12px 6px",
  fontSize: 12,
  color: "var(--text-3)",
};

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
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => {
          onSelect(thread.id);
        }}
        aria-current={active ? "true" : undefined}
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 2,
          padding: "8px 32px 8px 10px",
          borderRadius: 6,
          textAlign: "left",
          background: active ? "var(--accent-soft)" : "transparent",
          color: active ? "var(--accent)" : "var(--text)",
        }}
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
          className="truncate"
          style={{ fontSize: 12, fontWeight: active ? 600 : 500 }}
        >
          {thread.pinned === true ? "📌 " : ""}
          {thread.title}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-3)" }}>{thread.time}</span>
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Chat options for ${thread.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        style={threadMenuButtonStyle}
        onClick={(event) => {
          event.stopPropagation();
          setMenuOpen((open) => !open);
        }}
      >
        <Icons.MoreV />
      </button>
      {menuOpen && (
        <div role="menu" style={threadMenuStyle}>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            style={threadMenuItemStyle}
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              onTogglePin(thread);
            }}
          >
            <Icons.Pin /> {thread.pinned === true ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            style={threadMenuItemStyle}
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              onRename(thread);
            }}
          >
            <Icons.EditPen /> Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            style={{ ...threadMenuItemStyle, color: "var(--danger, #dc2626)" }}
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              onDelete(thread);
            }}
          >
            <Icons.Trash /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

const threadMenuButtonStyle: CSSProperties = {
  position: "absolute",
  top: 6,
  right: 4,
  width: 22,
  height: 22,
};

const threadMenuStyle: CSSProperties = {
  position: "absolute",
  top: 28,
  right: 4,
  zIndex: 20,
  minWidth: 140,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  boxShadow: "var(--shadow-md)",
  padding: 4,
  display: "flex",
  flexDirection: "column",
};

const threadMenuItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 8px",
  borderRadius: 6,
  fontSize: 12,
  textAlign: "left",
  background: "transparent",
};

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
      <label style={{ display: "block", fontSize: 12, marginBottom: 6 }}>
        Chat title
      </label>
      <input
        className="input"
        aria-label="Chat title"
        value={value}
        autoFocus
        style={{ width: "100%" }}
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
      title="Delete chat"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? "Deleting…" : "Delete"}
          </button>
        </>
      }
    >
      <p style={{ fontSize: 13, margin: 0 }}>
        Delete <strong>{thread.title}</strong>? This removes it from your thread
        list and can&apos;t be undone.
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
    <div style={heroScrollStyle}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div style={heroIconStyle}>
          <Icons.Sparkles size={28} />
        </div>
        <h1 style={heroTitleStyle}>
          What can I help you with,{" "}
          <span style={{ color: "var(--accent)" }}>Alex</span>?
        </h1>
        <p style={heroSubheadStyle}>
          Connected to Mail, Docs, Drive, Calendar, and Sheets. Ask anything,
          draft anything, or pick a prompt below.
        </p>
        <div style={heroGridStyle}>
          {ASSISTANT_QUICK_PROMPTS.map((prompt) => {
            const PromptIcon = Icons[prompt.icon];
            return (
              <button
                key={prompt.title}
                type="button"
                onClick={() => {
                  onPrompt(prompt.title);
                }}
                style={quickPromptStyle}
                onMouseEnter={(event) => {
                  event.currentTarget.style.borderColor =
                    "var(--accent-soft-border)";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <span
                  style={{
                    ...quickPromptTileStyle,
                    background: `${prompt.color}1f`,
                    color: prompt.color,
                  }}
                >
                  <PromptIcon />
                </span>
                <span>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>
                    {prompt.title}
                  </span>
                  <span
                    style={{
                      display: "block",
                      fontSize: 11,
                      color: "var(--text-3)",
                      marginTop: 2,
                    }}
                  >
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

const heroScrollStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "48px 32px",
};

const heroIconStyle: CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: 14,
  background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
  display: "grid",
  placeItems: "center",
  color: "white",
  marginBottom: 20,
  boxShadow: "var(--shadow-md)",
};

const heroTitleStyle: CSSProperties = {
  fontSize: 32,
  fontWeight: 700,
  letterSpacing: "-0.02em",
  margin: "0 0 8px",
  lineHeight: 1.1,
};

const heroSubheadStyle: CSSProperties = {
  fontSize: 15,
  color: "var(--text-2)",
  margin: "0 0 32px",
};

const heroGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, 1fr)",
  gap: 10,
};

const quickPromptStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 14,
  display: "flex",
  alignItems: "center",
  gap: 12,
  textAlign: "left",
  transition: "border-color 0.15s",
};

const quickPromptTileStyle: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 8,
  display: "grid",
  placeItems: "center",
  flexShrink: 0,
};

/* ---------------------------------------------------------- conversation -- */

interface AssistantConversationProps {
  readonly conversation: readonly AssistantChatMessage[];
  readonly pending: boolean;
  readonly onNavigate: (target: string) => void;
}

function AssistantConversation({
  conversation,
  pending,
  onNavigate,
}: AssistantConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamingText = conversation
    .filter((message) => message.streaming === true)
    .map((message) => message.text)
    .join("");

  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null) {
      node.scrollTop = node.scrollHeight;
    }
  }, [conversation.length, pending, streamingText]);

  return (
    <div ref={scrollRef} style={conversationScrollStyle} data-testid="assistant-conversation">
      <div style={{ maxWidth: 800, margin: "0 auto" }}>
        {conversation.map((message) => (
          <ChatMessage key={message.id} message={message} onNavigate={onNavigate} />
        ))}
        <div style={disclaimerRowStyle}>
          <span style={disclaimerStyle}>
            <Icons.Sparkles /> Helix AI may produce inaccurate information. Verify
            important details.
          </span>
        </div>
      </div>
    </div>
  );
}

const conversationScrollStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "24px 32px",
};

const disclaimerRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "center",
  padding: "16px 0",
};

const disclaimerStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--text-3)",
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const sparkleTileStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  flexShrink: 0,
  background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
  color: "white",
  display: "grid",
  placeItems: "center",
};

interface ChatMessageProps {
  readonly message: AssistantChatMessage;
  readonly onNavigate: (target: string) => void;
}

function ChatMessage({ message, onNavigate }: ChatMessageProps) {
  if (message.role === "user") {
    return (
      <div style={userRowStyle}>
        <div style={userBubbleStyle}>{message.text}</div>
        <Avatar name={USER_NAME} size={28} />
      </div>
    );
  }

  const isPending = message.streaming === true && message.text.length === 0;
  return (
    <div style={assistantRowStyle}>
      <div style={sparkleTileStyle}>
        <Icons.Sparkles size={14} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {isPending ? (
          <PendingDots />
        ) : (
          <>
            {message.text.length > 0 && (
              <div style={assistantTextStyle}>{message.text}</div>
            )}
            {message.blocks?.map((block, index) => (
              <MessageBlock
                key={`${message.id}-block-${String(index)}`}
                block={block}
                onNavigate={onNavigate}
              />
            ))}
            {message.streaming !== true && (
              <div style={{ display: "flex", gap: 4, marginTop: 12 }}>
                <button type="button" className="icon-btn" aria-label="Copy response">
                  <Icons.Doc />
                </button>
                <button type="button" className="icon-btn" aria-label="Good response">
                  <Icons.Check />
                </button>
                <button type="button" className="icon-btn" aria-label="Regenerate">
                  <Icons.Sparkles />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const userRowStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  marginBottom: 20,
  justifyContent: "flex-end",
};

const userBubbleStyle: CSSProperties = {
  background: "var(--accent-soft)",
  color: "var(--text)",
  padding: "10px 14px",
  borderRadius: 12,
  maxWidth: 520,
  fontSize: 13,
  lineHeight: 1.55,
  border: "1px solid var(--accent-soft-border)",
  whiteSpace: "pre-wrap",
};

const assistantRowStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  marginBottom: 24,
};

const assistantTextStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
  marginBottom: 12,
  whiteSpace: "pre-wrap",
};

function PendingDots() {
  return (
    <div
      style={{ display: "inline-flex", gap: 4, alignItems: "center", padding: "10px 0" }}
      role="status"
      aria-label="Helix AI is thinking"
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "var(--text-3)",
            animation: `helix-pending 1.2s ${String(index * 0.15)}s infinite`,
          }}
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
      <div style={listPanelStyle}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
          {block.title}
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
          {block.items.map((item, index) => (
            <li key={index} style={{ marginBottom: 4 }}>
              {item}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (block.kind === "draft") {
    return (
      <div style={draftPanelStyle}>
        <div style={draftToolbarStyle}>
          <Icons.EditPen />
          <span style={{ fontWeight: 600 }}>{block.title}</span>
          <span className="chip accent" style={{ marginLeft: "auto" }}>
            Draft
          </span>
        </div>
        <div style={draftBodyStyle}>{block.body}</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
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
            <ActionIcon /> {action.label}
          </button>
        );
      })}
    </div>
  );
}

const listPanelStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "12px 14px",
  marginBottom: 8,
};

const draftPanelStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  marginBottom: 8,
  overflow: "hidden",
};

const draftToolbarStyle: CSSProperties = {
  background: "var(--surface-2)",
  padding: "8px 14px",
  borderBottom: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
};

const draftBodyStyle: CSSProperties = {
  padding: "12px 14px",
  whiteSpace: "pre-wrap",
  fontSize: 12,
  lineHeight: 1.6,
};

/* -------------------------------------------------------------- composer -- */

interface AssistantComposerProps {
  readonly onSend: (text: string) => void;
  readonly pending: boolean;
}

function AssistantComposer({ onSend, pending }: AssistantComposerProps) {
  const [text, setText] = useState("");
  const [model, setModel] = useState(ASSISTANT_MODELS[0]?.value ?? "helix-pro");

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
    <div style={{ padding: "12px 32px 20px", flexShrink: 0 }}>
      <div style={{ maxWidth: 800, margin: "0 auto" }}>
        <div style={composerCardStyle}>
          <textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything, or @mention a doc, person, or file…"
            aria-label="Message Helix AI"
            style={composerTextareaStyle}
          />
          <div style={composerToolbarStyle}>
            <button type="button" className="icon-btn" aria-label="Attach file">
              <Icons.Paperclip />
            </button>
            <button type="button" className="icon-btn" aria-label="Reference doc">
              <Icons.Doc />
            </button>
            <button type="button" className="icon-btn" aria-label="Mention a person">
              <Icons.Users />
            </button>
            <select
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
              }}
              aria-label="Assistant model"
              className="select"
              style={composerSelectStyle}
            >
              {ASSISTANT_MODELS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--text-3)" }}>
              <span className="kbd">↵</span> send · <span className="kbd">⇧↵</span>{" "}
              newline
            </span>
            <button
              type="button"
              className="btn primary sm"
              disabled={pending}
              onClick={submit}
              aria-label="Send message"
              style={{ opacity: pending ? 0.5 : 1 }}
            >
              <Icons.Send />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const composerCardStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 14,
  background: "var(--surface)",
  padding: 4,
  boxShadow: "var(--shadow-sm)",
};

const composerTextareaStyle: CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  border: "none",
  outline: "none",
  background: "transparent",
  fontSize: 14,
  lineHeight: 1.5,
  resize: "none",
  minHeight: 60,
  fontFamily: "inherit",
  color: "var(--text)",
};

const composerToolbarStyle: CSSProperties = {
  display: "flex",
  padding: "4px 8px 6px",
  gap: 4,
  alignItems: "center",
};

const composerSelectStyle: CSSProperties = {
  width: "auto",
  height: 26,
  fontSize: 11,
  padding: "0 24px 0 8px",
  border: "none",
  background: "transparent",
  color: "var(--text-2)",
};
