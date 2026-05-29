/* ChatShell — the Chat surface body, wired to the real chat backend.

   Layout is recreated from the design handoff (`app-sheets-meet-chat.jsx`,
   Chat section): a 240px spaces sidebar, the channel pane (header, message
   list, hover action bar, typing indicator, composer), and a right rail that
   switches between the 360px Thread panel and the 260px Tabbed info panel.

   Data is live:
   - Room and message lists come from the backend chat tools via TanStack
     Query (`queries.ts` → `api.ts`).
   - New messages, typing indicators, presence dots and read receipts ride the
     `/ws/chat` WebSocket (`use-chat-realtime.ts`).
   - On API error, the sidebar renders an "offline" notice instead of any
     fabricated rows. */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDebouncedCallback } from "@tanstack/react-pacer/debouncer";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Avatar } from "@/components/ui/avatar";
import { Icons } from "@/components/icons";
import { Tooltip } from "@/components/ui/tooltip";
import { SurfaceFrame } from "@/components/shell";
import {
  deleteChatMessage,
  editChatMessage,
  reactToChatMessage,
  sendChatMessage,
  type ChatMessageRecord,
  type ChatRoomRecord,
} from "./api";
import {
  chatMessageListQueryOptions,
  chatQueryKeys,
  chatRoomListQueryOptions,
} from "./queries";
import { useChatRealtime } from "./use-chat-realtime";
import {
  partitionRooms,
  presenceMap,
  readCountFor,
  roomAbout,
  roomMembers,
  roomDisplayName,
  toMessageView,
  type ChatAboutView,
  type ChatMemberView,
  type ChatMessageView,
  type ChatReactionView,
} from "./view-model";
import "./chat-shell.css";

type InfoTab = "about" | "members" | "files" | "pinned";

const QUICK_REACTIONS = ["👍", "🎉", "🙏", "👀", "✅"] as const;

