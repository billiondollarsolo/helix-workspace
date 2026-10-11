/* One conversation in the list: the content cell of a SelectableList row.
   Desktop reads "★ Samara, me (3)  [Label] Subject — snippet   📎 Mar 4" with
   archive/delete/read/snooze buttons over the date on hover or focus. Under
   640px it stacks sender + date, subject and snippet, with the star and the
   attachment icon on the right. The row itself is the keyboard focus target;
   these buttons take `tabIndex` from the row state. */

import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { Archive, Clock, Inbox, MailOpen, Mail, Paperclip, Star, Trash2 } from "lucide-react";
import type { ComponentProps, DragEvent } from "react";
import type { MailFolderKey, MailLabelSummary, MailThreadRow } from "./api";
import type { MailAction } from "./mail-actions";
import { MailSnoozePopover } from "./mail-snooze-picker";
import {
  formatThreadTime,
  labelChipStyle,
  participantsLabel,
  restoreActionLabel,
} from "./mail-view-helpers";

/** Drag payload type for conversations dropped on sidebar folders and labels. */
export const MAIL_DRAG_TYPE = "application/x-helix-mail-threads";

interface ThreadRowHandlers {
  readonly onAction: (ids: readonly string[], action: MailAction) => void;
  readonly onSnooze: (ids: readonly string[], until: string) => void;
}

interface ThreadRowProps extends ThreadRowHandlers, Omit<ComponentProps<"div">, "onDragStart"> {
  readonly thread: MailThreadRow;
  readonly folder: MailFolderKey;
  readonly labelsBySlug: ReadonlyMap<string, MailLabelSummary>;
  /** The label view on screen; its own chip is left off the rows. */
  readonly activeLabel: string | null;
  readonly showAvatar: boolean;
  readonly tabIndex: 0 | -1;
  /** Ids a drag from this row carries: the selection if the row is in it. */
  readonly dragIds: () => readonly string[];
}

/** A hover action; spreads extra props so it can be a popover trigger. */
function RowButton({ label, ...props }: ComponentProps<"button"> & { readonly label: string }) {
  return (
    <button
      type="button"
      className="mail-row-action focus-ring"
      aria-label={label}
      title={label}
      {...props}
    />
  );
}

export function ThreadRow({
  thread,
  folder,
  labelsBySlug,
  activeLabel,
  showAvatar,
  tabIndex,
  dragIds,
  onAction,
  onSnooze,
  ...rest
}: ThreadRowProps) {
  const ids = [thread.threadId];
  const draft = folder === "drafts";
  const sender = participantsLabel(thread);
  const labels = thread.labels
    .filter((slug) => slug !== activeLabel)
    .map((slug) => labelsBySlug.get(slug))
    .filter((label): label is MailLabelSummary => label !== undefined);
  const restoreLabel = restoreActionLabel(folder);
  const time = formatThreadTime(thread.time);

  return (
    <div
      {...rest}
      className="mail-row"
      data-thread-id={thread.threadId}
      data-unread={thread.unread || undefined}
      data-avatar={showAvatar || undefined}
      draggable
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(MAIL_DRAG_TYPE, JSON.stringify(dragIds()));
        event.dataTransfer.setData("text/plain", thread.subject);
      }}
    >
      {showAvatar ? (
        <span className="mail-row-avatar" aria-hidden="true">
          <Avatar
            name={thread.participants.find((person) => !person.isMe)?.name || thread.from}
            size={24}
          />
        </span>
      ) : null}
      <button
        type="button"
        className={cn("mail-row-star focus-ring", thread.starred && "is-starred")}
        aria-label="Star"
        aria-pressed={thread.starred}
        tabIndex={tabIndex}
        onClick={() => onAction(ids, { kind: "star", starred: !thread.starred })}
      >
        <Star aria-hidden="true" fill={thread.starred ? "currentColor" : "none"} />
      </button>
      <span className="mail-row-sender">
        {draft ? <span className="mail-row-draft">Draft</span> : null}
        {draft && sender !== "" ? " " : null}
        <span>{sender}</span>
      </span>
      <span className="mail-row-text">
        {labels.map((label) => (
          <span key={label.id} className="mail-row-label" style={labelChipStyle(label)}>
            {label.name}
          </span>
        ))}
        <span className="mail-row-subject">{thread.subject || "(no subject)"}</span>
        {thread.preview === "" ? null : (
          <span className="mail-row-snippet">
            <span className="mail-row-dash" aria-hidden="true">
              {" — "}
            </span>
            {thread.preview}
          </span>
        )}
      </span>
      <span className="mail-row-meta">
        {thread.hasAttachment ? (
          <Paperclip className="mail-row-clip" aria-label="Has attachment" role="img" />
        ) : null}
        <time className="mail-row-date" dateTime={thread.time}>
          {time}
        </time>
      </span>
      {/* Clicks in the snooze popover (a portal) still bubble through React to the row: stop them here. */}
      <span
        className="mail-row-actions"
        role="group"
        aria-label={`Actions for ${thread.subject}`}
        onClick={(event) => event.stopPropagation()}
      >
        {restoreLabel !== null ? (
          <RowButton
            label={restoreLabel}
            tabIndex={tabIndex}
            onClick={() =>
              onAction(ids, {
                kind:
                  folder === "trash" ? "restore" : folder === "snoozed" ? "unsnooze" : "unarchive",
              })
            }
          >
            <Inbox aria-hidden="true" />
          </RowButton>
        ) : folder === "spam" ? (
          <RowButton
            label="Not spam"
            tabIndex={tabIndex}
            onClick={() => onAction(ids, { kind: "notSpam" })}
          >
            <Inbox aria-hidden="true" />
          </RowButton>
        ) : (
          <RowButton
            label="Archive"
            tabIndex={tabIndex}
            onClick={() => onAction(ids, { kind: "archive" })}
          >
            <Archive aria-hidden="true" />
          </RowButton>
        )}
        {folder === "trash" ? null : (
          <RowButton
            label="Delete"
            tabIndex={tabIndex}
            onClick={() => onAction(ids, { kind: "trash" })}
          >
            <Trash2 aria-hidden="true" />
          </RowButton>
        )}
        <RowButton
          label={thread.unread ? "Mark as read" : "Mark as unread"}
          tabIndex={tabIndex}
          onClick={() => onAction(ids, { kind: "read", unread: !thread.unread })}
        >
          {thread.unread ? <MailOpen aria-hidden="true" /> : <Mail aria-hidden="true" />}
        </RowButton>
        {folder === "snoozed" || folder === "trash" || folder === "spam" ? null : (
          <MailSnoozePopover align="end" onSnooze={(until) => onSnooze(ids, until)}>
            <RowButton label="Snooze" tabIndex={tabIndex}>
              <Clock aria-hidden="true" />
            </RowButton>
          </MailSnoozePopover>
        )}
      </span>
    </div>
  );
}
