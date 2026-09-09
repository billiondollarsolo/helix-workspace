// ponytail: chat-shell.tsx ~1330 LOC — intentional composition root pending
// split into chat-sidebar / message-list / composer / info-panel (B4). Ceiling
// tracked; extraction is non-behavior-changing and deferred behind green suite.

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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Avatar } from "@/components/ui/avatar";
import { Icons } from "@/components/icons";
import { Tooltip } from "@/components/ui/tooltip";
import { SurfaceFrame } from "@/components/shell";
import {
  createChatRoom,
  deleteChatMessage,
  editChatMessage,
  inviteToRoom,
  pinChatMessage,
  reactToChatMessage,
  replyInThread,
  sendChatMessage,
  type ChatMessageRecord,
  type ChatRoomRecord,
} from "./api";
import { ChatComposer, type ChatComposerSubmission } from "./chat-composer";
import { ChatAttachmentGallery, ChatMessageContent } from "./message-content";
import {
  chatMessageListInfiniteQueryOptions,
  chatPinsQueryOptions,
  chatQueryKeys,
  chatRoomListQueryOptions,
} from "./queries";
import { useChatRealtime } from "./use-chat-realtime";
import {
  formatChatTime,
  partitionRooms,
  presenceMap,
  readCountFor,
  roomAbout,
  roomMembers,
  roomDisplayName,
  seenByForMessage,
  toMessageView,
  type ChatAboutView,
  type ChatMemberView,
  type ChatMessageView,
} from "./view-model";
import "./chat-shell.css";

type InfoTab = "about" | "members" | "files" | "pinned";

const QUICK_REACTIONS = ["👍", "🎉", "🙏", "👀", "✅"] as const;

