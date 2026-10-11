/* An open conversation: header, message log, typing line and composer,
   with the thread or details panel on the right. Render with
   `key={room.id}` so scroll position, the unread divider and panels reset
   when the conversation changes. */

import { useOnline } from "@/components/shell/network-status";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useShortcuts } from "@/lib/shortcuts/use-shortcuts";
import type { ChatRoomUnread } from "@helix/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquare as MessagesIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { ChatRoomRecord } from "./api";
import { ChatComposer } from "./chat-composer";
import { AddPeopleDialog, ChatConversationHeader } from "./chat-header";
import { ChatMessageList, type ChatScrollRequest } from "./chat-message-list";
import { ChatTypingIndicator } from "./chat-message-row";
import { ChatDetailsPanel, ChatThreadPanel, type InfoTab } from "./chat-panels";
import { chatPinsQueryOptions, chatQueryKeys, chatThreadQueryOptions } from "./queries";
import type { ChatRealtimeState } from "./use-chat-realtime";
import { useChatMessages } from "./use-chat-messages";
import { useMessageActions } from "./use-message-actions";
import {
  roomAbout,
  roomMembers,
  toMessageView,
  type ChatConversationView,
  type ChatMessageView,
} from "./view-model";

interface ChatConversationProps {
  readonly room: ChatRoomRecord;
  readonly conversation: ChatConversationView;
  readonly realtime: ChatRealtimeState;
  readonly unread: ChatRoomUnread | undefined;
  readonly nameForActor: (actorId: string | null) => string;
  readonly threadId: string | null;
  readonly onThreadChange: (threadId: string | null) => void;
  readonly focusMessageId: string | null;
  readonly onFocusMessage: (messageId: string) => void;
  readonly onFocusHandled: () => void;
  /** Another panel (search) has the right-hand side. */
  readonly sidePanelTaken: boolean;
  readonly onBack: () => void;
}

