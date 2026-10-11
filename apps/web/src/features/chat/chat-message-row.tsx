/* One message in a conversation or thread. A message that continues the
   same sender's run (see `timeline.ts`) drops the avatar and name and shows
   its time on hover. Hover or focus reveals the action bar: React, Reply in
   thread, Forward to inbox, and More (copy link, pin, edit, delete). */

import { Dialog } from "@/components/ui/helix-dialog";
import { Avatar } from "@/components/ui/avatar";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Link as LinkIcon,
  Mail as MailIcon,
  MessageSquareText as ThreadIcon,
  MoreVertical as MoreIcon,
  Pencil as EditIcon,
  Pin as PinIcon,
  PinOff as UnpinIcon,
  SmilePlus as ReactIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { QUICK_REACTIONS } from "./emoji-data";
import { EmojiPicker } from "./emoji-picker";
import { ChatAttachmentGallery, ChatMessageContent } from "./message-content";
import { TriggerButton } from "./trigger-button";
import { formatChatWhen, type ChatMessageView } from "./view-model";

/** What a person can do to a message. Omit a handler to hide its control. */
export interface ChatMessageActions {
  readonly onReact: (messageId: string, emoji: string) => void;
  readonly onOpenThread?: ((messageId: string) => void) | undefined;
  readonly onForward: (message: ChatMessageView) => void;
  readonly onCopyLink: (message: ChatMessageView) => void;
  readonly onTogglePin?: ((message: ChatMessageView) => void) | undefined;
  readonly onEdit: (messageId: string, body: string) => void;
  readonly onDelete: (messageId: string) => void;
  readonly onRetryPending: (clientMessageId: string) => void;
}

interface ChatMessageRowProps {
  readonly message: ChatMessageView;
  readonly grouped: boolean;
  readonly actions: ChatMessageActions;
  readonly highlighted?: boolean;
  readonly isActiveThread?: boolean;
}

export function ChatMessageRow({
  message,
  grouped,
  actions,
  highlighted = false,
  isActiveThread = false,
}: ChatMessageRowProps) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menusOpen, setMenusOpen] = useState(0);
  // Edit and Delete move focus (to the editor or a dialog); keep the menu from taking it back.
  const keepFocusRef = useRef(false);
  const trackOpen = (open: boolean) =>
    setMenusOpen((count) => Math.max(0, count + (open ? 1 : -1)));
  const settled = message.pending !== true && message.failed !== true;

  return (
    <article
      className="chat-msg"
      id={`chat-message-${message.id}`}
      data-message-id={message.id}
      data-grouped={grouped}
      data-mine={message.isMine}
      data-highlighted={highlighted}
      data-active-thread={isActiveThread}
      data-pending={message.pending === true}
      data-failed={message.failed === true}
      data-actions-open={menusOpen > 0}
    >
      <div className="chat-msg-gutter">
        {grouped ? (
          <time className="chat-msg-hover-time" dateTime={message.sentAt}>
            {message.time}
          </time>
        ) : (
          <Avatar name={message.authorName} size={32} />
        )}
      </div>
      <div className="chat-msg-main">
        {grouped ? (
          <span className="sr-only">
            {message.authorName}, {message.time}
          </span>
        ) : (
          <div className="chat-msg-head">
            <span className="chat-msg-author">{message.authorName}</span>
            <time className="chat-msg-time" dateTime={message.sentAt}>
              {message.time}
            </time>
          </div>
        )}
        {message.pinned ? (
          <span className="chat-msg-flag">
            <PinIcon size={12} aria-hidden="true" /> Pinned
          </span>
        ) : null}

        {editing ? (
          <MessageEditor
            initial={message.body}
            onCancel={() => setEditing(false)}
            onSave={(body) => {
              actions.onEdit(message.id, body);
              setEditing(false);
            }}
          />
        ) : (
          <ChatMessageBody className="chat-msg-line" message={message} />
        )}
        {message.editedAt !== null ? <span className="chat-msg-edited">(edited)</span> : null}
        {message.pending === true ? <span className="chat-msg-pending">Sending…</span> : null}
        {message.failed === true ? (
          <button
            type="button"
            className="chat-msg-failed"
            onClick={() => {
              if (message.clientMessageId !== undefined) {
                actions.onRetryPending(message.clientMessageId);
              }
            }}
          >
            Not sent. Retry
          </button>
        ) : null}

        {message.reactions.length > 0 ? (
          <div className="chat-reactions">
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                className="chat-reaction"
                data-mine={reaction.mine}
                aria-pressed={reaction.mine}
                aria-label={`${reaction.emoji} ${String(reaction.count)} reactions`}
                onClick={() => actions.onReact(message.id, reaction.emoji)}
              >
                <span aria-hidden="true">{reaction.emoji}</span>
                <span className="chat-reaction-count">{reaction.count}</span>
              </button>
            ))}
            <ReactionPopover
              label="Add reaction"
              onOpenChange={trackOpen}
              onPick={(emoji) => actions.onReact(message.id, emoji)}
            >
              <TriggerButton className="chat-reaction chat-reaction-add" aria-label="Add reaction">
                <ReactIcon size={14} aria-hidden="true" />
              </TriggerButton>
            </ReactionPopover>
          </div>
        ) : null}

        {message.replyCount > 0 && actions.onOpenThread !== undefined ? (
          <button
            type="button"
            className="chat-thread-link"
            onClick={() => actions.onOpenThread?.(message.id)}
          >
            <ThreadIcon size={14} aria-hidden="true" />
            {message.replyCount === 1 ? "1 reply" : `${String(message.replyCount)} replies`}
            {message.lastReplyAt === null ? null : (
              <span className="chat-thread-last">· {formatChatWhen(message.lastReplyAt)}</span>
            )}
          </button>
        ) : null}
      </div>

      {settled && !editing ? (
        <div className="chat-msg-actions" role="toolbar" aria-label="Message actions">
          <ReactionPopover
            label="React"
            onOpenChange={trackOpen}
            onPick={(emoji) => actions.onReact(message.id, emoji)}
          >
            <TriggerButton className="icon-btn" aria-label="React" title="React">
              <ReactIcon size={16} aria-hidden="true" />
            </TriggerButton>
          </ReactionPopover>
          {actions.onOpenThread === undefined ? null : (
            <ActionButton
              label="Reply in thread"
              onClick={() => actions.onOpenThread?.(message.id)}
            >
              <ThreadIcon size={16} aria-hidden="true" />
            </ActionButton>
          )}
          <ActionButton label="Forward to inbox" onClick={() => actions.onForward(message)}>
            <MailIcon size={16} aria-hidden="true" />
          </ActionButton>
          <Menu modal={false} onOpenChange={trackOpen}>
            <MenuTrigger asChild>
              <TriggerButton className="icon-btn" aria-label="More message actions" title="More">
                <MoreIcon size={16} aria-hidden="true" />
              </TriggerButton>
            </MenuTrigger>
            <MenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                if (keepFocusRef.current) {
                  keepFocusRef.current = false;
                  event.preventDefault();
                }
              }}
            >
              <MenuItem icon={<LinkIcon />} onSelect={() => actions.onCopyLink(message)}>
                Copy link
              </MenuItem>
              {actions.onTogglePin === undefined ? null : (
                <MenuItem
                  icon={message.pinned ? <UnpinIcon /> : <PinIcon />}
                  onSelect={() => actions.onTogglePin?.(message)}
                >
                  {message.pinned ? "Unpin" : "Pin"}
                </MenuItem>
              )}
              {message.isMine ? (
                <>
                  <MenuSeparator />
                  <MenuItem
                    icon={<EditIcon />}
                    onSelect={() => {
                      keepFocusRef.current = true;
                      setEditing(true);
                    }}
                  >
                    Edit
                  </MenuItem>
                  <MenuItem
                    icon={<TrashIcon />}
                    destructive
                    onSelect={() => {
                      keepFocusRef.current = true;
                      setConfirmDelete(true);
                    }}
                  >
                    Delete
                  </MenuItem>
                </>
              ) : null}
            </MenuContent>
          </Menu>
        </div>
      ) : null}

      {confirmDelete ? (
        <Dialog
          title="Delete this message?"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  setConfirmDelete(false);
                  actions.onDelete(message.id);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p className="type-body-sm">It will be removed for everyone in the conversation.</p>
        </Dialog>
      ) : null}
    </article>
  );
}

