import { Avatar } from "@/components/ui/avatar";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Check as CheckIcon,
  MessageSquare as CommentIcon,
  Pencil as EditPenIcon,
  Pin as PinIcon,
  Smile as SmileIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
import { useState } from "react";
import { ChatAttachmentGallery, ChatMessageContent } from "./message-content";
import { type ChatMessageView } from "./view-model";

const QUICK_REACTIONS = ["👍", "🎉", "🙏", "👀", "✅"] as const;

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

export function ChatMessageRow({
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
              <SmileIcon size={12} />
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
            <CheckIcon size={11} />
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
            <SmileIcon size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Reply in thread" side="bottom">
          <button
            type="button"
            className="icon-btn"
            aria-label="Reply in thread"
            onClick={onOpenThread}
          >
            <CommentIcon size={14} />
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
            <PinIcon size={14} />
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
                <EditPenIcon size={14} />
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
                <TrashIcon size={14} />
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

export function ChatTypingIndicator({ names }: { readonly names: readonly string[] }) {
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

export function ChatMessageBody(input: {
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
