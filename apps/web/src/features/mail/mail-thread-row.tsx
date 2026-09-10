import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  Archive as ArchiveIcon,
  Eye as EyeIcon,
  Inbox as InboxIcon,
  Mail as MailIcon,
  Paperclip as PaperclipIcon,
  Clock as SnoozeIcon,
  Star as StarIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
import { type MailLabelSummary, type MailThreadRow } from "./api";
import { formatThreadTime } from "./mail-view-helpers";

/* --------------------------------------------------------------- thread row */

interface ThreadRowProps {
  readonly thread: MailThreadRow;
  readonly checked: boolean;
  readonly selected: boolean;
  readonly labelColors: ReadonlyMap<string, MailLabelSummary>;
  readonly onClick: () => void;
  readonly onToggleStar: () => void;
  readonly onToggleCheck: (event: React.MouseEvent) => void;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
  readonly onSnooze: () => void;
  readonly restoreLabel: string | null;
  readonly onRestore: () => void;
  readonly onToggleRead: () => void;
  readonly busy: boolean;
}

export function ThreadRow({
  thread,
  checked,
  selected,
  labelColors,
  onClick,
  onToggleStar,
  onToggleCheck,
  onArchive,
  onDelete,
  onSnooze,
  restoreLabel,
  onRestore,
  onToggleRead,
  busy,
}: ThreadRowProps) {
  const labels = thread.labels
    .map((slug) => labelColors.get(slug))
    .filter((label): label is MailLabelSummary => label != null);

  return (
    <div
      className={cn(
        "mail-thread-row render-contained-list-item",
        "grid [grid-template-columns:20px_20px_24px_minmax(0,_200px)_minmax(0,_1fr)_auto] items-center gap-x-3 [padding:var(--rd-row-py)_16px] [border-bottom:1px_solid_var(--border)] cursor-pointer [transition:background_0.08s] [font-size:var(--rd-row-fs)] [min-height:var(--rd-list-row-h)]",
        checked || selected ? "[background:var(--accent-soft)]" : "bg-transparent",
      )}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}

      onMouseEnter={(event) => {
        if (!checked && !selected) {
          event.currentTarget.style.background = "var(--hover)";
        }
      }}
      onMouseLeave={(event) => {
        if (!checked && !selected) {
          event.currentTarget.style.background = "transparent";
        }
      }}
    >
      <input
        type="checkbox"
        aria-label={`Select ${thread.subject}`}
        checked={checked}
        onChange={() => undefined}
        onClick={(event) => {
          event.stopPropagation();
          onToggleCheck(event);
        }}
        className="[accent-color:var(--accent)] m-0"
      />
      <button
        type="button"
        aria-label={thread.starred ? "Unstar" : "Star"}
        aria-pressed={thread.starred}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          onToggleStar();
        }}
        className={cn(
          "w-4.5 h-4.5 grid [place-items:center]",
          thread.starred ? "[color:#f59e0b]" : "text-muted-foreground",
        )}
      >
        <StarIcon size={16} />
      </button>
      <Avatar name={thread.from.split(",")[0] ?? thread.from} size={22} />
      <span
        className={cn(
          "truncate",
          thread.unread ? "font-semibold" : "font-medium",
          thread.unread ? "text-foreground" : "[color:var(--text-2)]",
        )}
      >
        {thread.from}
        {thread.messageCount > 1 && (
          <span className="text-muted-foreground font-normal"> ({thread.messageCount})</span>
        )}
      </span>
      <div className="flex items-center gap-2 min-w-0">
        {labels.map((label) => (
          <span
            key={label.id}
            className="[font-size:var(--text-chip)] [padding:0_5px] h-4 [line-height:16px] [border-radius:3px] font-medium shrink-0"
            style={{ background: `${label.color}1f`, color: label.color }}
          >
            {label.name}
          </span>
        ))}
        <span className="truncate min-w-0">
          <span
            className={cn(
              thread.unread ? "font-semibold" : "font-medium",
              thread.unread ? "text-foreground" : "[color:var(--text-2)]",
            )}
          >
            {thread.subject}
          </span>
          <span className="text-muted-foreground font-normal"> — {thread.preview}</span>
        </span>
      </div>
      {/* Date + inline hover actions cell */}
      <div className="mail-thread-row-meta">
        <span
          className={cn(
            "mail-thread-row-date",
            "[font-size:var(--text-caption)] flex items-center gap-1.5",
            thread.unread ? "font-semibold" : "font-normal",
            thread.unread ? "[color:var(--text-2)]" : "text-muted-foreground",
          )}
        >
          {thread.hasAttachment && <PaperclipIcon size={16} />}
          <span>{formatThreadTime(thread.time)}</span>
        </span>
        {/* Hover action strip — visible on :hover / :focus-within via CSS */}
        <div
          className="mail-thread-row-actions"
          role="toolbar"
          aria-label={`Actions for ${thread.subject}`}
        >
          {restoreLabel !== null && (
            <button
              type="button"
              className="mail-row-action-btn"
              aria-label={restoreLabel}
              title={restoreLabel}
              tabIndex={0}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onRestore();
              }}
            >
              <InboxIcon size={16} />
            </button>
          )}
          <button
            type="button"
            className="mail-row-action-btn"
            aria-label="Archive"
            title="Archive"
            tabIndex={0}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onArchive();
            }}
          >
            <ArchiveIcon size={16} />
          </button>
          <button
            type="button"
            className="mail-row-action-btn"
            aria-label="Delete"
            title="Delete"
            tabIndex={0}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            <TrashIcon size={16} />
          </button>
          <button
            type="button"
            className="mail-row-action-btn"
            aria-label={thread.unread ? "Mark read" : "Mark unread"}
            title={thread.unread ? "Mark read" : "Mark unread"}
            tabIndex={0}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onToggleRead();
            }}
          >
            {thread.unread ? <EyeIcon size={16} /> : <MailIcon size={16} />}
          </button>
          <button
            type="button"
            className="mail-row-action-btn"
            aria-label="Snooze"
            title="Snooze"
            tabIndex={0}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onSnooze();
            }}
          >
            <SnoozeIcon size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