export function ChatShell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const urlSearch: Partial<{ room: string; thread: string; tab: InfoTab }> = useSearch({
    strict: false,
  });
  const [activeRoomId, setActiveRoomId] = useState<string | undefined>(urlSearch.room);
  const [threadId, setThreadId] = useState<string | null>(urlSearch.thread ?? null);
  const [infoOpen, setInfoOpen] = useState(
    () =>
      typeof window.matchMedia !== "function" || !window.matchMedia("(max-width: 900px)").matches,
  );
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

  const presence = useMemo(() => presenceMap(realtime.presence), [realtime.presence]);

  const { spaces, directs } = useMemo(
    () => partitionRooms(rooms, selfActorId, presence),
    [rooms, selfActorId, presence],
  );

  const activeRoom = useMemo<ChatRoomRecord | undefined>(
    () => rooms.find((r) => r.id === activeRoomId),
    [rooms, activeRoomId],
  );

  const messagesQuery = useInfiniteQuery(chatMessageListInfiniteQueryOptions(activeRoomId));
  const pinsQuery = useQuery(chatPinsQueryOptions(activeRoomId));

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

  // History (infinite pages, each newest-first) + live (WS) + pending, oldest-first.
  const messageRecords = useMemo<readonly ChatMessageRecord[]>(() => {
    const pages = messagesQuery.data?.pages ?? [];
    const byId = new Map<string, ChatMessageRecord>();
    // Pages are oldest-batch-first after reverse of each newest-first page.
    for (const page of [...pages].reverse()) {
      for (const record of [...page].reverse()) {
        byId.set(record.id, record);
      }
    }
    for (const record of realtime.liveMessages) {
      byId.set(record.id, record);
    }
    return [...byId.values()]
      .filter((m) => m.deletedAt === null && !realtime.deletedMessageIds.has(m.id))
      .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  }, [messagesQuery.data, realtime.liveMessages, realtime.deletedMessageIds]);

  const orderedIds = useMemo(() => messageRecords.map((m) => m.id), [messageRecords]);

  const messages = useMemo<readonly ChatMessageView[]>(() => {
    const confirmed = messageRecords.map((record) =>
      toMessageView({
        record,
        selfActorId,
        nameForActor,
        readBy: readCountFor(record.id, orderedIds, realtime.receipts, selfActorId),
        seenByActorIds: seenByForMessage(record.id, orderedIds, realtime.receipts, selfActorId),
      }),
    );
    const pending = realtime.pendingMessages
      .filter((p) => p.roomId === activeRoomId)
      .map((p) =>
        toMessageView({
          record: {
            id: `pending:${p.clientMessageId}`,
            orgId: "",
            roomId: p.roomId,
            actorId: selfActorId,
            body: p.body,
            bodyFormat: p.bodyFormat,
            metadata: {},
            attachmentObjectIds: p.attachmentObjectIds,
            attachments: p.attachments,
            sentAt: p.createdAt,
            editedAt: null,
            deletedAt: null,
            createdAt: p.createdAt,
            updatedAt: p.createdAt,
            clientMessageId: p.clientMessageId,
          },
          selfActorId,
          nameForActor,
          readBy: 0,
          seenByActorIds: [],
          pending: p.status === "pending",
          failed: p.status === "failed",
          clientMessageId: p.clientMessageId,
        }),
      );
    return [...confirmed, ...pending];
  }, [
    messageRecords,
    selfActorId,
    nameForActor,
    orderedIds,
    realtime.receipts,
    realtime.pendingMessages,
    activeRoomId,
  ]);

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
  const members: readonly ChatMemberView[] = useMemo(() => roomMembers(activeRoom), [activeRoom]);
  const roomName = activeRoom ? roomDisplayName(activeRoom, selfActorId) : "Chat";
  const activeRole = activeRoom?.members.find((member) => member.actorId === selfActorId)?.role;
  const canPost =
    activeRoom?.settings?.spaceType !== "announcement" ||
    activeRole === "owner" ||
    activeRole === "moderator";

  const threadMessage = threadId ? (messages.find((m) => m.id === threadId) ?? null) : null;

  // --- Mutations -------------------------------------------------------

  const [actionError, setActionError] = useState<string | null>(null);
  const clearActionError = useCallback(() => {
    setActionError(null);
  }, []);

  const invalidateMessages = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: chatQueryKeys.messagesInfinite(activeRoomId),
    });
  }, [queryClient, activeRoomId]);

  const invalidateRooms = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["chat", "rooms"] });
  }, [queryClient]);

  const sendMutation = useMutation({
    mutationFn: (submission: ChatComposerSubmission) => {
      if (activeRoomId === undefined) {
        return Promise.reject(new Error("No room selected"));
      }
      return sendChatMessage({ roomId: activeRoomId, ...submission });
    },
    onMutate: clearActionError,
    onError: () => {
      setActionError("Couldn’t send the message. Try again.");
    },
    onSuccess: invalidateMessages,
  });

  const reactMutation = useMutation({
    mutationFn: (input: {
      readonly messageId: string;
      readonly emoji: string;
      readonly op: "add" | "remove";
    }) => reactToChatMessage(input),
    onMutate: clearActionError,
    onError: () => {
      setActionError("Couldn’t update the reaction. Try again.");
    },
    onSuccess: invalidateMessages,
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
    (submission: ChatComposerSubmission) => {
      const body = submission.body.trim();
      if (
        (body.length === 0 && submission.attachmentObjectIds.length === 0) ||
        activeRoomId === undefined
      ) {
        return;
      }
      const message = { ...submission, body };
      // Prefer the live socket; fall back to the REST tool when it is closed.
      if (!realtime.sendMessage(message)) {
        sendMutation.mutate(message);
      }
    },
    [activeRoomId, realtime, sendMutation],
  );

  const handleReact = useCallback(
    (messageId: string, emoji: string) => {
      const mine = messages
        .find((message) => message.id === messageId)
        ?.reactions.some((reaction) => reaction.emoji === emoji && reaction.mine);
      reactMutation.mutate({ messageId, emoji, op: mine === true ? "remove" : "add" });
    },
    [messages, reactMutation],
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

  const createRoomMutation = useMutation({
    onMutate: () => undefined,
    mutationFn: (input: {
      readonly kind: "chat_room" | "chat_dm";
      readonly subject?: string;
      readonly memberActorIds: readonly string[];
      readonly readReceiptsEnabled: boolean;
      readonly spaceType?: "conversation" | "announcement" | "project";
      readonly historyPolicy: "full" | "since_join" | "off";
      readonly retentionDays: number | null;
      readonly legalHold: boolean;
      readonly notificationPolicy: "all" | "mentions" | "none";
      readonly externalAccess: "internal" | "guests" | "federated";
    }) =>
      createChatRoom({
        kind: input.kind,
        memberActorIds: [...input.memberActorIds],
        readReceiptsEnabled: input.readReceiptsEnabled,
        ...(input.spaceType === undefined ? {} : { spaceType: input.spaceType }),
        historyPolicy: input.historyPolicy,
        retentionDays: input.retentionDays,
        legalHold: input.legalHold,
        notificationPolicy: input.notificationPolicy,
        externalAccess: input.externalAccess,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
      }),
    onSuccess: (room) => {
      invalidateRooms();
      setActiveRoomId(room.id);
    },
    onError: () => {
      setActionError("Couldn’t create the conversation.");
    },
  });

  const inviteMutation = useMutation({
    onMutate: () => undefined,
    mutationFn: (actorIds: readonly string[]) => {
      if (activeRoomId === undefined) {
        return Promise.reject(new Error("No room"));
      }
      return inviteToRoom({ roomId: activeRoomId, actorIds: [...actorIds] });
    },
    onSuccess: () => {
      invalidateRooms();
    },
    onError: () => {
      setActionError("Couldn’t invite people to this room.");
    },
  });

  const pinMutation = useMutation({
    onMutate: () => undefined,
    onError: () => {
      setActionError("Couldn’t pin that message.");
    },
    mutationFn: (messageId: string) => {
      if (activeRoomId === undefined) {
        return Promise.reject(new Error("No room"));
      }
      return pinChatMessage({ roomId: activeRoomId, messageId });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: chatQueryKeys.pins(activeRoomId),
      });
    },
  });

  const handleThreadReply = useCallback(
    (submission: ChatComposerSubmission) => {
      if (activeRoomId === undefined || threadId === null) {
        return;
      }
      void replyInThread({
        roomId: activeRoomId,
        parentMessageId: threadId,
        body: submission.body,
        bodyFormat: submission.bodyFormat,
        attachmentObjectIds: submission.attachmentObjectIds,
      }).then(() => {
        invalidateMessages();
      });
    },
    [activeRoomId, threadId, invalidateMessages],
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
        <h1 className="sr-only">Chat</h1>
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
          onCreateRoom={(input) => {
            createRoomMutation.mutate(input);
          }}
        />

        <section className="chat-channel" aria-label={`${roomName} channel`}>
          {realtime.connection === "closed" || realtime.connection === "reconnecting" ? (
            <div className="chat-banner" role="status">
              {realtime.connection === "reconnecting"
                ? "Reconnecting…"
                : "Realtime disconnected — messages may be delayed."}
            </div>
          ) : null}
          {actionError !== null ? (
            <div className="chat-banner chat-banner-error" role="alert">
              {actionError}
            </div>
          ) : null}

          <ChatChannelHeader
            infoOpen={infoOpen}
            onToggleInfo={() => setInfoOpen((open) => !open)}
            name={roomName}
            memberCount={about.memberCount}
            onInvite={(actorId) => {
              inviteMutation.mutate([actorId]);
            }}
          />

          <ChatMessageList
            loading={messagesQuery.isLoading && activeRoomId !== undefined}
            error={messagesQuery.isError ? messagesQuery.error : null}
            offline={offline}
            messages={messages}
            threadId={threadId}
            hasOlder={messagesQuery.hasNextPage}
            loadingOlder={messagesQuery.isFetchingNextPage}
            onLoadOlder={() => {
              void messagesQuery.fetchNextPage();
            }}
            onRetry={() => {
              void queryClient.invalidateQueries({
                queryKey: chatQueryKeys.messagesInfinite(activeRoomId),
              });
            }}
            onOpenThread={setThreadId}
            onReact={handleReact}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onPin={(messageId) => {
              pinMutation.mutate(messageId);
            }}
            onRetryPending={(clientMessageId) => {
              realtime.retryPending(clientMessageId);
            }}
          />

          <ChatTypingIndicator names={realtime.typingActorIds.map((id) => nameForActor(id))} />

          <ChatComposer
            roomId={activeRoomId}
            placeholder={canPost ? `Message #${roomName}` : "Only announcers can post here"}
            disabled={activeRoomId === undefined || offline || !canPost}
            onSend={handleSend}
            onTyping={realtime.setTyping}
          />
        </section>

        {threadMessage ? (
          <ChatThreadPanel
            roomId={activeRoomId}
            spaceName={roomName}
            parent={threadMessage}
            onClose={() => {
              setThreadId(null);
            }}
            onReply={handleThreadReply}
            onTyping={realtime.setTyping}
          />
        ) : infoOpen ? (
          <ChatInfoPanel
            onClose={() => setInfoOpen(false)}
            tab={infoTab}
            onTabChange={setInfoTab}
            about={about}
            members={members}
            pins={pinsQuery.data ?? []}
            onInvite={(raw) => {
              const ids = raw
                .split(/[,\s]+/u)
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              if (ids.length > 0) {
                inviteMutation.mutate(ids);
              }
            }}
          />
        ) : null}
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
  readonly onCreateRoom: (input: {
    readonly kind: "chat_room" | "chat_dm";
    readonly subject?: string;
    readonly memberActorIds: readonly string[];
    readonly readReceiptsEnabled: boolean;
    readonly spaceType?: "conversation" | "announcement" | "project";
    readonly historyPolicy: "full" | "since_join" | "off";
    readonly retentionDays: number | null;
    readonly legalHold: boolean;
    readonly notificationPolicy: "all" | "mentions" | "none";
    readonly externalAccess: "internal" | "guests" | "federated";
  }) => void;
}