export function ChatShell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const urlSearch: Partial<{ room: string; thread: string; tab: InfoTab }> =
    useSearch({ strict: false });
  const [activeRoomId, setActiveRoomId] = useState<string | undefined>(urlSearch.room);
  const [threadId, setThreadId] = useState<string | null>(urlSearch.thread ?? null);
  const [infoTab, setInfoTab] = useState<InfoTab>(urlSearch.tab ?? "about");
  const [search, setSearch] = useState("");

  const roomsQuery = useQuery(chatRoomListQueryOptions());
  const offline = roomsQuery.isError;
  const rooms = roomsQuery.data ?? [];

  // Realtime owns the WS connection; created once and re-subscribed per room.
  const realtime = useChatRealtime({ roomId: activeRoomId });
  const selfActorId = realtime.selfActorId;

  // Default the selection to the first room once the list resolves —
  // unless the URL already pinned a room (deep link).
  useEffect(() => {
    if (activeRoomId === undefined && rooms.length > 0) {
      setActiveRoomId(rooms[0]?.id);
    }
  }, [activeRoomId, rooms]);

  // URL sync — every chat state change pushes to the URL so deep links
  // and the back button work. The URL is canonical; state mirrors it.
  useEffect(() => {
    void navigate({
      to: "/chat",
      search: {
        ...(activeRoomId === undefined ? {} : { room: activeRoomId }),
        ...(threadId === null ? {} : { thread: threadId }),
        ...(infoTab === "about" ? {} : { tab: infoTab }),
      },
      replace: false,
    });
  }, [activeRoomId, threadId, infoTab]);

  const presence = useMemo(
    () => presenceMap(realtime.presence),
    [realtime.presence],
  );

  const { spaces, directs } = useMemo(
    () => partitionRooms(rooms, selfActorId, presence),
    [rooms, selfActorId, presence],
  );

  const activeRoom = useMemo<ChatRoomRecord | undefined>(
    () => rooms.find((r) => r.id === activeRoomId),
    [rooms, activeRoomId],
  );

  const messagesQuery = useQuery(chatMessageListQueryOptions(activeRoomId));

  // Name resolver: room members first, presence roster second.
  const nameForActor = useCallback(
    (actorId: string | null): string => {
      if (actorId === null) {
        return "System";
      }
      if (actorId === selfActorId) {
        return "You";
      }
      const member = (activeRoom?.members ?? []).find((m) => m.actorId === actorId);
      if (member?.displayName != null && member.displayName.length > 0) {
        return member.displayName;
      }
      const present = realtime.presence.find((p) => p.actorId === actorId);
      if (present?.displayName != null && present.displayName.length > 0) {
        return present.displayName;
      }
      return `User ${actorId.slice(0, 6)}`;
    },
    [activeRoom, selfActorId, realtime.presence],
  );

  // Locally-applied reactions: the list/WS payloads carry no reactions, so we
  // optimistically reflect the current actor's own reactions (see REPORT).
  const [localReactions, setLocalReactions] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});

  // History (query) + live (WS) merged and de-duplicated by id, oldest-first.
  const messageRecords = useMemo<readonly ChatMessageRecord[]>(() => {
    const history = messagesQuery.data ?? [];
    const byId = new Map<string, ChatMessageRecord>();
    // `chat.message.list` returns newest-first; reverse to oldest-first.
    for (const record of [...history].reverse()) {
      byId.set(record.id, record);
    }
    for (const record of realtime.liveMessages) {
      byId.set(record.id, record);
    }
    return [...byId.values()]
      .filter((m) => m.deletedAt === null)
      .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  }, [messagesQuery.data, realtime.liveMessages]);

  const orderedIds = useMemo(
    () => messageRecords.map((m) => m.id),
    [messageRecords],
  );

  const messages = useMemo<readonly ChatMessageView[]>(
    () =>
      messageRecords.map((record) => {
        const mine = localReactions[record.id] ?? [];
        const reactions: readonly ChatReactionView[] = mine.map((emoji) => ({
          emoji,
          count: 1,
          mine: true,
        }));
        return toMessageView({
          record,
          selfActorId,
          nameForActor,
          reactions,
          readBy: readCountFor(record.id, orderedIds, realtime.receipts, selfActorId),
        });
      }),
    [messageRecords, localReactions, selfActorId, nameForActor, orderedIds, realtime.receipts],
  );

  // Auto-mark the room read when the newest message changes.
  const newestId = orderedIds.at(-1);
  const lastMarkedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (newestId !== undefined && newestId !== lastMarkedRef.current) {
      lastMarkedRef.current = newestId;
      realtime.markRead(newestId);
    }
  }, [newestId, realtime]);

  const about: ChatAboutView = useMemo(() => roomAbout(activeRoom), [activeRoom]);
  const members: readonly ChatMemberView[] = useMemo(
    () => roomMembers(activeRoom),
    [activeRoom],
  );
  const roomName = activeRoom
    ? roomDisplayName(activeRoom, selfActorId)
    : "Chat";

  const threadMessage = threadId
    ? (messages.find((m) => m.id === threadId) ?? null)
    : null;

  // --- Mutations -------------------------------------------------------

  const [actionError, setActionError] = useState<string | null>(null);
  const clearActionError = useCallback(() => {
    setActionError(null);
  }, []);

  const invalidateMessages = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: chatQueryKeys.messages(activeRoomId),
    });
  }, [queryClient, activeRoomId]);

  const sendMutation = useMutation({
    mutationFn: (body: string) => {
      if (activeRoomId === undefined) {
        return Promise.reject(new Error("No room selected"));
      }
      return sendChatMessage({ roomId: activeRoomId, body });
    },
    onMutate: clearActionError,
    onError: () => {
      setActionError("Couldn’t send the message. Try again.");
    },
    onSuccess: invalidateMessages,
  });

  const reactMutation = useMutation({
    mutationFn: (input: { readonly messageId: string; readonly emoji: string }) =>
      reactToChatMessage({ messageId: input.messageId, emoji: input.emoji, op: "add" }),
    onMutate: clearActionError,
    onError: () => {
      setActionError("Couldn’t add the reaction. Try again.");
    },
  });

  const editMutation = useMutation({
    mutationFn: (input: { readonly messageId: string; readonly body: string }) =>
      editChatMessage(input),
    onMutate: clearActionError,
    onError: () => {
      setActionError("Couldn’t edit the message. Try again.");
    },
    onSuccess: invalidateMessages,
  });

  const deleteMutation = useMutation({
    mutationFn: (messageId: string) => deleteChatMessage(messageId),
    onMutate: clearActionError,
    onError: () => {
      setActionError("Couldn’t delete the message. Try again.");
    },
    onSuccess: invalidateMessages,
  });

  const handleSend = useCallback(
    (body: string) => {
      const trimmed = body.trim();
      if (trimmed.length === 0 || activeRoomId === undefined) {
        return;
      }
      // Prefer the live socket; fall back to the REST tool when it is closed.
      if (!realtime.sendMessage(trimmed)) {
        sendMutation.mutate(trimmed);
      }
    },
    [activeRoomId, realtime, sendMutation],
  );

  const handleReact = useCallback(
    (messageId: string, emoji: string) => {
      setLocalReactions((prev) => {
        const current = prev[messageId] ?? [];
        if (current.includes(emoji)) {
          return prev;
        }
        return { ...prev, [messageId]: [...current, emoji] };
      });
      reactMutation.mutate({ messageId, emoji });
    },
    [reactMutation],
  );

  const handleEdit = useCallback(
    (messageId: string, body: string) => {
      const trimmed = body.trim();
      if (trimmed.length > 0) {
        editMutation.mutate({ messageId, body: trimmed });
      }
    },
    [editMutation],
  );

  const handleDelete = useCallback(
    (messageId: string) => {
      deleteMutation.mutate(messageId);
      if (threadId === messageId) {
        setThreadId(null);
      }
    },
    [deleteMutation, threadId],
  );

  return (
    <SurfaceFrame
      title="Chat"
      icon={<Icons.Chat />}
      searchPlaceholder="Search messages and spaces"
      searchValue={search}
      onSearchChange={setSearch}
    >
      <div className="chat-body">
        <ChatSidebar
          loading={roomsQuery.isLoading}
          offline={offline}
          spaces={spaces}
          directs={directs}
          activeRoomId={activeRoomId}
          onSelect={(id) => {
            setActiveRoomId(id);
            setThreadId(null);
          }}
        />

        <section className="chat-channel" aria-label={`${roomName} channel`}>
          {realtime.connection === "closed" ? (
            <div className="chat-banner" role="status">
              Realtime disconnected — messages may be delayed.
            </div>
          ) : null}
          {actionError !== null ? (
            <div className="chat-banner chat-banner-error" role="alert">
              {actionError}
            </div>
          ) : null}

          <ChatChannelHeader name={roomName} memberCount={about.memberCount} />

          <ChatMessageList
            loading={messagesQuery.isLoading && activeRoomId !== undefined}
            error={messagesQuery.isError ? messagesQuery.error : null}
            offline={offline}
            messages={messages}
            threadId={threadId}
            onRetry={() => {
              void queryClient.invalidateQueries({
                queryKey: chatQueryKeys.messages(activeRoomId),
              });
            }}
            onOpenThread={setThreadId}
            onReact={handleReact}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />

          <ChatTypingIndicator
            names={realtime.typingActorIds.map((id) => nameForActor(id))}
          />

          <ChatComposer
            placeholder={`Message #${roomName}`}
            disabled={activeRoomId === undefined && !offline}
            onSend={handleSend}
            onTyping={realtime.setTyping}
          />
        </section>

        {threadMessage ? (
          <ChatThreadPanel
            spaceName={roomName}
            parent={threadMessage}
            onClose={() => {
              setThreadId(null);
            }}
            onReply={handleSend}
          />
        ) : (
          <ChatInfoPanel
            tab={infoTab}
            onTabChange={setInfoTab}
            about={about}
            members={members}
          />
        )}
      </div>
    </SurfaceFrame>
  );
}

