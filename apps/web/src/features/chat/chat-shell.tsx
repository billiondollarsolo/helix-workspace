import {
  AtSign,
  Bot,
  CheckCheck,
  Circle,
  CircleAlert,
  Edit3,
  Filter,
  Hash,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Phone,
  Plus,
  Search,
  Send,
  SmilePlus,
  Users,
  Video,
} from "lucide-react";
import { SuggestionSlot } from "@helix/sdk-web";
import { useForm } from "@tanstack/react-form";
import { useDebouncedCallback } from "@tanstack/react-pacer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  createChatRealtimeClient,
  editChatMessage,
  reactToChatMessage,
  sendChatMessage,
  type ChatPresenceEntry,
  type ChatRealtimeClient,
  type ChatRealtimeEvent,
  type ChatMessageRecord,
  type ChatRoomRecord,
} from "./api";
import {
  chatMessageListQueryOptions,
  chatQueryKeys,
  chatRoomListQueryOptions,
  isBackendChatRoomId,
} from "./queries";

type ChatMode = "rooms" | "dms";
type ChatStatus = "ready" | "loading" | "error";
type PresenceState = "online" | "away" | "busy" | "offline";

interface ChatMember {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly presence: PresenceState;
}

interface ChatReaction {
  readonly emoji: string;
  readonly count: number;
  readonly reactedByMe: boolean;
}

interface ChatMessage {
  readonly id: string;
  readonly roomId: string;
  readonly authorId: string;
  readonly body: string;
  readonly sentAt: string;
  readonly editedAt?: string;
  readonly reactions: readonly ChatReaction[];
  readonly readBy: readonly string[];
  readonly attachments?: readonly string[];
  readonly syncState?: "local";
}

interface ChatRoom {
  readonly id: string;
  readonly type: ChatMode;
  readonly name: string;
  readonly description: string;
  readonly memberIds: readonly string[];
  readonly lastActivity: string;
  readonly unreadCount: number;
  readonly mentionCount: number;
  readonly isPrivate?: boolean;
  readonly typingMemberIds: readonly string[];
  readonly syncState?: "local";
}

const meId = "maya";
const currentMember: ChatMember = {
  id: "maya",
  name: "Maya Chen",
  role: "Product",
  presence: "online",
};

const defaultMembers: readonly ChatMember[] = [currentMember];

const mentionPattern = /(@[A-Za-z]+)/g;
const estimatedMessageHeight = 132;
const virtualMessageOverscan = 6;
const chatMessageBodySchema = z.string().trim().min(1, "Message is required.");