function ChatSidebar({
  loading,
  offline,
  spaces,
  directs,
  activeRoomId,
  onSelect,
  onCreateRoom,
}: ChatSidebarProps) {
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftKind, setDraftKind] = useState<"chat_room" | "chat_dm">("chat_room");
  const [draftSpaceType, setDraftSpaceType] = useState<"conversation" | "announcement" | "project">(
    "conversation",
  );
  const [draftReadReceipts, setDraftReadReceipts] = useState(true);
  const [draftHistoryPolicy, setDraftHistoryPolicy] = useState<"full" | "since_join" | "off">(
    "full",
  );
  const [draftRetentionDays, setDraftRetentionDays] = useState("");
  const [draftLegalHold, setDraftLegalHold] = useState(false);
  const [draftNotificationPolicy, setDraftNotificationPolicy] = useState<
    "all" | "mentions" | "none"
  >("all");
  const [draftExternalAccess, setDraftExternalAccess] = useState<
    "internal" | "guests" | "federated"
  >("guests");
  const retentionDays = draftRetentionDays === "" ? null : Number(draftRetentionDays);
  const retentionIsValid =
    retentionDays === null ||
    (Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 36_500);

  return (
    <aside className="surf-sidebar chat-sidebar" aria-label="Spaces and direct messages">
      <div className="chat-sidebar-section">
        <span>Spaces</span>
        <button
          type="button"
          className="icon-btn chat-sidebar-add"
          aria-label="New conversation"
          onClick={() => {
            setCreating((v) => !v);
          }}
        >
          <Icons.Plus size={14} />
        </button>
      </div>

      {creating ? (
        <div className="chat-sidebar-create" role="dialog" aria-label="New conversation">
          <select
            aria-label="Conversation type"
            value={draftKind}
            onChange={(e) => {
              setDraftKind(e.target.value as "chat_room" | "chat_dm");
            }}
          >
            <option value="chat_room">Space</option>
            <option value="chat_dm">Direct message</option>
          </select>
          {draftKind === "chat_room" ? (
            <select
              aria-label="Space type"
              value={draftSpaceType}
              onChange={(event) => {
                setDraftSpaceType(
                  event.target.value as "conversation" | "announcement" | "project",
                );
              }}
            >
              <option value="conversation">Conversation</option>
              <option value="announcement">Announcement</option>
              <option value="project">Project</option>
            </select>
          ) : null}
          <select
            aria-label="History policy"
            value={draftHistoryPolicy}
            onChange={(event) => {
              setDraftHistoryPolicy(event.target.value as "full" | "since_join" | "off");
            }}
          >
            <option value="full">Full history</option>
            <option value="since_join">History since joining</option>
            <option value="off">History off</option>
          </select>
          <select
            aria-label="Notification policy"
            value={draftNotificationPolicy}
            onChange={(event) => {
              setDraftNotificationPolicy(event.target.value as "all" | "mentions" | "none");
            }}
          >
            <option value="all">All messages</option>
            <option value="mentions">Mentions only</option>
            <option value="none">No notifications</option>
          </select>
          <select
            aria-label="External access"
            value={draftExternalAccess}
            onChange={(event) => {
              setDraftExternalAccess(event.target.value as "internal" | "guests" | "federated");
            }}
          >
            <option value="internal">Internal only</option>
            <option value="guests">Guests allowed</option>
            <option value="federated">Federated partners</option>
          </select>
          <input
            type="number"
            min={1}
            max={36_500}
            aria-label="Retention days"
            placeholder="Retention days (optional)"
            value={draftRetentionDays}
            onChange={(event) => {
              setDraftRetentionDays(event.target.value);
            }}
          />
          <label>
            <input
              type="checkbox"
              checked={draftLegalHold}
              onChange={(event) => {
                setDraftLegalHold(event.target.checked);
              }}
            />
            Legal hold
          </label>
          <input
            type="text"
            aria-label="Name or member actor id"
            placeholder={draftKind === "chat_dm" ? "Peer actor UUID" : "Space name"}
            value={draftName}
            onChange={(e) => {
              setDraftName(e.target.value);
            }}
          />
          <label>
            <input
              type="checkbox"
              checked={draftReadReceipts}
              onChange={(event) => {
                setDraftReadReceipts(event.target.checked);
              }}
            />
            Share read receipts
          </label>
          <button
            type="button"
            className="btn primary sm"
            disabled={draftName.trim().length === 0 || !retentionIsValid}
            onClick={() => {
              const name = draftName.trim();
              if (name.length === 0) return;
              if (draftKind === "chat_dm") {
                onCreateRoom({
                  kind: "chat_dm",
                  memberActorIds: [name],
                  readReceiptsEnabled: draftReadReceipts,
                  historyPolicy: draftHistoryPolicy,
                  retentionDays,
                  legalHold: draftLegalHold,
                  notificationPolicy: draftNotificationPolicy,
                  externalAccess: draftExternalAccess,
                });
              } else {
                onCreateRoom({
                  kind: "chat_room",
                  subject: name,
                  memberActorIds: [],
                  readReceiptsEnabled: draftReadReceipts,
                  spaceType: draftSpaceType,
                  historyPolicy: draftHistoryPolicy,
                  retentionDays,
                  legalHold: draftLegalHold,
                  notificationPolicy: draftNotificationPolicy,
                  externalAccess: draftExternalAccess,
                });
              }
              setDraftName("");
              setDraftReadReceipts(true);
              setDraftSpaceType("conversation");
              setDraftHistoryPolicy("full");
              setDraftRetentionDays("");
              setDraftLegalHold(false);
              setDraftNotificationPolicy("all");
              setDraftExternalAccess("guests");
              setCreating(false);
            }}
          >
            Create
          </button>
        </div>
      ) : null}

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
              {s.unread > 0 ? <span className="chat-unread-badge">{s.unread}</span> : null}
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
          onClick={() => {
            setDraftKind("chat_dm");
            setCreating(true);
          }}
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
              {d.unread > 0 ? <span className="chat-unread-badge">{d.unread}</span> : null}
            </button>
          );
        })
      )}

      {offline ? (
        <p className="chat-sidebar-state chat-sidebar-offline">Offline — chat rooms unavailable.</p>
      ) : null}
    </aside>
  );
}