/* ----------------------------------------------------------------
   Spaces sidebar — 240px
   ---------------------------------------------------------------- */

interface SidebarRowSpace {
  readonly id: string;
  readonly name: string;
  readonly memberCount: number;
  readonly unread: number;
}

interface SidebarRowDirect {
  readonly id: string;
  readonly name: string;
  readonly presence: "active" | "offline";
  readonly unread: number;
}

interface ChatSidebarProps {
  readonly loading: boolean;
  readonly offline: boolean;
  readonly spaces: readonly SidebarRowSpace[];
  readonly directs: readonly SidebarRowDirect[];
  readonly activeRoomId: string | undefined;
  readonly onSelect: (id: string) => void;
}

function ChatSidebar({
  loading,
  offline,
  spaces,
  directs,
  activeRoomId,
  onSelect,
}: ChatSidebarProps) {
  return (
    <aside className="surf-sidebar chat-sidebar" aria-label="Spaces and direct messages">
      <div className="chat-sidebar-section">
        <span>Spaces</span>
        <button
          type="button"
          className="icon-btn chat-sidebar-add"
          aria-label="Add space"
        >
          <Icons.Plus size={14} />
        </button>
      </div>

      {loading ? (
        <p className="chat-sidebar-state">Loading spaces…</p>
      ) : spaces.length === 0 ? (
        <p className="chat-sidebar-state">No spaces yet.</p>
      ) : (
        spaces.map((s) => {
          const selected = activeRoomId === s.id;
          return (
            <button
              key={s.id}
              type="button"
              className="surf-nav-row chat-nav-row"
              data-selected={selected}
              data-unread={s.unread > 0}
              aria-current={selected ? "true" : undefined}
              onClick={() => {
                onSelect(s.id);
              }}
            >
              <Icons.Hash size={16} />
              <span className="chat-nav-name truncate">{s.name}</span>
              {s.unread > 0 ? (
                <span className="chat-unread-badge">{s.unread}</span>
              ) : null}
            </button>
          );
        })
      )}

      <div className="chat-sidebar-section">
        <span>Direct messages</span>
        <button
          type="button"
          className="icon-btn chat-sidebar-add"
          aria-label="Start direct message"
        >
          <Icons.Plus size={14} />
        </button>
      </div>

      {loading ? (
        <p className="chat-sidebar-state">Loading…</p>
      ) : directs.length === 0 ? (
        <p className="chat-sidebar-state">No direct messages.</p>
      ) : (
        directs.map((d) => {
          const selected = activeRoomId === d.id;
          return (
            <button
              key={d.id}
              type="button"
              className="surf-nav-row chat-nav-row"
              data-selected={selected}
              data-unread={d.unread > 0}
              aria-current={selected ? "true" : undefined}
              onClick={() => {
                onSelect(d.id);
              }}
            >
              <span className="chat-presence-wrap">
                <Avatar name={d.name} size={20} />
                <span
                  className="chat-presence-dot"
                  data-presence={d.presence}
                  aria-label={d.presence === "active" ? "Active" : "Offline"}
                />
              </span>
              <span className="chat-nav-name truncate">{d.name}</span>
              {d.unread > 0 ? (
                <span className="chat-unread-badge">{d.unread}</span>
              ) : null}
            </button>
          );
        })
      )}

      {offline ? (
        <p className="chat-sidebar-state chat-sidebar-offline">
          Offline — chat rooms unavailable.
        </p>
      ) : null}
    </aside>
  );
}

