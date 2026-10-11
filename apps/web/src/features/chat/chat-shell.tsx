/* Chat surface: navigation (New chat, Home, Mentions, direct messages and
   spaces), the open view, and the search results panel. On phones the
   conversation list comes first and a conversation opens full screen. */

import { SurfaceFrame } from "@/components/shell";
import { useOnline } from "@/components/shell/network-status";
import { useMobileLayout } from "@/components/shell/use-mobile-layout";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { ComposeHost } from "@/features/mail/compose";
import { sessionUserQueryOptions } from "@/lib/auth";
import { useShortcuts } from "@/lib/shortcuts/use-shortcuts";
import type { ChatMention, ChatSearchHit } from "@helix/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { MessageCircle as ChatIcon, MessagesSquare as ChatsIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatConversation } from "./chat-conversation";
import { ChatHome, ChatMentions } from "./chat-home";
import { ChatSearchPanel } from "./chat-search";
import "./chat-shell.css";
import { ChatSidebar, type ChatView } from "./chat-sidebar";
import { NewChat } from "./new-chat";
import { chatQueryKeys, chatRoomListQueryOptions, chatUnreadQueryOptions } from "./queries";
import { useChatRealtime } from "./use-chat-realtime";
import { useDirectMessageHandoff } from "./use-dm-handoff";
import { conversationViews, memberDisplayName, presenceMap } from "./view-model";

interface ChatRouteSearch {
  readonly room?: string;
  readonly thread?: string;
  readonly message?: string;
  readonly view?: "mentions";
  readonly dm?: string;
}

function viewFromSearch(search: ChatRouteSearch): ChatView {
  if (search.room !== undefined) return { kind: "room", roomId: search.room };
  return search.view === "mentions" ? { kind: "mentions" } : { kind: "home" };
}