export function ChatShell({
  initialMessageId,
  initialRoomId,
}: {
  readonly initialMessageId?: string;
  readonly initialRoomId?: string;
} = {}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ChatMode>("rooms");
  const [query, setQuery] = useState("");
  const [mentionsOnly, setMentionsOnly] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState(initialRoomId ?? "");
  const [members, setMembers] = useState<readonly ChatMember[]>(defaultMembers);
  const [rooms, setRooms] = useState<readonly ChatRoom[]>([]);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const membersRef = useRef(members);
  const roomsRef = useRef(rooms);
  const realtimeClientRef = useRef<ChatRealtimeClient | null>(null);
  const locallyTypingRoomIdsRef = useRef(new Set<string>());
  const chatRoomsQuery = useQuery(chatRoomListQueryOptions());
  const selectedBackendRoomId = isBackendChatRoomId(selectedRoomId) ? selectedRoomId : undefined;
  const chatMessagesQuery = useQuery(chatMessageListQueryOptions(selectedBackendRoomId));

  useEffect(() => {
    if (initialRoomId !== undefined && initialRoomId.length > 0) {
      setSelectedRoomId(initialRoomId);
    }
  }, [initialRoomId]);

  useEffect(() => {
    const backendRooms = chatRoomsQuery.data;
    if (backendRooms === undefined) {
      return;
    }

    const backend = buildBackendRoomState(backendRooms);
    const nextRooms = mergeBackendRoomsWithLocal(roomsRef.current, backend.rooms);
    const nextRoomIds = new Set(nextRooms.map((room) => room.id));
    setMembers(backend.members);
    setRooms(nextRooms);
    setMessages((current) =>
      current.filter((message) => message.syncState === "local" || nextRoomIds.has(message.roomId)),
    );
    setSelectedRoomId((current) =>
      nextRooms.some((room) => room.id === current) ? current : (nextRooms[0]?.id ?? ""),
    );
    setMode((current) =>
      nextRooms.some((room) => room.type === current) ? current : (nextRooms[0]?.type ?? current),
    );
  }, [chatRoomsQuery.data]);

  useEffect(() => {
    const backendMessages = chatMessagesQuery.data;
    if (selectedBackendRoomId === undefined || backendMessages === undefined) {
      return;
    }

    setMessages((current) => [
      ...current.filter((message) => message.roomId !== selectedBackendRoomId),
      ...current.filter(
        (message) => message.roomId === selectedBackendRoomId && message.syncState === "local",
      ),
      ...backendMessages
        .map((message) => chatMessageFromRecord(message, membersRef.current))
        .reverse(),
    ]);
  }, [chatMessagesQuery.data, selectedBackendRoomId]);

  useEffect(() => {
    if (!chatRoomsQuery.isError) {
      return;
    }

    const localRooms = roomsRef.current.filter(isLocalRoom);
    setRooms(localRooms);
    setMessages((current) => current.filter(isLocalMessage));
    setSelectedRoomId((current) =>
      localRooms.some((room) => room.id === current) ? current : (localRooms[0]?.id ?? ""),
    );
    setMode((current) =>
      localRooms.some((room) => room.type === current) ? current : (localRooms[0]?.type ?? current),
    );
  }, [chatRoomsQuery.isError]);

  useEffect(() => {
    if (initialRoomId === undefined || initialRoomId.length === 0) {
      return;
    }

    const initialRoom = rooms.find((room) => room.id === initialRoomId);
    if (initialRoom === undefined) {
      return;
    }

    setSelectedRoomId(initialRoom.id);
    setMode(initialRoom.type);
  }, [initialRoomId, rooms]);

  const filteredRooms = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rooms.filter((room) => {
      const text = `${room.name} ${room.description}`.toLowerCase();
      return (
        room.type === mode &&
        (!normalizedQuery || text.includes(normalizedQuery)) &&
        (!mentionsOnly || room.mentionCount > 0) &&
        (!unreadOnly || room.unreadCount > 0)
      );
    });
  }, [mentionsOnly, mode, query, rooms, unreadOnly]);

  const selectedRoom = filteredRooms.find((room) => room.id === selectedRoomId) ?? filteredRooms[0];
  const roomMessages = selectedRoom
    ? messages.filter((message) => message.roomId === selectedRoom.id)
    : [];
  const roomMembers = selectedRoom
    ? selectedRoom.memberIds.map((memberId) => memberById(members, memberId)).filter(isChatMember)
    : [];
  const typingMembers = selectedRoom
    ? selectedRoom.typingMemberIds
        .map((memberId) => memberById(members, memberId))
        .filter(isChatMember)
    : [];
  const onlineMembers = roomMembers.filter((member) => member.presence === "online");
  const currentDraft = selectedRoom ? (drafts[selectedRoom.id] ?? "") : "";
  const roomListStatus: ChatStatus =
    chatRoomsQuery.isPending && rooms.length === 0
      ? "loading"
      : chatRoomsQuery.isError
        ? "error"
        : "ready";
  const messageStatus: ChatStatus =
    chatRoomsQuery.isError || (selectedBackendRoomId !== undefined && chatMessagesQuery.isError)
      ? "error"
      : selectedBackendRoomId !== undefined &&
          chatMessagesQuery.isPending &&
          roomMessages.length === 0
        ? "loading"
        : "ready";
  const selectedRoomContext = selectedRoom
    ? {
        resource: {
          id: selectedRoom.id,
          type: selectedRoom.type === "dms" ? "chat.dm" : "chat.room",
          label: selectedRoom.name,
        },
        metadata: {
          unreadCount: selectedRoom.unreadCount,
          mentionCount: selectedRoom.mentionCount,
          memberCount: selectedRoom.memberIds.length,
        },
      }
    : undefined;

  useEffect(() => {
    membersRef.current = members;
  }, [members]);

  useEffect(() => {
    roomsRef.current = rooms;
  }, [rooms]);

  const emitDebouncedTypingStop = useDebouncedCallback(
    (roomId: string) => {
      if (!locallyTypingRoomIdsRef.current.has(roomId)) {
        return;
      }

      locallyTypingRoomIdsRef.current.delete(roomId);
      realtimeClientRef.current?.setTyping(roomId, false);
    },
    { wait: 1500 },
  );

  useEffect(() => {
    const roomId = selectedRoom?.id;
    if (roomId === undefined || !isBackendChatRoomId(roomId) || typeof WebSocket === "undefined") {
      realtimeClientRef.current?.close();
      realtimeClientRef.current = null;
      return;
    }

    const applyRoster = (entries: readonly ChatPresenceEntry[]) => {
      setMembers((current) => mergePresenceEntries(current, entries));
      setRooms((current) =>
        mergeRoomMemberIds(
          current,
          roomId,
          entries.map((entry) => entry.actorId),
        ),
      );
    };

    const handleRealtimeEvent = (event: ChatRealtimeEvent) => {
      if ("roomId" in event && event.roomId !== roomId) {
        return;
      }

      if (event.type === "subscribed") {
        applyRoster(event.presence);
        for (const receipt of event.receipts ?? []) {
          if (receipt.lastReadMessageId !== null) {
            setMembers((current) => ensureMember(current, receipt.actorId));
            setMessages((current) =>
              markReadUpTo(current, roomId, receipt.lastReadMessageId ?? "", receipt.actorId),
            );
          }
        }
        return;
      }

      if (event.type === "presence") {
        applyRoster(event.presence);
        return;
      }

      if (event.type === "presence.joined") {
        applyRoster(event.roster ?? [event.entry]);
        return;
      }

      if (event.type === "presence.left") {
        setMembers((current) => setMemberPresence(current, event.actorId, "offline"));
        setRooms((current) => setRoomTyping(current, event.roomId, event.actorId, false));
        return;
      }

      if (event.type === "typing" && event.actorId !== meId) {
        setRooms((current) => setRoomTyping(current, event.roomId, event.actorId, event.isTyping));
        return;
      }

      if (event.type === "message.created") {
        const authorId = event.message.actorId ?? meId;
        setMembers((current) => ensureMember(current, authorId));
        setMessages((current) =>
          upsertMessage(current, chatMessageFromRecord(event.message, membersRef.current)),
        );
        setRooms((current) =>
          setRoomTyping(
            updateRoomActivity(current, event.roomId, formatChatTimestamp(event.message.sentAt)),
            event.roomId,
            authorId,
            false,
          ),
        );
        return;
      }

      if (event.type === "read" && event.receipt.lastReadMessageId !== null) {
        setMembers((current) => ensureMember(current, event.actorId));
        setMessages((current) =>
          markReadUpTo(current, roomId, event.receipt.lastReadMessageId ?? "", event.actorId),
        );
      }
    };

    const client = createChatRealtimeClient({
      onOpen: () => {
        client.subscribe(roomId);
        client.requestPresence(roomId);
      },
      onEvent: handleRealtimeEvent,
      onClose: () => {
        if (realtimeClientRef.current === client) {
          realtimeClientRef.current = null;
        }
      },
    });
    realtimeClientRef.current = client;

    return () => {
      client.close();
      if (realtimeClientRef.current === client) {
        realtimeClientRef.current = null;
      }
    };
  }, [selectedRoom?.id]);

  const selectRoom = (roomId: string) => {
    setSelectedRoomId(roomId);
    setEditingMessageId(null);
  };

  const updateDraft = (roomId: string, body: string) => {
    setDrafts((current) => ({ ...current, [roomId]: body }));
    emitTyping(roomId, body.trim().length > 0);
  };

  const sendMessage = (body: string) => {
    const nextBody = body.trim();
    if (!selectedRoom || nextBody.length === 0) {
      return;
    }

    const message: ChatMessage = {
      id: `msg-local-${Date.now()}`,
      roomId: selectedRoom.id,
      authorId: meId,
      body: nextBody,
      sentAt: "Now",
      reactions: [],
      readBy: [meId],
      syncState: "local",
    };

    setMessages((current) => [...current, message]);
    updateDraft(selectedRoom.id, "");
    const input = {
      roomId: selectedRoom.id,
      body: message.body,
      bodyFormat: "plain",
      attachmentObjectIds: [],
      metadata: {},
    } as const;
    const realtimeClient = realtimeClientRef.current;
    if (realtimeClient?.isOpen()) {
      try {
        realtimeClient.sendMessage(input);
        return;
      } catch {
        // Fall back to the tool API below when the socket closes between state checks.
      }
    }
    void sendChatMessage(input)
      .then((stored) => {
        setMessages((current) =>
          current.map((candidate) =>
            candidate.id === message.id ? chatMessageFromRecord(stored, members) : candidate,
          ),
        );
      })
      .catch(() => {
        setMessages((current) =>
          current.map((candidate) =>
            candidate.id === message.id ? { ...candidate, syncState: "local" } : candidate,
          ),
        );
      });
  };

  const toggleReaction = (messageId: string, emoji: string) => {
    const target = messages.find((message) => message.id === messageId);
    const existing = target?.reactions.find((reaction) => reaction.emoji === emoji);
    const op = existing?.reactedByMe ? "remove" : "add";

    setMessages((current) =>
      current.map((message) => {
        if (message.id !== messageId) {
          return message;
        }

        const existing = message.reactions.find((reaction) => reaction.emoji === emoji);
        const reactions = existing
          ? message.reactions.map((reaction) =>
              reaction.emoji === emoji
                ? {
                    ...reaction,
                    count: Math.max(0, reaction.count + (reaction.reactedByMe ? -1 : 1)),
                    reactedByMe: !reaction.reactedByMe,
                  }
                : reaction,
            )
          : [...message.reactions, { emoji, count: 1, reactedByMe: true }];

        return { ...message, reactions: reactions.filter((reaction) => reaction.count > 0) };
      }),
    );
    void reactToChatMessage({ messageId, emoji, op }).catch(() => undefined);
  };

  const beginEdit = (message: ChatMessage) => {
    setEditingMessageId(message.id);
  };

  const saveEdit = (messageId: string, body: string) => {
    const nextBody = body.trim();
    if (nextBody.length === 0) {
      return;
    }

    setMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? { ...message, body: nextBody, editedAt: "Edited just now" }
          : message,
      ),
    );
    setEditingMessageId(null);
    void editChatMessage({ messageId, body: nextBody })
      .then((stored) => {
        setMessages((current) =>
          current.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  body: stored.body,
                  editedAt:
                    stored.editedAt === null
                      ? message.editedAt
                      : formatChatTimestamp(stored.editedAt),
                }
              : message,
          ),
        );
      })
      .catch(() => undefined);
  };

  const resetFilters = () => {
    setQuery("");
    setMentionsOnly(false);
    setUnreadOnly(false);
  };

  const markSelectedRoomRead = () => {
    if (!selectedRoom) {
      return;
    }

    const latestMessageId = roomMessages.at(-1)?.id;
    setRooms((current) =>
      current.map((room) => (room.id === selectedRoom.id ? { ...room, unreadCount: 0 } : room)),
    );
    if (latestMessageId !== undefined) {
      setMessages((current) => markReadUpTo(current, selectedRoom.id, latestMessageId, meId));
    }
    if (latestMessageId !== undefined && realtimeClientRef.current?.isOpen()) {
      realtimeClientRef.current.markRead(selectedRoom.id, latestMessageId);
    }
  };

  const emitTyping = (roomId: string, isTyping: boolean) => {
    if (!isBackendChatRoomId(roomId) || !realtimeClientRef.current?.isOpen()) {
      return;
    }

    realtimeClientRef.current.setTyping(roomId, isTyping);
    if (isTyping) {
      locallyTypingRoomIdsRef.current.add(roomId);
      emitDebouncedTypingStop(roomId);
      return;
    }

    locallyTypingRoomIdsRef.current.delete(roomId);
  };

  return (
    <section className="chat-page">
      <aside className="chat-sidebar" aria-label="Chat rooms">
        <header className="chat-sidebar-header">
          <div>
            <h1 id="chat-title">Chat</h1>
            <p>{rooms.reduce((total, room) => total + room.unreadCount, 0)} unread</p>
          </div>
          <button className="icon-button" aria-label="Create room" type="button">
            <Plus aria-hidden="true" size={17} />
          </button>
        </header>

        <div className="chat-mode-switcher" role="tablist" aria-label="Conversation type">
          <button
            aria-selected={mode === "rooms"}
            className={mode === "rooms" ? "active" : undefined}
            onClick={() => {
              setMode("rooms");
              setSelectedRoomId(rooms.find((room) => room.type === "rooms")?.id ?? "");
            }}
            role="tab"
            type="button"
          >
            <Hash aria-hidden="true" size={16} />
            Rooms
          </button>
          <button
            aria-selected={mode === "dms"}
            className={mode === "dms" ? "active" : undefined}
            onClick={() => {
              setMode("dms");
              setSelectedRoomId(rooms.find((room) => room.type === "dms")?.id ?? "");
            }}
            role="tab"
            type="button"
          >
            <Users aria-hidden="true" size={16} />
            DMs
          </button>
        </div>

        <div className="chat-filters" aria-label="Chat filters">
          <label className="chat-search">
            <Search aria-hidden="true" size={16} />
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chat"
              value={query}
            />
          </label>
          <button
            className={mentionsOnly ? "chat-filter active" : "chat-filter"}
            onClick={() => setMentionsOnly((current) => !current)}
            type="button"
          >
            <AtSign aria-hidden="true" size={15} />
            Mentions
          </button>
          <button
            className={unreadOnly ? "chat-filter active" : "chat-filter"}
            onClick={() => setUnreadOnly((current) => !current)}
            type="button"
          >
            Unread
          </button>
        </div>

        <RoomList
          members={members}
          onReset={resetFilters}
          onRetry={() => void queryClient.invalidateQueries({ queryKey: chatQueryKeys.rooms() })}
          onSelect={selectRoom}
          rooms={filteredRooms}
          selectedRoomId={selectedRoom?.id}
          status={roomListStatus}
        />
      </aside>

      <div className="chat-workspace" role="main" aria-labelledby="chat-title">
        <header className="chat-room-header">
          {selectedRoom ? (
            <>
              <div className="chat-room-title">
                <RoomIcon room={selectedRoom} />
                <div>
                  <h2>{selectedRoom.name}</h2>
                  <p>{selectedRoom.description}</p>
                </div>
              </div>
              <div className="chat-room-meta" aria-label="Room status">
                <span>
                  <Circle className="chat-presence-dot online" aria-hidden="true" size={8} />
                  {onlineMembers.length} online
                </span>
                <span>
                  <Users aria-hidden="true" size={14} />
                  {roomMembers.length}
                </span>
              </div>
            </>
          ) : (
            <div className="chat-room-title">
              <MessageSquare aria-hidden="true" size={22} />
              <div>
                <h2>No conversation selected</h2>
                <p>Pick a room or direct message.</p>
              </div>
            </div>
          )}
          <div className="chat-room-actions">
            <button className="icon-button" aria-label="Start audio call" type="button">
              <Phone aria-hidden="true" size={17} />
            </button>
            <button className="icon-button" aria-label="Start video call" type="button">
              <Video aria-hidden="true" size={17} />
            </button>
            <button className="icon-button" aria-label="More chat actions" type="button">
              <MoreHorizontal aria-hidden="true" size={17} />
            </button>
          </div>
        </header>

        <div className="chat-toolbar" aria-label="Chat status controls">
          <button
            className="helix-button helix-button-secondary"
            onClick={markSelectedRoomRead}
            type="button"
          >
            Mark read
          </button>
          <div className="chat-read-affordance">
            <CheckCheck aria-hidden="true" size={16} />
            Read receipts enabled
          </div>
        </div>

        <SuggestionSlot
          className="chat-suggestion-slot"
          context={selectedRoomContext}
          emptyFallback={<div className="chat-suggestion-empty">No room summary available</div>}
          loadingFallback={<div className="chat-suggestion-empty">Loading room summary</div>}
          slotId="chat.summarize-room"
        />

        <MessageStream
          editingMessageId={editingMessageId}
          focusedMessageId={initialMessageId}
          members={members}
          messages={roomMessages}
          onBeginEdit={beginEdit}
          onCancelEdit={() => setEditingMessageId(null)}
          onSaveEdit={saveEdit}
          onToggleReaction={toggleReaction}
          roomMembers={roomMembers}
          selectedRoom={selectedRoom}
          status={messageStatus}
          typingMembers={typingMembers}
        />

        <SuggestionSlot
          className="chat-suggestion-slot compact"
          context={selectedRoomContext}
          emptyFallback={null}
          loadingFallback={<div className="chat-suggestion-empty">Loading reply suggestions</div>}
          slotId="chat.suggest-reply"
        />

        {selectedRoom ? (
          <Composer
            body={currentDraft}
            onChange={(body) => updateDraft(selectedRoom.id, body)}
            onSubmit={sendMessage}
            roomName={selectedRoom.name}
          />
        ) : null}
      </div>
    </section>
  );
}