/* ----------------------------------------------------------------
   Channel header
   ---------------------------------------------------------------- */

interface ChatChannelHeaderProps {
  readonly name: string;
  readonly memberCount: number;
}

function ChatChannelHeader({ name, memberCount }: ChatChannelHeaderProps) {
  return (
    <header className="chat-channel-header">
      <Icons.Hash size={16} />
      <span className="chat-channel-name">{name}</span>
      <span className="chat-channel-meta">· {memberCount} members</span>
      <div className="chat-channel-actions">
        <Tooltip label="Pinned" side="bottom">
          <button type="button" className="icon-btn" aria-label="Pinned messages">
            <Icons.Pin size={16} />
          </button>
        </Tooltip>
        <Tooltip label="Notifications" side="bottom">
          <button
            type="button"
            className="icon-btn"
            aria-label="Notification settings"
          >
            <Icons.Bell size={16} />
          </button>
        </Tooltip>
        <Tooltip label="More" side="bottom">
          <button
            type="button"
            className="icon-btn"
            aria-label="More channel actions"
          >
            <Icons.MoreV size={16} />
          </button>
        </Tooltip>
      </div>
    </header>
  );
}

/* ----------------------------------------------------------------
   Message list — loading / empty / error / data states
   ---------------------------------------------------------------- */

