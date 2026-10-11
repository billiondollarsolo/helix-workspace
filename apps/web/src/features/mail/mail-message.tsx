/* One message in a conversation. Collapsed, it is a single line (sender,
   snippet, date) that expands on click. Expanded, the header shows the
   sender with a contact card, "to me, Samara", the full date with a
   relative time, the conversation star, Reply and a ⋮ menu. */

import { PersonHovercard } from "@/components/people/person-hovercard";
import { Avatar } from "@/components/ui/avatar";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { externalPersonRef } from "@/features/people/person-ref";
import { apiPath } from "@/lib/auth";
import {
  FileCode,
  Filter,
  Forward,
  MailMinus,
  MoreVertical,
  Printer,
  Reply,
  Star,
} from "lucide-react";
import type { MailThreadMessage } from "./api";
import { MailAttachments } from "./mail-attachments";
import { MailHtmlBody } from "./mail-html-body";
import { TriggerButton } from "./mail-menus";
import { messagePlainText, printMessages } from "./mail-print";
import { openFilterDialog } from "./settings";
import type { ReplyMode } from "./mail-reply-panel";
import {
  followLink,
  formatFullDate,
  formatRelativeTime,
  formatThreadTime,
} from "./mail-view-helpers";

export interface MessageHandlers {
  readonly onReply: (mode: ReplyMode, message: MailThreadMessage) => void;
  readonly onMarkUnreadFromHere: () => void;
}

interface MailMessageProps extends MessageHandlers {
  readonly message: MailThreadMessage;
  readonly subject: string;
  readonly expanded: boolean;
  readonly onExpand: () => void;
  readonly starred: boolean;
  readonly onToggleStar: () => void;
  /** The signed-in person's address, shown as "me". */
  readonly myAddress: string | null;
}

function senderOf(message: MailThreadMessage) {
  const address = message.from?.address ?? "";
  const name = message.from?.name ?? address;
  return { name: name || "Unknown sender", address };
}

/** "to me, Samara" — first names, "me" for the reader. */
export function recipientsLine(message: MailThreadMessage, myAddress: string | null): string {
  const mine = myAddress?.toLowerCase() ?? null;
  const names = [...message.to, ...message.cc].map((recipient) =>
    recipient.address.toLowerCase() === mine
      ? "me"
      : (recipient.name?.trim().split(/\s+/u)[0] ?? recipient.address),
  );
  return `to ${names.length === 0 ? "undisclosed recipients" : [...new Set(names)].join(", ")}`;
}

function snippetOf(message: MailThreadMessage): string {
  return messagePlainText(message).replace(/\s+/gu, " ").slice(0, 160);
}

export function MailMessage({
  message,
  subject,
  expanded,
  onExpand,
  starred,
  onToggleStar,
  myAddress,
  onReply,
  onMarkUnreadFromHere,
}: MailMessageProps) {
  const sender = senderOf(message);

  if (!expanded) {
    return (
      <button
        type="button"
        className="mail-message-collapsed focus-ring"
        aria-expanded={false}
        onClick={onExpand}
      >
        <Avatar name={sender.name} size={28} />
        <span className="mail-message-collapsed-sender">{sender.name}</span>
        <span className="mail-message-collapsed-snippet">{snippetOf(message)}</span>
        <time className="mail-message-collapsed-date" dateTime={message.sentAt}>
          {formatThreadTime(message.sentAt)}
        </time>
      </button>
    );
  }

  const relative = formatRelativeTime(message.sentAt);
  return (
    <article className="mail-message" aria-label={`Message from ${sender.name}`}>
      <header className="mail-message-head">
        <Avatar name={sender.name} size={36} />
        <div className="mail-message-who">
          <div className="mail-message-from">
            <PersonHovercard person={externalPersonRef(`${sender.name} <${sender.address}>`)}>
              {(trigger) => (
                <button type="button" className="mail-message-sender focus-ring" {...trigger}>
                  {sender.name}
                </button>
              )}
            </PersonHovercard>
            {sender.address === "" ? null : (
              <span className="mail-message-address">&lt;{sender.address}&gt;</span>
            )}
          </div>
          <div className="mail-message-to">{recipientsLine(message, myAddress)}</div>
        </div>
        <time className="mail-message-when" dateTime={message.sentAt}>
          {formatFullDate(message.sentAt)}
          {relative === "" ? null : ` (${relative})`}
        </time>
        <div className="mail-message-actions">
          <button
            type="button"
            className="mail-tool focus-ring"
            aria-label="Star"
            aria-pressed={starred}
            title={starred ? "Starred" : "Not starred"}
            onClick={onToggleStar}
          >
            <Star
              aria-hidden="true"
              className={starred ? "text-[var(--star)]" : undefined}
              fill={starred ? "currentColor" : "none"}
            />
          </button>
          <button
            type="button"
            className="mail-tool focus-ring"
            aria-label="Reply"
            title="Reply"
            onClick={() => onReply("reply", message)}
          >
            <Reply aria-hidden="true" />
          </button>
          <Menu>
            <MenuTrigger asChild>
              <TriggerButton
                className="mail-tool focus-ring"
                aria-label="More message actions"
                title="More"
              >
                <MoreVertical aria-hidden="true" />
              </TriggerButton>
            </MenuTrigger>
            <MenuContent align="end" aria-label="Message actions">
              <MenuItem icon={<Reply />} onSelect={() => onReply("reply", message)}>
                Reply
              </MenuItem>
              <MenuItem icon={<Forward />} onSelect={() => onReply("forward", message)}>
                Forward
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<Filter />}
                onSelect={() => openFilterDialog({ from: message.from?.address ?? "" })}
              >
                Filter messages like this
              </MenuItem>
              <MenuItem icon={<Printer />} onSelect={() => printMessages(subject, [message])}>
                Print
              </MenuItem>
              <MenuItem
                icon={<FileCode />}
                onSelect={() =>
                  followLink(
                    apiPath(`/api/mail/messages/${encodeURIComponent(message.id)}/source`),
                    { download: `${message.id}.eml` },
                  )
                }
              >
                Show original
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<MailMinus />} onSelect={onMarkUnreadFromHere}>
                Mark unread from here
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </header>
      <div className="mail-message-body">
        {message.bodyFormat === "html" && message.source !== undefined ? (
          <MailHtmlBody
            html={message.body}
            source={message.source}
            plainBody={message.plainBody}
            remoteContentBlocked={message.remoteContentBlocked ?? false}
          />
        ) : (
          <div className="whitespace-pre-wrap type-body [overflow-wrap:anywhere]">
            {message.body}
          </div>
        )}
        <MailAttachments attachments={message.attachments} />
      </div>
    </article>
  );
}