/* ----------------------------------------------------------------
   Channel header
   ---------------------------------------------------------------- */

interface ChatChannelHeaderProps {
  readonly infoOpen: boolean;
  readonly onToggleInfo: () => void;
  readonly name: string;
  readonly memberCount: number;
  readonly onInvite?: ((actorId: string) => void) | undefined;
}

function ChatChannelHeader({
  name,
  memberCount,
  onInvite,
  infoOpen,
  onToggleInfo,
}: ChatChannelHeaderProps) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteId, setInviteId] = useState("");
  return (
    <header className="chat-channel-header">
      <Icons.Hash size={16} />
      <span className="chat-channel-name">{name}</span>
      <span className="chat-channel-meta">· {memberCount} members</span>
      <div className="chat-channel-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label="Channel info"
          aria-expanded={infoOpen}
          onClick={onToggleInfo}
        >
          <Icons.Users size={16} />
        </button>
        <Tooltip label="Add people" side="bottom">
          <button
            type="button"
            className="icon-btn"
            aria-label="Add people"
            onClick={() => {
              setInviteOpen((v) => !v);
            }}
          >
            <Icons.Plus size={16} />
          </button>
        </Tooltip>
      </div>
      {inviteOpen ? (
        <div className="chat-channel-invite">
          <input
            type="text"
            aria-label="Actor id to invite"
            placeholder="Actor UUID"
            value={inviteId}
            onChange={(e) => {
              setInviteId(e.target.value);
            }}
          />
          <button
            type="button"
            className="btn primary sm"
            disabled={inviteId.trim().length === 0}
            onClick={() => {
              onInvite?.(inviteId.trim());
              setInviteId("");
              setInviteOpen(false);
            }}
          >
            Invite
          </button>
        </div>
      ) : null}
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
  readonly hasOlder?: boolean;
  readonly loadingOlder?: boolean;
  readonly onLoadOlder?: () => void;
  readonly onRetry: () => void;
  readonly onOpenThread: (id: string) => void;
  readonly onReact: (messageId: string, emoji: string) => void;
  readonly onEdit: (messageId: string, body: string) => void;
  readonly onDelete: (messageId: string) => void;
  readonly onPin?: (messageId: string) => void;
  readonly onRetryPending?: (clientMessageId: string) => void;
}

