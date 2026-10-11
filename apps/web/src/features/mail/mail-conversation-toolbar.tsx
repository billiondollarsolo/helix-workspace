/* Toolbar over an open conversation: Back, Archive, Report spam, Delete |
   Mark as unread, Snooze, Move to, Labels, ⋮ — and "3 of 76 ‹ ›" on the
   right. On narrow screens the strip scrolls sideways. */

import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import {
  Archive,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  Folder,
  Inbox,
  Mail,
  MoreVertical,
  OctagonAlert,
  Printer,
  Star,
  StarOff,
  Tag,
  Trash2,
} from "lucide-react";
import type { MailFolderKey, MailLabelSummary, MailThreadRow } from "./api";
import type { MailAction } from "./mail-actions";
import { ToolbarButton } from "./mail-list-toolbar";
import { DROPDOWN_PARTS, LabelMenuItems, MoveMenuItems, type MoveTarget } from "./mail-menus";
import { appliedState } from "./mail-row-context-menu";
import { MailSnoozePopover } from "./mail-snooze-picker";
import { openFilterDialog } from "./settings";

const COUNT = new Intl.NumberFormat();

export interface ConversationPosition {
  /** One-based position in the list. */
  readonly index: number;
  readonly total: number;
  readonly onNewer?: (() => void) | undefined;
  readonly onOlder?: (() => void) | undefined;
}

interface ConversationToolbarProps {
  readonly row: MailThreadRow;
  readonly folder: MailFolderKey;
  readonly labels: readonly MailLabelSummary[];
  readonly position: ConversationPosition | null;
  readonly onBack: () => void;
  readonly onAction: (action: MailAction) => void;
  readonly onMarkUnread: () => void;
  readonly onSnooze: (until: string) => void;
  readonly onMove: (target: MoveTarget) => void;
  readonly onPrint: () => void;
}

export function ConversationToolbar({
  row,
  folder,
  labels,
  position,
  onBack,
  onAction,
  onMarkUnread,
  onSnooze,
  onMove,
  onPrint,
}: ConversationToolbarProps) {
  const restore: MailAction | null =
    folder === "trash"
      ? { kind: "restore" }
      : folder === "archive"
        ? { kind: "unarchive" }
        : folder === "snoozed"
          ? { kind: "unsnooze" }
          : null;

  return (
    <div
      className="mail-toolbar mail-conversation-toolbar"
      role="toolbar"
      aria-label="Conversation actions"
    >
      <div className="mail-toolbar-group">
        <ToolbarButton label="Back to list" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </ToolbarButton>
        {restore !== null ? (
          <ToolbarButton
            label={folder === "snoozed" ? "Unsnooze" : "Move to Inbox"}
            onClick={() => onAction(restore)}
          >
            <Inbox aria-hidden="true" />
          </ToolbarButton>
        ) : folder === "spam" ? null : (
          <ToolbarButton label="Archive" onClick={() => onAction({ kind: "archive" })}>
            <Archive aria-hidden="true" />
          </ToolbarButton>
        )}
        {folder === "spam" ? (
          <ToolbarButton label="Not spam" showLabel onClick={() => onAction({ kind: "notSpam" })}>
            <Inbox aria-hidden="true" />
          </ToolbarButton>
        ) : (
          <ToolbarButton label="Report spam" onClick={() => onAction({ kind: "spam" })}>
            <OctagonAlert aria-hidden="true" />
          </ToolbarButton>
        )}
        {folder === "trash" ? null : (
          <ToolbarButton label="Delete" onClick={() => onAction({ kind: "trash" })}>
            <Trash2 aria-hidden="true" />
          </ToolbarButton>
        )}
        <span className="mail-toolbar-divider" aria-hidden="true" />
        <ToolbarButton label="Mark as unread" onClick={onMarkUnread}>
          <Mail aria-hidden="true" />
        </ToolbarButton>
        {folder === "trash" || folder === "spam" ? null : (
          <MailSnoozePopover onSnooze={onSnooze}>
            <ToolbarButton label="Snooze">
              <Clock aria-hidden="true" />
            </ToolbarButton>
          </MailSnoozePopover>
        )}
        <Menu>
          <MenuTrigger asChild>
            <ToolbarButton label="Move to">
              <Folder aria-hidden="true" />
            </ToolbarButton>
          </MenuTrigger>
          <MenuContent aria-label="Move to">
            <MoveMenuItems parts={DROPDOWN_PARTS} folder={folder} labels={labels} onMove={onMove} />
          </MenuContent>
        </Menu>
        <Menu>
          <MenuTrigger asChild>
            <ToolbarButton label="Labels">
              <Tag aria-hidden="true" />
            </ToolbarButton>
          </MenuTrigger>
          <MenuContent aria-label="Label as">
            <LabelMenuItems
              parts={DROPDOWN_PARTS}
              labels={labels}
              applied={(slug) => appliedState([row], slug)}
              onToggle={(slug, add) =>
                onAction({ kind: "label", add: add ? [slug] : [], remove: add ? [] : [slug] })
              }
            />
          </MenuContent>
        </Menu>
        <Menu>
          <MenuTrigger asChild>
            <ToolbarButton label="More actions">
              <MoreVertical aria-hidden="true" />
            </ToolbarButton>
          </MenuTrigger>
          <MenuContent aria-label="More actions">
            <MenuItem
              icon={row.starred ? <StarOff /> : <Star />}
              onSelect={() => onAction({ kind: "star", starred: !row.starred })}
            >
              {row.starred ? "Remove star" : "Add star"}
            </MenuItem>
            <MenuItem icon={<Filter />} onSelect={() => openFilterDialog({ from: row.fromEmail })}>
              Filter messages like these
            </MenuItem>
            <MenuItem icon={<Printer />} onSelect={onPrint}>
              Print all
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {position === null ? null : (
        <nav className="mail-conversation-pager" aria-label="Conversation navigation">
          <span className="tabular-nums">
            {COUNT.format(position.index)} of {COUNT.format(position.total)}
          </span>
          <ToolbarButton
            label="Newer"
            disabled={position.onNewer === undefined}
            onClick={position.onNewer}
          >
            <ChevronLeft aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton
            label="Older"
            disabled={position.onOlder === undefined}
            onClick={position.onOlder}
          >
            <ChevronRight aria-hidden="true" />
          </ToolbarButton>
        </nav>
      )}
    </div>
  );
}