interface ChatMessageListProps {
  readonly loading: boolean;
  readonly error: unknown;
  readonly offline: boolean;
  readonly messages: readonly ChatMessageView[];
  readonly threadId: string | null;
  readonly onRetry: () => void;
  readonly onOpenThread: (id: string) => void;
  readonly onReact: (messageId: string, emoji: string) => void;
  readonly onEdit: (messageId: string, body: string) => void;
  readonly onDelete: (messageId: string) => void;
}

function ChatMessageList({
  loading,
  error,
  offline,
  messages,
  threadId,
  onRetry,
  onOpenThread,
  onReact,
  onEdit,
  onDelete,
}: ChatMessageListProps) {
  if (loading) {
    return (
      <div className="chat-messages" role="log" aria-label="Messages">
        <p className="chat-messages-state">Loading messages…</p>
      </div>
    );
  }

  if (error !== null && error !== undefined && !offline) {
    return (
      <div className="chat-messages" role="log" aria-label="Messages">
        <div className="chat-messages-state chat-messages-error">
          <p>Couldn’t load messages.</p>
          <button type="button" className="btn sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="chat-messages" role="log" aria-label="Messages">
        <p className="chat-messages-state">
          {offline
            ? "Offline — no messages available."
            : "No messages yet. Say hello!"}
        </p>
      </div>
    );
  }

  return (
    <VirtualizedChatMessages
      messages={messages}
      threadId={threadId}
      onOpenThread={onOpenThread}
      onReact={onReact}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}

interface VirtualizedChatMessagesProps {
  readonly messages: readonly ChatMessageView[];
  readonly threadId: string | null;
  readonly onOpenThread: (messageId: string) => void;
  readonly onReact: ChatMessageListProps["onReact"];
  readonly onEdit: ChatMessageListProps["onEdit"];
  readonly onDelete: ChatMessageListProps["onDelete"];
}

/**
 * Windowed render of a chat channel's message log via `@tanstack/react-virtual`.
 *
 * Channels routinely hold thousands of messages. The non-virtualized
 * implementation pushed a DOM node per row, which stalls the renderer well
 * before the first scroll. `useVirtualizer` keeps only the visible slice
 * mounted (~20 rows on a 1080p monitor) and uses `measureElement` for
 * variable-height rows.
 *
 * On every message-list change the bottom row is scrolled into view so live
 * messages appear at the bottom, matching Slack/Discord behaviour. Users who
 * have scrolled up are still pinned to "follow" until they manually scroll
 * back; this is the simplest correct behaviour and is what we ship for now —
 * a "jump to latest" affordance is a worthwhile follow-up.
 */
function VirtualizedChatMessages({
  messages,
  threadId,
  onOpenThread,
  onReact,
  onEdit,
  onDelete,
}: VirtualizedChatMessagesProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // count = 1 header ("Today") + N messages
  const rowCount = messages.length + 1;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (index === 0 ? 36 : 96),
    overscan: 6,
    getItemKey: (index) =>
      index === 0 ? "day-today" : (messages[index - 1]?.id ?? `m:${String(index)}`),
  });

  useEffect(() => {
    if (rowCount === 0) return;
    virtualizer.scrollToIndex(rowCount - 1, { align: "end" });
  }, [virtualizer, rowCount, messages]);

  return (
    <div
      ref={scrollRef}
      className="chat-messages"
      role="log"
      aria-label="Messages"
    >
      <div
        style={{
          position: "relative",
          height: virtualizer.getTotalSize(),
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((virtual) => {
          if (virtual.index === 0) {
            return (
              <div
                key={virtual.key}
                ref={virtualizer.measureElement}
                data-index={virtual.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${String(virtual.start)}px)`,
                }}
              >
                <div className="chat-day-divider">
                  <span className="chat-day-rule" />
                  <span className="chat-day-label">Today</span>
                  <span className="chat-day-rule" />
                </div>
              </div>
            );
          }
          const message = messages[virtual.index - 1];
          if (message === undefined) return null;
          return (
            <div
              key={virtual.key}
              ref={virtualizer.measureElement}
              data-index={virtual.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${String(virtual.start)}px)`,
              }}
            >
              <ChatMessageRow
                message={message}
                isActiveThread={threadId === message.id}
                onOpenThread={() => {
                  onOpenThread(message.id);
                }}
                onReact={onReact}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Message row + hover action bar
   ---------------------------------------------------------------- */

interface ChatMessageRowProps {
  readonly message: ChatMessageView;
  readonly isActiveThread: boolean;
  readonly onOpenThread: () => void;
  readonly onReact: (messageId: string, emoji: string) => void;
  readonly onEdit: (messageId: string, body: string) => void;
  readonly onDelete: (messageId: string) => void;
}

function ChatMessageRow({
  message,
  isActiveThread,
  onOpenThread,
  onReact,
  onEdit,
  onDelete,
}: ChatMessageRowProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);

  return (
    <article
      className="chat-msg"
      data-active-thread={isActiveThread}
      data-mine={message.isMine}
    >
      <Avatar name={message.authorName} size={32} />
      <div className="chat-msg-main">
        <div className="chat-msg-head">
          <span className="chat-msg-author">{message.authorName}</span>
          <span className="chat-msg-time">{message.time}</span>
          {message.editedAt !== null ? (
            <span className="chat-msg-edited">(edited)</span>
          ) : null}
        </div>

        {editing ? (
          <div className="chat-msg-edit">
            <textarea
              className="chat-composer-input chat-msg-edit-input"
              rows={2}
              aria-label="Edit message"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
            <div className="chat-msg-edit-actions">
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setEditing(false);
                  setDraft(message.body);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn primary sm"
                disabled={draft.trim().length === 0}
                onClick={() => {
                  onEdit(message.id, draft);
                  setEditing(false);
                }}
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <p className="chat-msg-line">{message.body}</p>
        )}

        {message.reactions.length > 0 ? (
          <div className="chat-reactions">
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                className="chat-reaction"
                data-mine={reaction.mine}
                aria-label={`${reaction.emoji} ${String(reaction.count)} reactions`}
                onClick={() => {
                  onReact(message.id, reaction.emoji);
                }}
              >
                <span aria-hidden="true">{reaction.emoji}</span>
                <span className="chat-reaction-count">{reaction.count}</span>
              </button>
            ))}
            <button
              type="button"
              className="icon-btn chat-reaction-add"
              aria-label="Add reaction"
              onClick={() => {
                setPickerOpen((open) => !open);
              }}
            >
              <Icons.Smile size={12} />
            </button>
          </div>
        ) : null}

        {pickerOpen ? (
          <div className="chat-reaction-picker" role="menu" aria-label="Pick a reaction">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="chat-reaction-pick"
                onClick={() => {
                  onReact(message.id, emoji);
                  setPickerOpen(false);
                }}
              >
                <span aria-hidden="true">{emoji}</span>
              </button>
            ))}
          </div>
        ) : null}

        {message.readBy > 0 ? (
          <span className="chat-msg-read" aria-label={`Seen by ${String(message.readBy)}`}>
            <Icons.Check size={11} />
            Seen by {message.readBy}
          </span>
        ) : null}
      </div>

      <div
        className="chat-msg-actions"
        role="toolbar"
        aria-label="Message actions"
      >
        <Tooltip label="React" side="bottom">
          <button
            type="button"
            className="icon-btn"
            aria-label="React"
            onClick={() => {
              setPickerOpen((open) => !open);
            }}
          >
            <Icons.Smile size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Reply in thread" side="bottom">
          <button
            type="button"
            className="icon-btn"
            aria-label="Reply in thread"
            onClick={onOpenThread}
          >
            <Icons.Comment size={14} />
          </button>
        </Tooltip>
        {message.isMine ? (
          <>
            <Tooltip label="Edit" side="bottom">
              <button
                type="button"
                className="icon-btn"
                aria-label="Edit message"
                onClick={() => {
                  setDraft(message.body);
                  setEditing(true);
                }}
              >
                <Icons.EditPen size={14} />
              </button>
            </Tooltip>
            <Tooltip label="Delete" side="bottom">
              <button
                type="button"
                className="icon-btn"
                aria-label="Delete message"
                onClick={() => {
                  onDelete(message.id);
                }}
              >
                <Icons.Trash size={14} />
              </button>
            </Tooltip>
          </>
        ) : null}
      </div>
    </article>
  );
}