export function ChatConversation({
  room,
  conversation,
  realtime,
  unread,
  nameForActor,
  threadId,
  onThreadChange,
  focusMessageId,
  onFocusMessage,
  onFocusHandled,
  sidePanelTaken,
  onBack,
}: ChatConversationProps) {
  const online = useOnline();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tab, setTab] = useState<InfoTab>("about");
  const [addingPeople, setAddingPeople] = useState(false);
  const [scrollRequest, setScrollRequest] = useState<ChatScrollRequest | null>(null);
  const selfActorId = realtime.selfActorId;
  const members = useMemo(() => roomMembers(room), [room]);
  const otherActorIds = members
    .filter((member) => member.actorId !== selfActorId)
    .map((member) => member.actorId);
  const { query, messages, firstUnreadId, loadOlder, findMessage } = useChatMessages({
    room,
    realtime,
    nameForActor,
    unread,
  });
  const pins = useQuery({ ...chatPinsQueryOptions(room.id), enabled: detailsOpen });

  const closeThread = () => onThreadChange(null);
  const message = useMessageActions({
    roomId: room.id,
    roomName: conversation.name,
    otherActorIds,
    realtime,
    threadId,
    onOpenThread: onThreadChange,
    onCloseThread: closeThread,
  });
  const actions = message.actionsFor(messages);

  const threadParent = threadId === null ? undefined : findMessage(threadId);
  const threadQuery = useQuery(chatThreadQueryOptions(room.id, threadParent ? threadId : null));
  const replies = useMemo<readonly ChatMessageView[]>(
    () =>
      (threadQuery.data ?? []).map((record) =>
        toMessageView({ record, selfActorId, nameForActor, readBy: 0 }),
      ),
    [threadQuery.data, selfActorId, nameForActor],
  );

  const role = room.members?.find((member) => member.actorId === selfActorId)?.role;
  const announcementOnly =
    room.settings?.spaceType === "announcement" && role !== "owner" && role !== "moderator";
  const isSpace = room.kind === "chat_room";
  const canAddPeople = isSpace && (role === "owner" || role === "moderator");

  useShortcuts("chat", {
    "chat.close-thread": sidePanelTaken
      ? undefined
      : threadParent !== undefined
        ? closeThread
        : detailsOpen
          ? () => setDetailsOpen(false)
          : undefined,
    "chat.jump-first-unread": () => setScrollRequest({ target: "unread", nonce: Date.now() }),
    "chat.jump-newest": () => setScrollRequest({ target: "newest", nonce: Date.now() }),
  });

  const showThread = !sidePanelTaken && threadParent !== undefined;
  const showDetails = !sidePanelTaken && !showThread && detailsOpen;
  const placeholder = announcementOnly
    ? "Only space managers can post here"
    : `Message ${conversation.name}`;

  return (
    <div className="chat-conversation">
      <section className="chat-channel" aria-labelledby={`${detailsId}-name`}>
        <span id={`${detailsId}-name`} className="sr-only">
          {conversation.name}
        </span>
        <ChatConversationHeader
          conversation={conversation}
          detailsOpen={showDetails}
          detailsId={detailsId}
          onToggleDetails={() => {
            setDetailsOpen((open) => !open || !showDetails);
            if (threadParent !== undefined) closeThread();
          }}
          onBack={onBack}
          onScheduleEvent={() => {
            const attendees = members
              .filter((member) => member.actorId !== selfActorId && member.email !== null)
              .map((member) => member.email ?? "");
            void navigate({
              to: "/calendar",
              search: {
                create: "event",
                ...(attendees.length > 0 ? { attendees: attendees.join(",") } : {}),
              },
            });
          }}
          onAddPeople={canAddPeople ? () => setAddingPeople(true) : undefined}
        />
        {online && (realtime.connection === "reconnecting" || realtime.connection === "closed") ? (
          <p className="chat-banner" role="status">
            {realtime.connection === "reconnecting"
              ? "Reconnecting… new messages may be delayed."
              : "Live updates are paused. New messages appear when you reload."}
          </p>
        ) : null}

        {query.isPending ? (
          <div className="chat-messages chat-messages-loading">
            <Skeleton variant="row" count={6} label="Loading messages" />
          </div>
        ) : query.isError ? (
          <div className="chat-messages chat-messages-error">
            <InlineError
              title={online ? "Couldn’t load messages" : "You’re offline"}
              message={
                online
                  ? "Something went wrong on our side. Try again."
                  : "Messages will load when your connection is back."
              }
              onRetry={() =>
                void queryClient.invalidateQueries({
                  queryKey: chatQueryKeys.messagesInfinite(room.id),
                })
              }
              retrying={query.isFetching}
            />
          </div>
        ) : (
          <ChatMessageList
            label={`Messages in ${conversation.name}`}
            messages={messages}
            actions={actions}
            firstUnreadId={firstUnreadId}
            activeThreadId={threadId}
            focusMessageId={focusMessageId}
            onFocusHandled={onFocusHandled}
            scrollRequest={scrollRequest}
            hasOlder={query.hasNextPage}
            loadingOlder={query.isFetchingNextPage}
            onLoadOlder={loadOlder}
            empty={
              <EmptyState
                size="inline"
                headingLevel={3}
                icon={<MessagesIcon />}
                title="No messages yet"
                body={
                  conversation.kind === "space"
                    ? "Start the conversation in this space."
                    : `Say hello to ${conversation.name}.`
                }
              />
            }
          />
        )}

        <ChatTypingIndicator names={realtime.typingActorIds.map((id) => nameForActor(id))} />
        <ChatComposer
          roomId={room.id}
          label={placeholder}
          disabled={announcementOnly || query.isError}
          members={members}
          selfActorId={selfActorId}
          onSend={message.sendMessage}
          onTyping={realtime.setTyping}
          onStartMeeting={message.startMeeting}
        />
      </section>

      {showThread ? (
        <ChatThreadPanel
          roomName={conversation.name}
          parent={threadParent}
          replies={replies}
          status={threadQuery.isPending ? "loading" : threadQuery.isError ? "error" : "ready"}
          onRetry={() =>
            void queryClient.invalidateQueries({
              queryKey: chatQueryKeys.thread(room.id, threadParent.id),
            })
          }
          actions={{ ...message.actionsFor([threadParent, ...replies]), onOpenThread: undefined }}
          onClose={closeThread}
          composer={
            <ChatComposer
              roomId={room.id}
              draftKey={`${room.id}:${threadParent.id}`}
              label="Reply in thread"
              disabled={announcementOnly}
              members={members}
              selfActorId={selfActorId}
              onSend={message.sendReply}
              onTyping={realtime.setTyping}
            />
          }
        />
      ) : null}

      {showDetails ? (
        <ChatDetailsPanel
          id={detailsId}
          about={roomAbout(room)}
          members={members}
          pins={pins.data ?? []}
          messageById={findMessage}
          tab={tab}
          onTabChange={setTab}
          onAddPeople={canAddPeople ? () => setAddingPeople(true) : undefined}
          onJumpToMessage={onFocusMessage}
          onClose={() => setDetailsOpen(false)}
        />
      ) : null}

      {addingPeople ? (
        <AddPeopleDialog
          roomId={room.id}
          roomName={conversation.name}
          memberActorIds={new Set(members.map((member) => member.actorId))}
          onClose={() => setAddingPeople(false)}
        />
      ) : null}
    </div>
  );
}