function ChatMessageList({
  loading,
  error,
  offline,
  messages,
  threadId,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onRetry,
  onOpenThread,
  onReact,
  onEdit,
  onDelete,
  onPin,
  onRetryPending,
}: ChatMessageListProps) {
  if (loading) {
    return (
      <div className="chat-messages" tabIndex={0} role="log" aria-label="Messages">
        <p className="chat-messages-state">Loading messages…</p>
      </div>
    );
  }

  if (error !== null && error !== undefined && !offline) {
    return (
      <div className="chat-messages" tabIndex={0} role="log" aria-label="Messages">
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
      <div className="chat-messages" tabIndex={0} role="log" aria-label="Messages">
        <p className="chat-messages-state">
          {offline ? "Offline — no messages available." : "No messages yet. Say hello!"}
        </p>
      </div>
    );
  }

  return (
    <VirtualizedChatMessages
      messages={messages}
      threadId={threadId}
      hasOlder={hasOlder === true}
      loadingOlder={loadingOlder === true}
      onLoadOlder={onLoadOlder}
      onOpenThread={onOpenThread}
      onReact={onReact}
      onEdit={onEdit}
      onDelete={onDelete}
      onPin={onPin}
      onRetryPending={onRetryPending}
    />
  );
}

interface VirtualizedChatMessagesProps {
  readonly messages: readonly ChatMessageView[];
  readonly threadId: string | null;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly onLoadOlder?: (() => void) | undefined;
  readonly onOpenThread: (messageId: string) => void;
  readonly onReact: ChatMessageListProps["onReact"];
  readonly onEdit: ChatMessageListProps["onEdit"];
  readonly onDelete: ChatMessageListProps["onDelete"];
  readonly onPin?: ((messageId: string) => void) | undefined;
  readonly onRetryPending?: ((clientMessageId: string) => void) | undefined;
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
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onOpenThread,
  onReact,
  onEdit,
  onDelete,
  onPin,
  onRetryPending,
}: VirtualizedChatMessagesProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // count = 1 header ("Today") + N messages
  const rowCount = messages.length + 1;
  const prevLenRef = useRef(messages.length);

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
    // Only auto-scroll when messages are appended (not when older pages prepend).
    if (messages.length >= prevLenRef.current) {
      const grewAtEnd = messages.length > prevLenRef.current;
      if (grewAtEnd || prevLenRef.current === 0) {
        virtualizer.scrollToIndex(rowCount - 1, { align: "end" });
      }
    }
    prevLenRef.current = messages.length;
  }, [virtualizer, rowCount, messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || onLoadOlder === undefined) {
      return;
    }
    const onScroll = () => {
      if (el.scrollTop < 80 && hasOlder && !loadingOlder) {
        const before = el.scrollHeight;
        onLoadOlder();
        // Preserve approximate scroll position after prepend (next paint).
        requestAnimationFrame(() => {
          const after = el.scrollHeight;
          el.scrollTop = Math.max(0, el.scrollTop + (after - before));
        });
      }
    };
    el.addEventListener("scroll", onScroll);
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, [hasOlder, loadingOlder, onLoadOlder]);

  return (
    <div ref={scrollRef} className="chat-messages" tabIndex={0} role="log" aria-label="Messages">
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
                onPin={onPin}
                onRetryPending={onRetryPending}
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
  readonly onPin?: ((messageId: string) => void) | undefined;
  readonly onRetryPending?: ((clientMessageId: string) => void) | undefined;
}