export function ChatShell() {
  const urlSearch: ChatRouteSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const online = useOnline();
  const mobile = useMobileLayout();
  const sessionUser = useQuery(sessionUserQueryOptions()).data;
  const [view, setView] = useState<ChatView>(() => viewFromSearch(urlSearch));
  const [threadId, setThreadId] = useState<string | null>(urlSearch.thread ?? null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(urlSearch.message ?? null);
  // Phones show the list until something is opened.
  const [mobileContent, setMobileContent] = useState(urlSearch.room !== undefined);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [searchScope, setSearchScope] = useState<"all" | "room">("all");

  const roomsQuery = useQuery(chatRoomListQueryOptions());
  const unreadQuery = useQuery(chatUnreadQueryOptions());
  const rooms = useMemo(() => roomsQuery.data ?? [], [roomsQuery.data]);
  const activeRoomId = view.kind === "room" ? view.roomId : undefined;
  const realtime = useChatRealtime({ roomId: activeRoomId });
  const selfActorId = realtime.selfActorId ?? sessionUser?.actorId ?? null;

  const presence = useMemo(() => presenceMap(realtime.presence), [realtime.presence]);
  const conversations = useMemo(
    () => conversationViews(rooms, selfActorId, unreadQuery.data?.rooms ?? [], presence),
    [rooms, selfActorId, unreadQuery.data, presence],
  );
  const activeRoom = rooms.find((room) => room.id === activeRoomId);
  const activeConversation = conversations.find((entry) => entry.id === activeRoomId);

  // Keep the URL in step so links, reloads and Back work.
  useEffect(() => {
    const next: ChatRouteSearch = {
      ...(view.kind === "room" ? { room: view.roomId } : {}),
      ...(view.kind === "mentions" ? { view: "mentions" as const } : {}),
      ...(view.kind === "room" && threadId !== null ? { thread: threadId } : {}),
    };
    if (
      next.room === urlSearch.room &&
      next.view === urlSearch.view &&
      next.thread === urlSearch.thread &&
      urlSearch.message === undefined &&
      urlSearch.dm === undefined
    ) {
      return;
    }
    void navigate({ to: "/chat", search: next, replace: urlSearch.message !== undefined });
  }, [view, threadId]);

  const openView = useCallback((next: ChatView) => {
    setView(next);
    setThreadId(null);
    setFocusMessageId(null);
    setMobileContent(true);
  }, []);
  const openRoom = useCallback((roomId: string) => openView({ kind: "room", roomId }), [openView]);

  useDirectMessageHandoff(urlSearch.dm, openRoom);

  const nameForActor = useCallback(
    (actorId: string | null): string => {
      if (actorId === null) return "Helix";
      if (actorId === sessionUser?.actorId && sessionUser.name.trim())
        return sessionUser.name.trim();
      for (const room of [activeRoom, ...rooms]) {
        const member = room?.members?.find((m) => m.actorId === actorId);
        if (member !== undefined) return memberDisplayName(member);
      }
      const present = realtime.presence.find((p) => p.actorId === actorId);
      if (present?.displayName !== undefined && present.displayName.length > 0) {
        return present.displayName;
      }
      return actorId === selfActorId ? "You" : "Former member";
    },
    [activeRoom, rooms, realtime.presence, selfActorId, sessionUser],
  );

  // Alt+↑/↓ steps through the list; with Shift, only through unread ones.
  const ordered = useMemo(
    () => [
      ...conversations.filter((entry) => entry.kind === "dm"),
      ...conversations.filter((entry) => entry.kind === "space"),
    ],
    [conversations],
  );
  const step = (direction: 1 | -1, unreadOnly: boolean) => () => {
    const index = ordered.findIndex((entry) => entry.id === activeRoomId);
    for (let i = index + direction; i >= 0 && i < ordered.length; i += direction) {
      const candidate = ordered[i];
      if (candidate !== undefined && (!unreadOnly || candidate.unread > 0)) {
        openRoom(candidate.id);
        return;
      }
    }
    return false;
  };
  useShortcuts("chat", {
    "chat.previous-conversation": step(-1, false),
    "chat.next-conversation": step(1, false),
    "chat.previous-unread-conversation": step(-1, true),
    "chat.next-unread-conversation": step(1, true),
    "chat.close-search":
      searchQuery === null
        ? undefined
        : () => {
            setSearchQuery(null);
            setSearchDraft("");
          },
  });

  const status = roomsQuery.isPending ? "loading" : roomsQuery.isError ? "error" : "ready";
  const joinedRoomIds = useMemo(() => new Set(rooms.map((room) => room.id)), [rooms]);

  const openHit = (hit: ChatSearchHit) => {
    openView({ kind: "room", roomId: hit.roomId });
    setFocusMessageId(hit.messageId);
  };
  const openMention = (mention: ChatMention) => {
    openView({ kind: "room", roomId: mention.roomId });
    setThreadId(mention.parentMessageId);
    setFocusMessageId(mention.parentMessageId ?? mention.messageId);
  };

  let content;
  if (status === "loading") {
    content = (
      <div className="chat-feed">
        <Skeleton variant="row" count={8} label="Loading conversations" />
      </div>
    );
  } else if (status === "error") {
    content = (
      <div className="chat-feed chat-feed-state">
        <InlineError
          title={online ? "Couldn’t load your conversations" : "You’re offline"}
          message={
            online
              ? "Chat isn’t responding right now. Try again in a moment."
              : "Chat will load when your connection is back."
          }
          onRetry={() => void queryClient.invalidateQueries({ queryKey: chatQueryKeys.rooms() })}
          retrying={roomsQuery.isFetching}
        />
      </div>
    );
  } else if (view.kind === "mentions") {
    content = <ChatMentions onOpenMention={openMention} onBack={() => setMobileContent(false)} />;
  } else if (view.kind === "room" && activeRoom !== undefined && activeConversation !== undefined) {
    content = (
      <ChatConversation
        key={activeRoom.id}
        room={activeRoom}
        conversation={activeConversation}
        realtime={realtime}
        unread={unreadQuery.data?.rooms.find((entry) => entry.roomId === activeRoom.id)}
        nameForActor={nameForActor}
        threadId={threadId}
        onThreadChange={setThreadId}
        focusMessageId={focusMessageId}
        onFocusMessage={setFocusMessageId}
        onFocusHandled={() => setFocusMessageId(null)}
        sidePanelTaken={searchQuery !== null}
        onBack={() => setMobileContent(false)}
      />
    );
  } else if (view.kind === "room") {
    content = (
      <div className="chat-feed chat-feed-state">
        <EmptyState
          icon={<ChatsIcon />}
          title="This conversation isn’t available"
          body="It may have been deleted, or you are no longer a member."
          action={
            <button type="button" className="btn" onClick={() => openView({ kind: "home" })}>
              Go to Home
            </button>
          }
        />
      </div>
    );
  } else {
    content = (
      <ChatHome
        conversations={conversations}
        onOpenRoom={openRoom}
        onBack={() => setMobileContent(false)}
      />
    );
  }

  return (
    <SurfaceFrame
      title="Chat"
      icon={<ChatIcon size={16} />}
      searchPlaceholder="Search in Chat"
      searchValue={searchDraft}
      onSearchChange={(value) => {
        setSearchDraft(value);
        if (value.trim().length === 0) setSearchQuery(null);
      }}
      onSearchSubmit={(value) => {
        const query = value.trim();
        setSearchQuery(query.length === 0 ? null : query);
        if (query.length > 0) setMobileContent(true);
      }}
    >
      <div className="chat-body" data-mobile-pane={mobileContent ? "content" : "list"}>
        <h1 className="sr-only">Chat</h1>
        <ChatSidebar
          status={status}
          conversations={conversations}
          view={view}
          totalUnread={unreadQuery.data?.totalUnread ?? 0}
          totalMentions={unreadQuery.data?.totalMentions ?? 0}
          onSelect={openView}
          newChat={
            <NewChat variant="sidebar" joinedRoomIds={joinedRoomIds} onOpenRoom={openRoom} />
          }
        />
        <div className="chat-main">{content}</div>
        {searchQuery === null ? null : (
          <ChatSearchPanel
            query={searchQuery}
            room={
              activeConversation === undefined
                ? null
                : { id: activeConversation.id, name: activeConversation.name }
            }
            scope={searchScope}
            onScopeChange={setSearchScope}
            roomName={(roomId) =>
              conversations.find((entry) => entry.id === roomId)?.name ?? "Conversation"
            }
            actorName={nameForActor}
            onOpenHit={(hit) => {
              openHit(hit);
              if (mobile) setSearchQuery(null);
            }}
            onClose={() => {
              setSearchQuery(null);
              setSearchDraft("");
            }}
          />
        )}
        {mobile && !mobileContent ? (
          <div className="chat-fab-wrap">
            <NewChat variant="fab" joinedRoomIds={joinedRoomIds} onOpenRoom={openRoom} />
          </div>
        ) : null}
      </div>
      <ComposeHost />
    </SurfaceFrame>
  );
}
