/* Home and Mentions — the two feeds above the conversation list.
   Home lists conversations with unread ones first; Mentions lists the
   messages that @mention you, newest first. */

import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChatMention } from "@helix/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft as BackIcon,
  AtSign as MentionIcon,
  MessagesSquare as ChatsIcon,
} from "lucide-react";
import { useState } from "react";
import { ConversationAvatar, UnreadBadge } from "./chat-sidebar";
import { StartChatDialog } from "./new-chat";
import { chatMentionsQueryOptions, chatQueryKeys } from "./queries";
import { formatChatWhen, homeFeed, type ChatConversationView } from "./view-model";

function FeedHeader({ id, title, onBack }: { id: string; title: string; onBack: () => void }) {
  return (
    <header className="chat-feed-header">
      <button
        type="button"
        className="icon-btn chat-back"
        aria-label="Back to conversations"
        onClick={onBack}
      >
        <BackIcon size={18} aria-hidden="true" />
      </button>
      <h2 id={id} className="type-h3">
        {title}
      </h2>
    </header>
  );
}

export function ChatHome({
  conversations,
  onOpenRoom,
  onBack,
}: {
  readonly conversations: readonly ChatConversationView[];
  readonly onOpenRoom: (roomId: string) => void;
  readonly onBack: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const feed = homeFeed(conversations);

  return (
    <section className="chat-feed" aria-labelledby="chat-home-title">
      <FeedHeader id="chat-home-title" title="Home" onBack={onBack} />
      {feed.length === 0 ? (
        <EmptyState
          icon={<ChatsIcon />}
          title="No conversations yet — start a chat"
          body="Message a teammate directly, or create a space for a project or team."
          action={
            <button type="button" className="btn primary" onClick={() => setStarting(true)}>
              Start a chat
            </button>
          }
        />
      ) : (
        <ul className="chat-feed-list" aria-label="Recent conversations">
          {feed.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                className="chat-feed-row"
                data-unread={conversation.unread > 0}
                onClick={() => onOpenRoom(conversation.id)}
              >
                <ConversationAvatar conversation={conversation} size={36} />
                <span className="chat-feed-text">
                  <span className="chat-feed-name">{conversation.name}</span>
                  <span className="chat-feed-meta">
                    {conversation.kind === "space"
                      ? `Space · ${String(conversation.memberCount)} members`
                      : conversation.peer === null
                        ? "Group conversation"
                        : "Direct message"}
                  </span>
                </span>
                {conversation.lastMessageAt === null ? null : (
                  <time className="chat-feed-time" dateTime={conversation.lastMessageAt}>
                    {formatChatWhen(conversation.lastMessageAt)}
                  </time>
                )}
                <UnreadBadge unread={conversation.unread} mentions={conversation.mentions} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {starting ? (
        <StartChatDialog
          onClose={() => setStarting(false)}
          onCreated={(roomId) => {
            setStarting(false);
            onOpenRoom(roomId);
          }}
        />
      ) : null}
    </section>
  );
}

export function ChatMentions({
  onOpenMention,
  onBack,
}: {
  readonly onOpenMention: (mention: ChatMention) => void;
  readonly onBack: () => void;
}) {
  const mentions = useQuery(chatMentionsQueryOptions(true));
  const queryClient = useQueryClient();

  return (
    <section className="chat-feed" aria-labelledby="chat-mentions-title">
      <FeedHeader id="chat-mentions-title" title="Mentions" onBack={onBack} />
      {mentions.isPending ? (
        <Skeleton variant="row" count={6} label="Loading mentions" />
      ) : mentions.isError ? (
        <div className="chat-feed-state">
          <InlineError
            title="Couldn’t load your mentions"
            message="Check your connection and try again."
            onRetry={() =>
              void queryClient.invalidateQueries({ queryKey: chatQueryKeys.mentions() })
            }
            retrying={mentions.isFetching}
          />
        </div>
      ) : mentions.data.mentions.length === 0 ? (
        <EmptyState
          icon={<MentionIcon />}
          title="No mentions yet"
          body="When someone @mentions you in a conversation, it shows up here."
        />
      ) : (
        <ul className="chat-feed-list" aria-label="Messages that mention you">
          {mentions.data.mentions.map((mention) => {
            const author = mention.actorDisplayName ?? "Someone";
            return (
              <li key={mention.messageId}>
                <button
                  type="button"
                  className="chat-feed-row chat-mention-row"
                  data-unread={mention.unread}
                  onClick={() => onOpenMention(mention)}
                >
                  <Avatar name={author} size={36} />
                  <span className="chat-feed-text">
                    <span className="chat-feed-name">
                      {author}
                      <span className="chat-feed-room">
                        {" "}
                        in {mention.roomName.length > 0 ? mention.roomName : "a direct message"}
                        {mention.parentMessageId === null ? "" : " (thread)"}
                      </span>
                    </span>
                    <span className="chat-feed-preview">{mention.preview}</span>
                  </span>
                  <time className="chat-feed-time" dateTime={mention.sentAt}>
                    {formatChatWhen(mention.sentAt)}
                  </time>
                  {mention.unread ? <span className="sr-only">Unread</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
