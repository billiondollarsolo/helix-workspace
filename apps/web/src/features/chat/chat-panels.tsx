/* Right-hand panels: the thread panel (a message and its replies, with a
   reply composer; Esc closes it) and the conversation details panel (about,
   members and pinned messages), which is closed until the header toggle
   opens it. */

import { Avatar } from "@/components/ui/avatar";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Pin as PinIcon, UserPlus as AddPeopleIcon, X as XIcon } from "lucide-react";
import { useId, type ReactNode } from "react";
import type { ChatPinRecord } from "./api";
import { ChatMessageList } from "./chat-message-list";
import type { ChatMessageActions } from "./chat-message-row";
import {
  formatChatWhen,
  type ChatAboutView,
  type ChatMemberView,
  type ChatMessageView,
} from "./view-model";

export type InfoTab = "about" | "members" | "pinned";

interface ChatThreadPanelProps {
  readonly roomName: string;
  readonly parent: ChatMessageView;
  readonly replies: readonly ChatMessageView[];
  readonly status: "loading" | "error" | "ready";
  readonly onRetry: () => void;
  readonly actions: ChatMessageActions;
  readonly composer: ReactNode;
  readonly onClose: () => void;
}

export function ChatThreadPanel({
  roomName,
  parent,
  replies,
  status,
  onRetry,
  actions,
  composer,
  onClose,
}: ChatThreadPanelProps) {
  const titleId = useId();
  return (
    <aside className="chat-side-panel chat-thread-panel" aria-labelledby={titleId}>
      <header className="chat-side-header">
        <div className="chat-side-titles">
          <h2 id={titleId} className="chat-side-title">
            Thread
          </h2>
          <span className="chat-side-sub">{roomName}</span>
        </div>
        <button type="button" className="icon-btn" aria-label="Close thread" onClick={onClose}>
          <XIcon size={18} aria-hidden="true" />
        </button>
      </header>
      {status === "error" ? (
        <div className="chat-side-state">
          <InlineError
            variant="compact"
            title="Couldn’t load replies"
            message="Check your connection and try again."
            onRetry={onRetry}
          />
        </div>
      ) : null}
      <ChatMessageList
        key={parent.id}
        label="Thread replies"
        messages={status === "ready" ? [parent, ...replies] : [parent]}
        actions={actions}
      />
      {status === "loading" ? <Skeleton variant="text" count={2} label="Loading replies" /> : null}
      {composer}
    </aside>
  );
}

interface ChatDetailsPanelProps {
  readonly id: string;
  readonly about: ChatAboutView;
  readonly members: readonly ChatMemberView[];
  readonly pins: readonly ChatPinRecord[];
  readonly messageById: (messageId: string) => ChatMessageView | undefined;
  readonly tab: InfoTab;
  readonly onTabChange: (tab: InfoTab) => void;
  readonly onAddPeople?: (() => void) | undefined;
  readonly onJumpToMessage: (messageId: string) => void;
  readonly onClose: () => void;
}

export function ChatDetailsPanel({
  id,
  about,
  members,
  pins,
  messageById,
  tab,
  onTabChange,
  onAddPeople,
  onJumpToMessage,
  onClose,
}: ChatDetailsPanelProps) {
  const tabs: readonly { readonly id: InfoTab; readonly label: string }[] = [
    { id: "about", label: "About" },
    { id: "members", label: `Members (${String(members.length)})` },
    { id: "pinned", label: `Pinned (${String(pins.length)})` },
  ];
  return (
    <aside id={id} className="chat-side-panel chat-details-panel" aria-labelledby={`${id}-title`}>
      <header className="chat-side-header">
        <h2 id={`${id}-title`} className="chat-side-title">
          Details
        </h2>
        <button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}>
          <XIcon size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="tabs chat-details-tabs" role="tablist" aria-label="Details">
        {tabs.map((item) => (
          <button
            key={item.id}
            id={`${id}-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`${id}-panel`}
            tabIndex={tab === item.id ? 0 : -1}
            className={`tab ${tab === item.id ? "active" : ""}`}
            onClick={() => onTabChange(item.id)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              const index = tabs.findIndex((candidate) => candidate.id === tab);
              const next =
                tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
              if (next === undefined) return;
              onTabChange(next.id);
              document.getElementById(`${id}-tab-${next.id}`)?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel`}
        className="chat-details-body"
        role="tabpanel"
        aria-labelledby={`${id}-tab-${tab}`}
      >
        {tab === "about" ? (
          <>
            <p className="chat-details-about">{about.description}</p>
            {about.createdBy.length > 0 ? (
              <p className="chat-details-meta">
                Created by {about.createdBy} · {about.createdAt}
              </p>
            ) : (
              <p className="chat-details-meta">Created {about.createdAt}</p>
            )}
          </>
        ) : null}

        {tab === "members" ? (
          <>
            {onAddPeople === undefined ? null : (
              <button type="button" className="btn sm chat-details-add" onClick={onAddPeople}>
                <AddPeopleIcon size={16} aria-hidden="true" />
                Add people
              </button>
            )}
            <ul className="chat-member-list" aria-label="Members">
              {members.map((member) => (
                <li key={member.actorId} className="chat-member">
                  <Avatar name={member.name} size={28} />
                  <span className="chat-member-text">
                    <span className="chat-member-name">{member.name}</span>
                    <span className="chat-member-role">
                      {member.role === "owner"
                        ? "Owner"
                        : member.role === "moderator"
                          ? "Manager"
                          : (member.email ?? "Member")}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {tab === "pinned" ? (
          pins.length === 0 ? (
            <p className="chat-details-meta">
              Nothing is pinned yet. Pin a message from its More menu.
            </p>
          ) : (
            <ul className="chat-pin-list" aria-label="Pinned messages">
              {pins.map((pin) => {
                const message = messageById(pin.messageId);
                return (
                  <li key={pin.messageId}>
                    <button
                      type="button"
                      className="chat-pin"
                      onClick={() => onJumpToMessage(pin.messageId)}
                    >
                      <PinIcon size={14} aria-hidden="true" />
                      <span className="chat-pin-text">
                        <span className="chat-pin-author">
                          {message?.authorName ?? "Pinned message"}
                        </span>
                        <span className="chat-pin-preview">
                          {message?.body ?? "Open to view this message."}
                        </span>
                      </span>
                      <time className="chat-pin-time" dateTime={pin.createdAt}>
                        {formatChatWhen(pin.createdAt)}
                      </time>
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </div>
    </aside>
  );
}
