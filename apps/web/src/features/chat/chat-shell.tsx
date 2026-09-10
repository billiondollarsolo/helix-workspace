import { SurfaceFrame } from "@/components/shell";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { MessageCircle as ChatIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ChatMessageList } from "./chat-message-list";
import { ChatTypingIndicator } from "./chat-message-row";
import { ChatInfoPanel, ChatThreadPanel, type InfoTab } from "./chat-panels";
import "./chat-shell.css";
import { ChatChannelHeader, ChatSidebar } from "./chat-sidebar";
import {
  chatMessageListInfiniteQueryOptions,
  chatPinsQueryOptions,
  chatQueryKeys,
  chatRoomListQueryOptions,
} from "./queries";
import { useChatRealtime } from "./use-chat-realtime";
import {
  partitionRooms,
  presenceMap,
  readCountFor,
  roomAbout,
  roomDisplayName,
  roomMembers,
  seenByForMessage,
  toMessageView,
  type ChatAboutView,
  type ChatMemberView,
  type ChatMessageView,
} from "./view-model";

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
      icon={<ChatIcon size={16} />}
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