function ActionButton({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

/** Quick reactions plus the full emoji picker. */
function ReactionPopover({
  label,
  onPick,
  onOpenChange,
  children,
}: {
  readonly label: string;
  readonly onPick: (emoji: string) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pick = (emoji: string) => {
    onPick(emoji);
    setOpen(false);
    onOpenChange(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent aria-label={label} className="chat-reaction-popover" align="end">
        <div className="chat-quick-reactions" role="group" aria-label="Quick reactions">
          {QUICK_REACTIONS.map((entry) => (
            <button
              key={entry.emoji}
              type="button"
              className="chat-emoji-option"
              aria-label={entry.name}
              onClick={() => pick(entry.emoji)}
            >
              <span aria-hidden="true">{entry.emoji}</span>
            </button>
          ))}
        </div>
        <EmojiPicker label="All emoji" onSelect={pick} />
      </PopoverContent>
    </Popover>
  );
}

function MessageEditor({
  initial,
  onCancel,
  onSave,
}: {
  readonly initial: string;
  readonly onCancel: () => void;
  readonly onSave: (body: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const save = () => {
    if (draft.trim().length > 0) onSave(draft.trim());
  };
  return (
    <div className="chat-msg-edit">
      <textarea
        className="chat-msg-edit-input"
        rows={2}
        aria-label="Edit message"
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            save();
          }
        }}
      />
      <div className="chat-msg-edit-actions">
        <button type="button" className="btn sm" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary sm"
          disabled={draft.trim().length === 0}
          onClick={save}
        >
          Save
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Typing indicator — driven by realtime `typing` events
   ---------------------------------------------------------------- */

export function ChatTypingIndicator({ names }: { readonly names: readonly string[] }) {
  const label =
    names.length === 0
      ? ""
      : names.length === 1
        ? `${names[0] ?? ""} is typing…`
        : names.length === 2
          ? `${names[0] ?? ""} and ${names[1] ?? ""} are typing…`
          : `${String(names.length)} people are typing…`;

  return (
    <div className="chat-typing" aria-live="polite">
      {names.length === 0 ? null : (
        <>
          <span className="chat-typing-dots" aria-hidden="true">
            <span className="chat-typing-dot" />
            <span className="chat-typing-dot" />
            <span className="chat-typing-dot" />
          </span>
          <span>{label}</span>
        </>
      )}
    </div>
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