/* ----------------------------------------------------------------
   Typing indicator — driven by realtime `typing` events
   ---------------------------------------------------------------- */

function ChatTypingIndicator({ names }: { readonly names: readonly string[] }) {
  if (names.length === 0) {
    return null;
  }

  const label =
    names.length === 1
      ? `${names[0] ?? ""} is typing…`
      : names.length === 2
        ? `${names[0] ?? ""} and ${names[1] ?? ""} are typing…`
        : `${String(names.length)} people are typing…`;

  return (
    <div className="chat-typing" aria-live="polite">
      <span className="chat-typing-dots" aria-hidden="true">
        <span className="chat-typing-dot" />
        <span className="chat-typing-dot" />
        <span className="chat-typing-dot" />
      </span>
      <span>{label}</span>
    </div>
  );
}

/* ----------------------------------------------------------------
   Composer (channel)
   ---------------------------------------------------------------- */

interface ChatComposerProps {
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly onSend: (body: string) => void;
  readonly onTyping: (isTyping: boolean) => void;
}

function ChatComposer({
  placeholder,
  disabled,
  onSend,
  onTyping,
}: ChatComposerProps) {
  const [draft, setDraft] = useState("");
  const typingRef = useRef(false);

  const stopTyping = useCallback(() => {
    if (typingRef.current) {
      typingRef.current = false;
      onTyping(false);
    }
  }, [onTyping]);

  // A debounced "stop typing" — re-armed on every keystroke, fires once the
  // composer goes quiet (replaces a native timeout, per Pacer discipline).
  const scheduleStopTyping = useDebouncedCallback(stopTyping, { wait: 3000 });

  useEffect(() => stopTyping, [stopTyping]);

  const handleChange = (value: string) => {
    setDraft(value);
    if (value.trim().length > 0) {
      if (!typingRef.current) {
        typingRef.current = true;
        onTyping(true);
      }
      scheduleStopTyping();
    } else {
      stopTyping();
    }
  };

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      return;
    }
    onSend(trimmed);
    setDraft("");
    stopTyping();
  };

  return (
    <div className="chat-composer-wrap">
      <div className="chat-composer">
        <div className="chat-composer-toolbar chat-composer-toolbar-top">
          <ToolbarButton label="Bold">
            <Icons.Bold size={16} />
          </ToolbarButton>
          <ToolbarButton label="Italic">
            <Icons.Italic size={16} />
          </ToolbarButton>
          <ToolbarButton label="Link">
            <Icons.Link size={16} />
          </ToolbarButton>
          <ToolbarButton label="List">
            <Icons.List size={16} />
          </ToolbarButton>
          <ToolbarButton label="Code">
            <Icons.Code size={16} />
          </ToolbarButton>
        </div>
        <textarea
          className="chat-composer-input"
          rows={4}
          placeholder={placeholder}
          aria-label={placeholder}
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            handleChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="chat-composer-toolbar">
          <ToolbarButton label="Attach">
            <Icons.Paperclip size={16} />
          </ToolbarButton>
          <ToolbarButton label="Emoji">
            <Icons.Smile size={16} />
          </ToolbarButton>
          <ToolbarButton label="Helix AI">
            <Icons.Sparkles size={16} />
          </ToolbarButton>
          <div className="chat-composer-spacer" />
          <button
            type="button"
            className="btn primary sm"
            disabled={disabled || draft.trim().length === 0}
            onClick={submit}
          >
            <Icons.Send size={14} />
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip label={label} side="bottom">
      <button type="button" className="icon-btn" aria-label={label}>
        {children}
      </button>
    </Tooltip>
  );
}

