import { Avatar } from "@/components/ui/avatar";
import { Pin as PinIcon, X as XIcon } from "lucide-react";
import { useState } from "react";
import { ChatComposer, type ChatComposerSubmission } from "./chat-composer";
import { ChatMessageBody } from "./chat-message-row";
import {
  formatChatTime,
  type ChatAboutView,
  type ChatMemberView,
  type ChatMessageView,
} from "./view-model";

export type InfoTab = "about" | "members" | "files" | "pinned";

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

export function ChatThreadPanel({
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
          <XIcon size={16} />
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

export function ChatInfoPanel({
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
        <XIcon size={16} />
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
                <PinIcon size={12} />
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
