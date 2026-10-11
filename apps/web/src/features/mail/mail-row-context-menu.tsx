/* Right-click menu for a conversation row (also Shift+F10 or the Menu key
   on the focused row). It acts on the selection when the row is part of it,
   otherwise on that row alone. */

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Archive,
  Clock,
  ExternalLink,
  Folder,
  Forward,
  Inbox,
  Mail,
  MailOpen,
  Reply,
  ReplyAll,
  Tag,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import type { MailFolderKey, MailLabelSummary, MailThreadRow } from "./api";
import type { MailAction } from "./mail-actions";
import {
  CONTEXT_PARTS,
  LabelMenuItems,
  MoveMenuItems,
  SnoozeMenuItems,
  type MoveTarget,
} from "./mail-menus";
import { useSnoozePresets } from "./mail-snooze-picker";
import type { ReplyMode } from "./mail-reply-panel";
import { followLink } from "./mail-view-helpers";

export interface RowMenuHandlers {
  readonly onAction: (ids: readonly string[], action: MailAction) => void;
  readonly onSnooze: (ids: readonly string[], until: string) => void;
  readonly onPickSnoozeDate: (ids: readonly string[]) => void;
  readonly onMove: (ids: readonly string[], target: MoveTarget) => void;
  readonly onReply: (threadId: string, mode: ReplyMode) => void;
}

interface MailRowContextMenuProps extends RowMenuHandlers {
  readonly children: ReactNode;
  readonly thread: MailThreadRow;
  /** The selected rows when this row is selected, else just this one. */
  readonly targets: () => readonly MailThreadRow[];
  readonly folder: MailFolderKey;
  readonly labels: readonly MailLabelSummary[];
}

export function MailRowContextMenu({
  children,
  thread,
  targets,
  folder,
  labels,
  onAction,
  onSnooze,
  onPickSnoozeDate,
  onMove,
  onReply,
}: MailRowContextMenuProps) {
  const { presets } = useSnoozePresets();
  const rows = () => targets();
  const ids = () => rows().map((row) => row.threadId);
  const anyUnread = () => rows().some((row) => row.unread);
  const restore: MailAction | null =
    folder === "trash"
      ? { kind: "restore" }
      : folder === "archive"
        ? { kind: "unarchive" }
        : folder === "spam"
          ? { kind: "notSpam" }
          : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {/* Portal content still bubbles React clicks to the row, which would open it. */}
      <ContextMenuContent
        aria-label={`Actions for ${thread.subject}`}
        onClick={(event) => event.stopPropagation()}
      >
        <ContextMenuItem icon={<Reply />} onSelect={() => onReply(thread.threadId, "reply")}>
          Reply
        </ContextMenuItem>
        <ContextMenuItem icon={<ReplyAll />} onSelect={() => onReply(thread.threadId, "replyAll")}>
          Reply all
        </ContextMenuItem>
        <ContextMenuItem icon={<Forward />} onSelect={() => onReply(thread.threadId, "forward")}>
          Forward
        </ContextMenuItem>
        <ContextMenuSeparator />
        {restore === null ? (
          <ContextMenuItem
            icon={<Archive />}
            shortcut="e"
            onSelect={() => onAction(ids(), { kind: "archive" })}
          >
            Archive
          </ContextMenuItem>
        ) : (
          <ContextMenuItem icon={<Inbox />} onSelect={() => onAction(ids(), restore)}>
            {folder === "spam" ? "Not spam" : "Move to Inbox"}
          </ContextMenuItem>
        )}
        {folder === "trash" ? null : (
          <ContextMenuItem
            icon={<Trash2 />}
            shortcut="#"
            onSelect={() => onAction(ids(), { kind: "trash" })}
          >
            Delete
          </ContextMenuItem>
        )}
        <ContextMenuItem
          icon={anyUnread() ? <MailOpen /> : <Mail />}
          onSelect={() => onAction(ids(), { kind: "read", unread: !anyUnread() })}
        >
          {anyUnread() ? "Mark as read" : "Mark as unread"}
        </ContextMenuItem>
        {folder === "trash" || folder === "spam" ? null : (
          <ContextMenuSub>
            <ContextMenuSubTrigger icon={<Clock />}>Snooze</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <SnoozeMenuItems
                parts={CONTEXT_PARTS}
                presets={presets}
                onSnooze={(until) => onSnooze(ids(), until)}
                onPickDate={() => onPickSnoozeDate(ids())}
              />
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger icon={<Folder />}>Move to</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <MoveMenuItems
              parts={CONTEXT_PARTS}
              folder={folder}
              labels={labels}
              onMove={(target) => onMove(ids(), target)}
            />
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger icon={<Tag />}>Label as</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <LabelMenuItems
              parts={CONTEXT_PARTS}
              labels={labels}
              applied={(slug) => appliedState(rows(), slug)}
              onToggle={(slug, add) =>
                onAction(ids(), {
                  kind: "label",
                  add: add ? [slug] : [],
                  remove: add ? [] : [slug],
                })
              }
            />
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={<ExternalLink />}
          onSelect={() => followLink(`/mail?thread=${encodeURIComponent(thread.threadId)}`)}
        >
          Open in new window
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Checked when every target has the label, mixed when some do. */
export function appliedState(
  rows: readonly MailThreadRow[],
  slug: string,
): boolean | "indeterminate" {
  const count = rows.filter((row) => row.labels.includes(slug)).length;
  if (count === 0) return false;
  return count === rows.length ? true : "indeterminate";
}