function RoomList({
  members,
  onReset,
  onRetry,
  onSelect,
  rooms: visibleRooms,
  selectedRoomId,
  status,
}: {
  readonly members: readonly ChatMember[];
  readonly onReset: () => void;
  readonly onRetry: () => void;
  readonly onSelect: (roomId: string) => void;
  readonly rooms: readonly ChatRoom[];
  readonly selectedRoomId: string | undefined;
  readonly status: ChatStatus;
}) {
  if (status === "loading") {
    return (
      <div
        className="chat-room-list"
        role="region"
        aria-busy="true"
        aria-label="Room list"
        tabIndex={0}
      >
        {Array.from({ length: 6 }, (_, index) => (
          <div className="chat-room-skeleton" key={index}>
            <span />
            <span />
            <span />
          </div>
        ))}
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="chat-state-panel" role="alert">
        <CircleAlert aria-hidden="true" size={21} />
        <h2>Chat backend unavailable</h2>
        <p>Room list could not reach the backend. Local/offline rooms will appear here.</p>
        <button className="helix-button" onClick={onRetry} type="button">
          Retry
        </button>
      </div>
    );
  }

  if (visibleRooms.length === 0) {
    return (
      <div className="chat-state-panel">
        <Filter aria-hidden="true" size={21} />
        <h2>No conversations</h2>
        <p>No rooms or DMs match the current filters.</p>
        <button className="helix-button helix-button-secondary" onClick={onReset} type="button">
          Clear filters
        </button>
      </div>
    );
  }

  return (
    <div className="chat-room-list" role="region" aria-label="Room list" tabIndex={0}>
      {visibleRooms.map((room) => {
        const roomMembers = room.memberIds
          .map((memberId) => memberById(members, memberId))
          .filter(isChatMember);
        const dmMember =
          room.type === "dms" ? roomMembers.find((member) => member.id !== meId) : undefined;
        return (
          <button
            className={room.id === selectedRoomId ? "chat-room-row selected" : "chat-room-row"}
            key={room.id}
            onClick={() => onSelect(room.id)}
            type="button"
          >
            <span className="chat-room-row-icon">
              {dmMember ? <PresenceAvatar member={dmMember} /> : <RoomIcon room={room} />}
            </span>
            <span className="chat-room-row-main">
              <span className="chat-room-row-topline">
                <strong>{room.name}</strong>
                <time>{room.lastActivity}</time>
              </span>
              <span className="chat-room-row-description">{room.description}</span>
              <span className="chat-room-row-footer">
                {room.typingMemberIds.length > 0 ? (
                  <span>{room.typingMemberIds.length} typing</span>
                ) : room.syncState === "local" ? (
                  <span>Offline/local</span>
                ) : (
                  <span>{roomMembers.length} members</span>
                )}
                {room.mentionCount > 0 ? <strong>@{room.mentionCount}</strong> : null}
                {room.unreadCount > 0 ? (
                  <b>{room.unreadCount}</b>
                ) : (
                  <CheckCheck aria-label="Read" size={14} />
                )}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MessageStream({
  editingMessageId,
  focusedMessageId,
  members,
  messages: visibleMessages,
  onBeginEdit,
  onCancelEdit,
  onSaveEdit,
  onToggleReaction,
  roomMembers,
  selectedRoom,
  status,
  typingMembers,
}: {
  readonly editingMessageId: string | null;
  readonly focusedMessageId: string | undefined;
  readonly members: readonly ChatMember[];
  readonly messages: readonly ChatMessage[];
  readonly onBeginEdit: (message: ChatMessage) => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: (messageId: string, body: string) => void;
  readonly onToggleReaction: (messageId: string, emoji: string) => void;
  readonly roomMembers: readonly ChatMember[];
  readonly selectedRoom: ChatRoom | undefined;
  readonly status: ChatStatus;
  readonly typingMembers: readonly ChatMember[];
}) {
  const streamRef = useRef<HTMLDivElement | null>(null);
  const focusedMessageRef = useRef<HTMLElement | null>(null);
  const focusedMessageIndex = focusedMessageId
    ? visibleMessages.findIndex((message) => message.id === focusedMessageId)
    : -1;
  const messageVirtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => streamRef.current,
    estimateSize: () => estimatedMessageHeight,
    getItemKey: (index) => visibleMessages[index]?.id ?? index,
    overscan: virtualMessageOverscan,
  });
  const measuredVirtualRows = messageVirtualizer.getVirtualItems();
  const virtualRows =
    measuredVirtualRows.length > 0 || visibleMessages.length === 0
      ? measuredVirtualRows
      : visibleMessages.slice(0, 20).map((_, index) => ({
          end: (index + 1) * estimatedMessageHeight,
          index,
          key: visibleMessages[index]?.id ?? index,
          lane: 0,
          size: estimatedMessageHeight,
          start: index * estimatedMessageHeight,
        }));
  const virtualTotalSize = Math.max(
    messageVirtualizer.getTotalSize(),
    visibleMessages.length * estimatedMessageHeight,
  );

  useEffect(() => {
    if (focusedMessageIndex >= 0) {
      messageVirtualizer.scrollToIndex(focusedMessageIndex, { align: "center" });
    }
  }, [focusedMessageIndex, messageVirtualizer]);

  useEffect(() => {
    if (focusedMessageId === undefined || focusedMessageRef.current === null) {
      return;
    }
    if (focusedMessageIndex < 0) {
      focusedMessageRef.current = null;
      return;
    }

    focusedMessageRef.current.focus({ preventScroll: true });
    focusedMessageRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusedMessageId, focusedMessageIndex, selectedRoom?.id, virtualRows]);

  if (status === "loading") {
    return (
      <div className="chat-message-stream" aria-busy="true" aria-label="Message stream">
        {Array.from({ length: 5 }, (_, index) => (
          <div className="chat-message-skeleton" key={index}>
            <span />
            <span />
            <span />
          </div>
        ))}
      </div>
    );
  }

  if (status === "error") {
    return (
      <section className="chat-state-panel large" role="alert">
        <CircleAlert aria-hidden="true" size={24} />
        <h2>{selectedRoom ? "Messages unavailable" : "Chat backend unavailable"}</h2>
        <p>
          {selectedRoom
            ? "Message history could not be loaded for this conversation."
            : "Chat rooms could not be loaded. No backend conversations are shown."}
        </p>
      </section>
    );
  }

  if (!selectedRoom) {
    return (
      <section className="chat-state-panel large">
        <MessageSquare aria-hidden="true" size={24} />
        <h2>No chat selected</h2>
        <p>Choose a room or DM to view messages.</p>
      </section>
    );
  }

  if (visibleMessages.length === 0) {
    return (
      <section className="chat-state-panel large">
        <MessageSquare aria-hidden="true" size={24} />
        <h2>No messages yet</h2>
        <p>Start the conversation with a message or mention a teammate.</p>
      </section>
    );
  }

  return (
    <div
      className="chat-message-stream"
      aria-label="Message stream"
      data-virtualized="true"
      ref={streamRef}
      style={{ display: "block" }}
    >
      <div
        data-testid="chat-message-virtual-spacer"
        style={{
          height: `${String(virtualTotalSize)}px`,
          position: "relative",
          width: "100%",
        }}
      >
        {virtualRows.map((virtualRow) => {
          const message = visibleMessages[virtualRow.index];
          if (message === undefined) {
            return null;
          }
          const author = memberById(members, message.authorId);
          const isMine = message.authorId === meId;
          const isFocused = message.id === focusedMessageId;
          return (
            <div
              data-index={virtualRow.index}
              key={virtualRow.key}
              ref={(node) => {
                if (node !== null) {
                  messageVirtualizer.measureElement(node);
                }
              }}
              style={{
                left: 0,
                position: "absolute",
                right: 0,
                top: 0,
                transform: `translateY(${String(virtualRow.start)}px)`,
                width: "100%",
              }}
            >
              <article
                aria-current={isFocused ? "true" : undefined}
                className={`${isMine ? "chat-message mine" : "chat-message"}${isFocused ? " focused" : ""}`}
                data-message-id={message.id}
                ref={(element) => {
                  if (isFocused) {
                    focusedMessageRef.current = element;
                  }
                }}
                tabIndex={isFocused ? -1 : undefined}
              >
                <PresenceAvatar member={author} />
                <div className="chat-message-body">
                  <header>
                    <strong>{author?.name ?? "Unknown"}</strong>
                    <span>{author?.role}</span>
                    <time>{message.sentAt}</time>
                    {message.syncState === "local" ? <em>Offline/local</em> : null}
                    {message.editedAt ? <em>{message.editedAt}</em> : null}
                  </header>

                  {editingMessageId === message.id ? (
                    <EditMessageForm
                      initialBody={message.body}
                      messageId={message.id}
                      onCancel={onCancelEdit}
                      onSubmit={onSaveEdit}
                    />
                  ) : (
                    <>
                      <p>{renderMessageText(message.body)}</p>
                      {message.attachments?.length ? (
                        <div className="chat-attachments">
                          {message.attachments.map((attachment) => (
                            <span key={attachment}>
                              <Paperclip aria-hidden="true" size={13} />
                              {attachment}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </>
                  )}

                  <footer>
                    <div className="chat-reactions" aria-label="Message reactions">
                      {message.reactions.map((reaction) => (
                        <button
                          className={reaction.reactedByMe ? "active" : undefined}
                          key={reaction.emoji}
                          onClick={() => onToggleReaction(message.id, reaction.emoji)}
                          type="button"
                        >
                          <span aria-hidden="true">{reaction.emoji}</span>
                          {reaction.count}
                        </button>
                      ))}
                      <button
                        aria-label="React with check"
                        onClick={() => onToggleReaction(message.id, "✅")}
                        type="button"
                      >
                        <SmilePlus aria-hidden="true" size={14} />
                      </button>
                    </div>
                    <div className="chat-message-actions">
                      {isMine ? (
                        <button
                          aria-label="Edit message"
                          onClick={() => onBeginEdit(message)}
                          type="button"
                        >
                          <Edit3 aria-hidden="true" size={14} />
                        </button>
                      ) : null}
                      <span>
                        <CheckCheck aria-hidden="true" size={14} />
                        Seen by {readReceiptText(members, message.readBy, roomMembers)}
                      </span>
                    </div>
                  </footer>
                </div>
              </article>
            </div>
          );
        })}
      </div>
      {typingMembers.length > 0 ? <TypingIndicator members={typingMembers} /> : null}
    </div>
  );
}

function Composer({
  body,
  onChange,
  onSubmit,
  roomName,
}: {
  readonly body: string;
  readonly onChange: (body: string) => void;
  readonly onSubmit: (body: string) => void;
  readonly roomName: string;
}) {
  const composerForm = useForm({
    defaultValues: { body },
    onSubmit: ({ value }) => onSubmit(value.body),
  });

  useEffect(() => {
    composerForm.setFieldValue("body", body);
  }, [body, composerForm]);

  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void composerForm.handleSubmit();
      }}
    >
      <label className="sr-only" htmlFor="chat-composer-input">
        Message {roomName}
      </label>
      <button aria-label="Attach file" type="button">
        <Paperclip aria-hidden="true" size={17} />
      </button>
      <composerForm.Field
        name="body"
        validators={{
          onChange: validateStringWith(chatMessageBodySchema),
          onSubmit: validateStringWith(chatMessageBodySchema),
        }}
      >
        {(field) => (
          <>
            <textarea
              aria-describedby="chat-composer-error"
              aria-invalid={field.state.meta.errors.length > 0}
              id="chat-composer-input"
              onChange={(event) => {
                field.handleChange(event.target.value);
                onChange(event.target.value);
              }}
              placeholder={`Message ${roomName}`}
              rows={2}
              value={field.state.value}
            />
            <FieldErrors id="chat-composer-error" errors={field.state.meta.errors} />
          </>
        )}
      </composerForm.Field>
      <button aria-label="Mention teammate" type="button">
        <AtSign aria-hidden="true" size={17} />
      </button>
      <composerForm.Subscribe selector={(state) => state.values.body}>
        {(formBody) => (
          <button
            className="chat-send-button"
            disabled={formBody.trim().length === 0}
            type="submit"
          >
            <Send aria-hidden="true" size={17} />
            Send
          </button>
        )}
      </composerForm.Subscribe>
    </form>
  );
}

function EditMessageForm({
  initialBody,
  messageId,
  onCancel,
  onSubmit,
}: {
  readonly initialBody: string;
  readonly messageId: string;
  readonly onCancel: () => void;
  readonly onSubmit: (messageId: string, body: string) => void;
}) {
  const editForm = useForm({
    defaultValues: { body: initialBody },
    onSubmit: ({ value }) => onSubmit(messageId, value.body),
  });

  useEffect(() => {
    editForm.setFieldValue("body", initialBody);
  }, [editForm, initialBody]);

  return (
    <form
      className="chat-edit-form"
      onSubmit={(event) => {
        event.preventDefault();
        void editForm.handleSubmit();
      }}
    >
      <editForm.Field
        name="body"
        validators={{
          onChange: validateStringWith(chatMessageBodySchema),
          onSubmit: validateStringWith(chatMessageBodySchema),
        }}
      >
        {(field) => (
          <>
            <textarea
              aria-describedby="chat-edit-error"
              aria-invalid={field.state.meta.errors.length > 0}
              aria-label="Edit message"
              onChange={(event) => field.handleChange(event.target.value)}
              value={field.state.value}
            />
            <FieldErrors id="chat-edit-error" errors={field.state.meta.errors} />
          </>
        )}
      </editForm.Field>
      <div>
        <button className="helix-button helix-button-secondary" onClick={onCancel} type="button">
          Cancel
        </button>
        <button className="helix-button" type="submit">
          Save
        </button>
      </div>
    </form>
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

function TypingIndicator({ members: typingMembers }: { readonly members: readonly ChatMember[] }) {
  return (
    <div className="chat-typing" role="status">
      <Bot aria-hidden="true" size={16} />
      <span>{typingMembers.map((member) => member.name.split(" ")[0]).join(", ")} typing</span>
      <i aria-hidden="true" />
      <i aria-hidden="true" />
      <i aria-hidden="true" />
    </div>
  );
}

function PresenceAvatar({ member }: { readonly member: ChatMember | undefined }) {
  return (
    <span className="chat-avatar">
      {initialsFor(member?.name ?? "?")}
      <Circle
        className={`chat-presence-dot ${member?.presence ?? "offline"}`}
        aria-hidden="true"
        size={8}
      />
    </span>
  );
}

function RoomIcon({ room }: { readonly room: ChatRoom }) {
  if (room.isPrivate) {
    return <Lock aria-hidden="true" size={18} />;
  }

  return room.type === "dms" ? (
    <Users aria-hidden="true" size={18} />
  ) : (
    <Hash aria-hidden="true" size={18} />
  );
}

function memberById(members: readonly ChatMember[], memberId: string) {
  return members.find((member) => member.id === memberId);
}

function isChatMember(member: ChatMember | undefined): member is ChatMember {
  return Boolean(member);
}

function isLocalRoom(room: ChatRoom): boolean {
  return room.syncState === "local";
}

function isLocalMessage(message: ChatMessage): boolean {
  return message.syncState === "local";
}

function initialsFor(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function titleCase(value: string) {
  return value.length === 0 ? "Member" : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function readReceiptText(
  members: readonly ChatMember[],
  readByIds: readonly string[],
  roomMembers: readonly ChatMember[],
) {
  const readers = readByIds.map((memberId) => memberById(members, memberId)).filter(isChatMember);
  if (readers.length === 0) {
    return "no one yet";
  }

  if (readers.length === roomMembers.length) {
    return "everyone";
  }

  return readers
    .slice(0, 2)
    .map((member) => member.name.split(" ")[0])
    .join(", ");
}

function renderMessageText(body: string) {
  return body
    .split(mentionPattern)
    .map((part, index) =>
      part.startsWith("@") ? <mark key={`${part}-${index}`}>{part}</mark> : part,
    );
}

function buildBackendRoomState(records: readonly ChatRoomRecord[]): {
  readonly members: readonly ChatMember[];
  readonly rooms: readonly ChatRoom[];
} {
  const membersById = new Map(defaultMembers.map((member) => [member.id, member]));

  const rooms: readonly ChatRoom[] = records.map((record) => {
    for (const member of record.members ?? []) {
      membersById.set(member.actorId, {
        id: member.actorId,
        name: member.displayName ?? member.email ?? `User ${member.actorId.slice(0, 8)}`,
        role: titleCase(member.role),
        presence: "offline",
      });
    }
    const name = record.settings?.name ?? record.subject ?? `room-${record.id.slice(0, 8)}`;
    const memberIds = uniqueStrings((record.members ?? []).map((member) => member.actorId));
    return {
      id: record.id,
      type: record.kind === "chat_dm" ? "dms" : "rooms",
      name,
      description: record.settings?.topic ?? record.subject ?? "Chat conversation",
      memberIds,
      lastActivity: formatChatTimestamp(record.updatedAt),
      unreadCount: 0,
      mentionCount: 0,
      isPrivate: record.settings?.isPrivate ?? false,
      typingMemberIds: [],
    };
  });

  return {
    members: [...membersById.values()],
    rooms,
  };
}

function mergeBackendRoomsWithLocal(
  currentRooms: readonly ChatRoom[],
  backendRooms: readonly ChatRoom[],
): readonly ChatRoom[] {
  const backendRoomIds = new Set(backendRooms.map((room) => room.id));
  const localRooms = currentRooms.filter(
    (room) => room.syncState === "local" && !backendRoomIds.has(room.id),
  );
  return [...localRooms, ...backendRooms];
}

function chatMessageFromRecord(
  record: ChatMessageRecord,
  members: readonly ChatMember[],
): ChatMessage {
  const authorId = record.actorId ?? meId;
  const readBy =
    memberById(members, authorId) === undefined ? [meId] : uniqueStrings([meId, authorId]);

  return {
    id: record.id,
    roomId: record.roomId,
    authorId,
    body: record.body,
    sentAt: formatChatTimestamp(record.sentAt),
    editedAt: record.editedAt === null ? undefined : formatChatTimestamp(record.editedAt),
    reactions: [],
    readBy,
    attachments: record.attachmentObjectIds,
  };
}

function mergePresenceEntries(
  members: readonly ChatMember[],
  entries: readonly ChatPresenceEntry[],
): readonly ChatMember[] {
  return entries.reduce(
    (current, entry) => upsertMember(current, memberFromPresence(entry)),
    members,
  );
}

function mergeRoomMemberIds(
  rooms: readonly ChatRoom[],
  roomId: string,
  memberIds: readonly string[],
): readonly ChatRoom[] {
  return rooms.map((room) =>
    room.id === roomId
      ? { ...room, memberIds: uniqueStrings([...room.memberIds, ...memberIds]) }
      : room,
  );
}

function setMemberPresence(
  members: readonly ChatMember[],
  memberId: string,
  presence: PresenceState,
): readonly ChatMember[] {
  return ensureMember(members, memberId).map((member) =>
    member.id === memberId ? { ...member, presence } : member,
  );
}

function ensureMember(members: readonly ChatMember[], memberId: string): readonly ChatMember[] {
  return memberById(members, memberId) === undefined
    ? [...members, fallbackMember(memberId)]
    : members;
}

function upsertMember(
  members: readonly ChatMember[],
  nextMember: ChatMember,
): readonly ChatMember[] {
  return memberById(members, nextMember.id) === undefined
    ? [...members, nextMember]
    : members.map((member) =>
        member.id === nextMember.id
          ? {
              ...member,
              name: nextMember.name,
              role: nextMember.role,
              presence: nextMember.presence,
            }
          : member,
      );
}

function setRoomTyping(
  rooms: readonly ChatRoom[],
  roomId: string,
  actorId: string,
  isTyping: boolean,
): readonly ChatRoom[] {
  return rooms.map((room) => {
    if (room.id !== roomId) {
      return room;
    }

    const typingMemberIds = isTyping
      ? uniqueStrings([...room.typingMemberIds, actorId])
      : room.typingMemberIds.filter((memberId) => memberId !== actorId);
    return { ...room, typingMemberIds };
  });
}

function updateRoomActivity(
  rooms: readonly ChatRoom[],
  roomId: string,
  lastActivity: string,
): readonly ChatRoom[] {
  return rooms.map((room) => (room.id === roomId ? { ...room, lastActivity } : room));
}

function upsertMessage(
  messages: readonly ChatMessage[],
  nextMessage: ChatMessage,
): readonly ChatMessage[] {
  return messages.some((message) => message.id === nextMessage.id)
    ? messages.map((message) => (message.id === nextMessage.id ? nextMessage : message))
    : [...messages, nextMessage];
}

function markMessageRead(
  messages: readonly ChatMessage[],
  messageId: string,
  actorId: string,
): readonly ChatMessage[] {
  return messages.map((message) =>
    message.id === messageId
      ? { ...message, readBy: uniqueStrings([...message.readBy, actorId]) }
      : message,
  );
}

/**
 * Marks every message in {@link roomId} at or before {@link messageId} as read by
 * {@link actorId}. Read receipts are a per-room last-read marker, so seeing one message
 * implies all earlier messages in the same room were also seen.
 */
function markReadUpTo(
  messages: readonly ChatMessage[],
  roomId: string,
  messageId: string,
  actorId: string,
): readonly ChatMessage[] {
  const markerIndex = messages.findIndex(
    (message) => message.roomId === roomId && message.id === messageId,
  );
  if (markerIndex === -1) {
    return markMessageRead(messages, messageId, actorId);
  }

  return messages.map((message, index) =>
    message.roomId === roomId && index <= markerIndex
      ? { ...message, readBy: uniqueStrings([...message.readBy, actorId]) }
      : message,
  );
}

function memberFromPresence(entry: ChatPresenceEntry): ChatMember {
  return {
    id: entry.actorId,
    name: entry.displayName ?? entry.email ?? `User ${entry.actorId.slice(0, 8)}`,
    role: entry.actorId === meId ? "Product" : "Member",
    presence: "online",
  };
}

function fallbackMember(memberId: string): ChatMember {
  return {
    id: memberId,
    name: `User ${memberId.slice(0, 8)}`,
    role: "Member",
    presence: "offline",
  };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function formatChatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