/* ----------------------------------------------------------------
   Thread panel — 360px
   ---------------------------------------------------------------- */

interface ChatThreadPanelProps {
  readonly spaceName: string;
  readonly parent: ChatMessageView;
  readonly onClose: () => void;
  readonly onReply: (body: string) => void;
}

function ChatThreadPanel({
  spaceName,
  parent,
  onClose,
  onReply,
}: ChatThreadPanelProps) {
  const [reply, setReply] = useState("");

  const submit = () => {
    const trimmed = reply.trim();
    if (trimmed.length === 0) {
      return;
    }
    // Threads share the room channel — replies post into the active room.
    onReply(trimmed);
    setReply("");
  };

  return (
    <aside className="chat-thread-panel" aria-label="Thread">
      <header className="chat-thread-header">
        <div>
          <div className="chat-thread-title">Thread</div>
          <div className="chat-thread-sub">in #{spaceName}</div>
        </div>
        <button
          type="button"
          className="icon-btn chat-thread-close"
          aria-label="Close thread"
          onClick={onClose}
        >
          <Icons.X size={16} />
        </button>
      </header>

      <div className="chat-thread-body">
        <div className="chat-thread-parent">
          <Avatar name={parent.authorName} size={28} />
          <div className="chat-msg-main">
            <div className="chat-msg-head">
              <span className="chat-thread-author">{parent.authorName}</span>
              <span className="chat-thread-time">{parent.time}</span>
            </div>
            <p className="chat-thread-line">{parent.body}</p>
          </div>
        </div>

        <div className="chat-thread-divider">Reply in #{spaceName}</div>
      </div>

      <div className="chat-thread-composer-wrap">
        <div className="chat-thread-composer">
          <textarea
            className="chat-thread-composer-input"
            rows={2}
            placeholder="Reply…"
            aria-label="Reply to thread"
            value={reply}
            onChange={(event) => {
              setReply(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="chat-composer-toolbar">
            <ToolbarButton label="Attach">
              <Icons.Paperclip size={13} />
            </ToolbarButton>
            <ToolbarButton label="Emoji">
              <Icons.Smile size={13} />
            </ToolbarButton>
            <div className="chat-composer-spacer" />
            <button
              type="button"
              className="btn primary sm chat-thread-send"
              aria-label="Send reply"
              disabled={reply.trim().length === 0}
              onClick={submit}
            >
              <Icons.Send size={12} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ----------------------------------------------------------------
   Info panel — 260px tabbed
   ---------------------------------------------------------------- */

interface ChatInfoPanelProps {
  readonly tab: InfoTab;
  readonly onTabChange: (tab: InfoTab) => void;
  readonly about: ChatAboutView;
  readonly members: readonly ChatMemberView[];
}

function ChatInfoPanel({
  tab,
  onTabChange,
  about,
  members,
}: ChatInfoPanelProps) {
  const tabs: ReadonlyArray<{ readonly id: InfoTab; readonly label: string }> =
    [
      { id: "about", label: "About" },
      { id: "members", label: `Members · ${String(members.length)}` },
      { id: "files", label: "Files" },
      { id: "pinned", label: "Pinned" },
    ];

  return (
    <aside className="chat-info-panel" aria-label="Channel info">
      <div className="chat-info-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`tab chat-info-tab ${tab === item.id ? "active" : ""}`}
            onClick={() => {
              onTabChange(item.id);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="chat-info-body" role="tabpanel">
        {tab === "about" ? (
          <>
            <p className="chat-info-about">{about.description}</p>
            <p className="chat-info-created">
              Created by {about.createdBy}
              {about.createdAt.length > 0 ? ` · ${about.createdAt}` : ""}
            </p>
            <div className="chat-info-about-actions">
              <button type="button" className="btn sm">
                <Icons.Bell size={13} />
                Notify
              </button>
              <button type="button" className="btn sm">
                <Icons.Pin size={13} />
                Pinned
              </button>
            </div>
          </>
        ) : null}

        {tab === "members" ? (
          members.length === 0 ? (
            <p className="chat-info-empty">No members.</p>
          ) : (
            members.map((member) => (
              <div key={member.actorId} className="chat-info-member">
                <Avatar name={member.name} size={22} />
                <div className="chat-info-member-text">
                  <div className="chat-info-member-name truncate">
                    {member.name}
                  </div>
                  <div className="chat-info-member-role truncate">
                    {member.role}
                  </div>
                </div>
              </div>
            ))
          )
        ) : null}

        {tab === "files" ? (
          <p className="chat-info-empty">No shared files yet.</p>
        ) : null}

        {tab === "pinned" ? (
          <p className="chat-info-empty">No pinned messages yet.</p>
        ) : null}
      </div>
    </aside>
  );
}