function ChatMessageRow({
  message,
  isActiveThread,
  onOpenThread,
  onReact,
  onEdit,
  onDelete,
  onPin,
  onRetryPending,
}: ChatMessageRowProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);

  return (
    <article
      className="chat-msg"
      data-active-thread={isActiveThread}
      data-mine={message.isMine}
      data-pending={message.pending === true}
      data-failed={message.failed === true}
    >
      <Avatar name={message.authorName} size={32} />
      <div className="chat-msg-main">
        <div className="chat-msg-head">
          <span className="chat-msg-author">{message.authorName}</span>
          <span className="chat-msg-time">{message.time}</span>
          {message.editedAt !== null ? <span className="chat-msg-edited">(edited)</span> : null}
          {message.pending === true ? <span className="chat-msg-pending">Sending…</span> : null}
          {message.failed === true ? (
            <button
              type="button"
              className="chat-msg-failed"
              onClick={() => {
                if (message.clientMessageId !== undefined) {
                  onRetryPending?.(message.clientMessageId);
                }
              }}
            >
              Failed — retry
            </button>
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
          <ChatMessageBody className="chat-msg-line" message={message} />
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

      <div className="chat-msg-actions" role="toolbar" aria-label="Message actions">
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
        <Tooltip label="Pin" side="bottom">
          <button
            type="button"
            className="icon-btn"
            aria-label="Pin message"
            onClick={() => {
              onPin?.(message.id);
            }}
          >
            <Icons.Pin size={14} />
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
   Thread panel — 360px
   ---------------------------------------------------------------- */

interface ChatThreadPanelProps {
  readonly roomId: string | undefined;
  readonly spaceName: string;
  readonly parent: ChatMessageView;
  readonly onClose: () => void;
  readonly onReply: (submission: ChatComposerSubmission) => void;
  readonly onTyping: (isTyping: boolean) => void;
}

function ChatThreadPanel({
  roomId,
  spaceName,
  parent,
  onClose,
  onReply,
  onTyping,
}: ChatThreadPanelProps) {
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
            <ChatMessageBody className="chat-thread-line" message={parent} />
          </div>
        </div>

        <div className="chat-thread-divider">Reply in #{spaceName}</div>
      </div>

      <ChatComposer
        roomId={roomId}
        placeholder="Reply to thread…"
        disabled={roomId === undefined}
        compact
        onSend={onReply}
        onTyping={onTyping}
      />
    </aside>
  );
}

function ChatMessageBody(input: {
  readonly className: string;
  readonly message: Pick<
    ChatMessageView,
    "body" | "bodyFormat" | "renderedBodyHtml" | "attachments" | "attachmentObjectIds"
  >;
}) {
  return (
    <div className={input.className}>
      <ChatMessageContent
        body={input.message.body}
        bodyFormat={input.message.bodyFormat}
        renderedBodyHtml={input.message.renderedBodyHtml}
      />
      <ChatAttachmentGallery
        attachments={input.message.attachments}
        attachmentObjectIds={input.message.attachmentObjectIds}
      />
    </div>
  );
}

/* ----------------------------------------------------------------
   Info panel — 260px tabbed
   ---------------------------------------------------------------- */

interface ChatInfoPanelProps {
  readonly onClose: () => void;
  readonly tab: InfoTab;
  readonly onTabChange: (tab: InfoTab) => void;
  readonly about: ChatAboutView;
  readonly members: readonly ChatMemberView[];
  readonly pins: readonly { readonly messageId: string; readonly createdAt: string }[];
  readonly onInvite: (raw: string) => void;
}

function ChatInfoPanel({
  tab,
  onTabChange,
  about,
  members,
  pins,
  onInvite,
  onClose,
}: ChatInfoPanelProps) {
  const [inviteDraft, setInviteDraft] = useState("");
  const tabs: ReadonlyArray<{ readonly id: InfoTab; readonly label: string }> = [
    { id: "about", label: "About" },
    { id: "members", label: `Members · ${String(members.length)}` },
    { id: "files", label: "Files" },
    { id: "pinned", label: `Pinned · ${String(pins.length)}` },
  ];

  return (
    <aside className="chat-info-panel" aria-label="Channel info">
      <button type="button" className="icon-btn" aria-label="Close channel info" onClick={onClose}>
        <Icons.X />
      </button>
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
          </>
        ) : null}

        {tab === "members" ? (
          <>
            <div className="chat-info-invite">
              <input
                type="text"
                aria-label="Invite actor ids"
                placeholder="Actor UUIDs"
                value={inviteDraft}
                onChange={(e) => {
                  setInviteDraft(e.target.value);
                }}
              />
              <button
                type="button"
                className="btn sm"
                disabled={inviteDraft.trim().length === 0}
                onClick={() => {
                  onInvite(inviteDraft);
                  setInviteDraft("");
                }}
              >
                Add people
              </button>
            </div>
            {members.length === 0 ? (
              <p className="chat-info-empty">No members.</p>
            ) : (
              members.map((member) => (
                <div key={member.actorId} className="chat-info-member">
                  <Avatar name={member.name} size={22} />
                  <div className="chat-info-member-text">
                    <div className="chat-info-member-name truncate">{member.name}</div>
                    <div className="chat-info-member-role truncate">{member.role}</div>
                  </div>
                </div>
              ))
            )}
          </>
        ) : null}

        {tab === "files" ? <p className="chat-info-empty">No shared files yet.</p> : null}

        {tab === "pinned" ? (
          pins.length === 0 ? (
            <p className="chat-info-empty">No pinned messages yet.</p>
          ) : (
            pins.map((pin) => (
              <div key={pin.messageId} className="chat-info-pin">
                <Icons.Pin size={12} />
                <span className="truncate">{pin.messageId.slice(0, 8)}…</span>
                <span className="chat-info-pin-time">{formatChatTime(pin.createdAt)}</span>
              </div>
            ))
          )
        ) : null}
      </div>
    </aside>
  );
}
