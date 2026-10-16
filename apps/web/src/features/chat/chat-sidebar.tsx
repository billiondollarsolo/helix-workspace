/* Chat navigation: New chat, Home, Mentions, then Direct messages and
   Spaces. Unread conversations are bold with a count; conversations where
   you were @mentioned show an @ badge. On phones this is the first screen. */

import { Avatar } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { AtSign as MentionIcon, House as HomeIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ChatConversationView } from "./view-model";

export type ChatView =
  | { readonly kind: "home" }
  | { readonly kind: "mentions" }
  | { readonly kind: "room"; readonly roomId: string };

interface ChatSidebarProps {
  readonly status: "loading" | "error" | "ready";
  readonly conversations: readonly ChatConversationView[];
  readonly view: ChatView;
  readonly totalUnread: number;
  readonly totalMentions: number;
  readonly onSelect: (view: ChatView) => void;
  /** The New chat menu (`NewChat variant="sidebar"`). */
  readonly newChat: ReactNode;
}

export function ChatSidebar({
  status,
  conversations,
  view,
  totalUnread,
  totalMentions,
  onSelect,
  newChat,
}: ChatSidebarProps) {
  const directs = conversations.filter((conversation) => conversation.kind === "dm");
  const spaces = conversations.filter((conversation) => conversation.kind === "space");
  const activeRoomId = view.kind === "room" ? view.roomId : null;

  return (
    <nav className="surf-sidebar chat-sidebar" aria-label="Chat">
      {newChat}
      <div className="chat-nav-group">
        <NavRow
          label="Home"
          icon={<HomeIcon size={18} aria-hidden="true" />}
          current={view.kind === "home"}
          unread={totalUnread}
          onClick={() => onSelect({ kind: "home" })}
        />
        <NavRow
          label="Mentions"
          icon={<MentionIcon size={18} aria-hidden="true" />}
          current={view.kind === "mentions"}
          unread={0}
          mentions={totalMentions}
          onClick={() => onSelect({ kind: "mentions" })}
        />
      </div>

      {status === "loading" ? (
        <Skeleton
          variant="text"
          count={6}
          label="Loading conversations"
          className="chat-sidebar-skeleton"
        />
      ) : status === "error" ? null : (
        <>
          <ConversationSection
            title="Direct messages"
            emptyText="No direct messages yet."
            conversations={directs}
            activeRoomId={activeRoomId}
            onSelect={(roomId) => onSelect({ kind: "room", roomId })}
          />
          <ConversationSection
            title="Spaces"
            emptyText="You aren’t in any spaces yet."
            conversations={spaces}
            activeRoomId={activeRoomId}
            onSelect={(roomId) => onSelect({ kind: "room", roomId })}
          />
        </>
      )}
    </nav>
  );
}

function ConversationSection({
  title,
  emptyText,
  conversations,
  activeRoomId,
  onSelect,
}: {
  readonly title: string;
  readonly emptyText: string;
  readonly conversations: readonly ChatConversationView[];
  readonly activeRoomId: string | null;
  readonly onSelect: (roomId: string) => void;
}) {
  return (
    <section className="chat-nav-section" aria-label={title}>
      <h2 className="surf-section-label">{title}</h2>
      {conversations.length === 0 ? (
        <p className="chat-sidebar-empty">{emptyText}</p>
      ) : (
        conversations.map((conversation) => (
          <NavRow
            key={conversation.id}
            label={conversation.name}
            icon={<ConversationAvatar conversation={conversation} size={22} />}
            current={conversation.id === activeRoomId}
            unread={conversation.unread}
            mentions={conversation.mentions}
            onClick={() => onSelect(conversation.id)}
          />
        ))
      )}
    </section>
  );
}

function NavRow({
  label,
  icon,
  current,
  unread,
  mentions = 0,
  onClick,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly current: boolean;
  readonly unread: number;
  readonly mentions?: number;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="surf-nav-row chat-nav-row"
      aria-current={current ? "page" : undefined}
      data-unread={unread > 0 || mentions > 0}
      title={label}
      onClick={onClick}
    >
      {icon}
      <span className="label">{label}</span>
      <UnreadBadge unread={unread} mentions={mentions} />
    </button>
  );
}

/** "@" when you were mentioned, otherwise the unread count. */
export function UnreadBadge({
  unread,
  mentions,
}: {
  readonly unread: number;
  readonly mentions: number;
}) {
  if (mentions > 0) {
    return (
      <span className="count chat-badge chat-badge-mention">
        <span aria-hidden="true">@</span>
        <span className="sr-only">
          {mentions === 1 ? "1 mention" : `${String(mentions)} mentions`}
        </span>
      </span>
    );
  }
  if (unread <= 0) return null;
  return (
    <span className="count chat-badge">
      <span aria-hidden="true">{unread > 99 ? "99+" : unread}</span>
      <span className="sr-only">{unread === 1 ? "1 unread" : `${String(unread)} unread`}</span>
    </span>
  );
}

/** A person's avatar with presence for a one-to-one chat; initials for spaces and groups. */
export function ConversationAvatar({
  conversation,
  size,
}: {
  readonly conversation: ChatConversationView;
  readonly size: number;
}) {
  if (conversation.peer !== null) {
    return (
      <span
        className="chat-avatar-wrap"
        role="img"
        aria-label={conversation.presenceLabel ?? (conversation.active ? "Available" : "Offline")}
        title={conversation.presenceLabel}
      >
        <Avatar name={conversation.name} size={size} />
        <span
          className="chat-presence-dot"
          data-presence={conversation.active ? "active" : "offline"}
        />
      </span>
    );
  }
  return (
    <span className="chat-avatar-wrap" aria-hidden="true">
      <Avatar
        name={conversation.name}
        size={size}
        className={conversation.kind === "space" ? "chat-space-avatar" : undefined}
      />
    </span>
  );
}
