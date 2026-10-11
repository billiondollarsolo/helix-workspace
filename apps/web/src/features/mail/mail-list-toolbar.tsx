/* The strip above the conversation list. With nothing selected: select-all
   ▾, Refresh and ⋮. With a selection: Archive, Report spam, Delete | Mark
   read/unread, Snooze, Move to, Labels, ⋮. The pager stays on the right. */

import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Pager } from "@/components/ui/pager";
import { SelectAllCheckbox } from "@/components/ui/selectable-list";
import {
  Archive,
  ChevronDown,
  Clock,
  Filter,
  Folder,
  Inbox,
  Mail,
  MailCheck,
  MailOpen,
  MoreVertical,
  OctagonAlert,
  RefreshCw,
  Star,
  StarOff,
  Tag,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";
import type { MailFolderKey, MailLabelSummary, MailThreadRow } from "./api";
import type { MailAction } from "./mail-actions";
import {
  DROPDOWN_PARTS,
  LabelMenuItems,
  MoveMenuItems,
  TriggerButton,
  type MoveTarget,
} from "./mail-menus";
import {
  READING_PANE_OPTIONS,
  setMailShowAvatars,
  useMailReadingPane,
  useMailShowAvatars,
  useSetMailReadingPane,
  type MailReadingPane,
} from "./mail-preferences";
import { appliedState } from "./mail-row-context-menu";
import { MailSnoozePopover } from "./mail-snooze-picker";
import { openFilterDialog } from "./settings";

type SelectSubset = "all" | "none" | "read" | "unread" | "starred" | "unstarred";

const SELECT_SUBSETS: readonly { readonly value: SelectSubset; readonly label: string }[] = [
  { value: "all", label: "All" },
  { value: "none", label: "None" },
  { value: "read", label: "Read" },
  { value: "unread", label: "Unread" },
  { value: "starred", label: "Starred" },
  { value: "unstarred", label: "Unstarred" },
];

export function subsetIds(rows: readonly MailThreadRow[], subset: SelectSubset): Set<string> {
  const keep: Record<SelectSubset, (row: MailThreadRow) => boolean> = {
    all: () => true,
    none: () => false,
    read: (row) => !row.unread,
    unread: (row) => row.unread,
    starred: (row) => row.starred,
    unstarred: (row) => !row.starred,
  };
  return new Set(rows.filter(keep[subset]).map((row) => row.threadId));
}

export interface MailBulkHandlers {
  readonly onBulkAction: (action: MailAction) => void;
  readonly onBulkMove: (target: MoveTarget) => void;
  readonly onBulkSnooze: (until: string) => void;
}

interface MailListToolbarProps extends MailBulkHandlers {
  readonly rows: readonly MailThreadRow[];
  readonly selectedIds: ReadonlySet<string>;
  readonly onSelectedChange: (ids: Set<string>) => void;
  readonly folder: MailFolderKey;
  readonly labels: readonly MailLabelSummary[];
  readonly offset: number;
  readonly total: number;
  readonly onPage: (offset: number) => void;
  readonly pageSize: number;
  readonly onRefresh: () => void;
  readonly onMarkAllRead: () => void;
}

/** Icon button; spreads extra props so it can be a menu or popover trigger. */
export function ToolbarButton({
  label,
  children,
  showLabel = false,
  className,
  ...rest
}: ComponentProps<"button"> & { readonly label: string; readonly showLabel?: boolean }) {
  return (
    <button
      type="button"
      className={cn("mail-tool focus-ring", className)}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
      {showLabel ? <span className="mail-tool-text">{label}</span> : null}
    </button>
  );
}

function ViewOptionsItems() {
  const readingPane = useMailReadingPane();
  const setReadingPane = useSetMailReadingPane();
  const showAvatars = useMailShowAvatars();
  return (
    <>
      <MenuSeparator />
      <MenuLabel>Reading pane</MenuLabel>
      <MenuRadioGroup
        value={readingPane}
        onValueChange={(value) => setReadingPane(value as MailReadingPane)}
      >
        {READING_PANE_OPTIONS.map((option) => (
          <MenuRadioItem key={option.value} value={option.value}>
            {option.label}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuCheckboxItem checked={showAvatars} onCheckedChange={(next) => setMailShowAvatars(next)}>
        Show sender avatars
      </MenuCheckboxItem>
    </>
  );
}

export function MailListToolbar({
  rows,
  selectedIds,
  onSelectedChange,
  folder,
  labels,
  offset,
  total,
  onPage,
  pageSize,
  onRefresh,
  onMarkAllRead,
  onBulkAction,
  onBulkMove,
  onBulkSnooze,
}: MailListToolbarProps) {
  const selectedRows = rows.filter((row) => selectedIds.has(row.threadId));
  const hasSelection = selectedIds.size > 0;
  const anyUnread = selectedRows.some((row) => row.unread);
  const allStarred = selectedRows.length > 0 && selectedRows.every((row) => row.starred);

  return (
    <div
      className="mail-toolbar"
      role="toolbar"
      aria-label={hasSelection ? "Selected conversation actions" : "List actions"}
      data-selection={hasSelection || undefined}
    >
      <div className="mail-toolbar-group">
        <span className="mail-select-all">
          <SelectAllCheckbox
            total={rows.length}
            selectedCount={selectedRows.length}
            onToggle={(all) => onSelectedChange(subsetIds(rows, all ? "all" : "none"))}
            label="Select all conversations on this page"
          />
          <Menu>
            <MenuTrigger asChild>
              <TriggerButton className="mail-select-caret focus-ring" aria-label="Select">
                <ChevronDown aria-hidden="true" />
              </TriggerButton>
            </MenuTrigger>
            <MenuContent aria-label="Select">
              {SELECT_SUBSETS.map((subset) => (
                <MenuItem
                  key={subset.value}
                  onSelect={() => onSelectedChange(subsetIds(rows, subset.value))}
                >
                  {subset.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </span>
        {hasSelection ? (
          <>
            {folder === "trash" || folder === "archive" ? (
              <ToolbarButton
                label="Move to Inbox"
                onClick={() => onBulkAction({ kind: folder === "trash" ? "restore" : "unarchive" })}
              >
                <Inbox aria-hidden="true" />
              </ToolbarButton>
            ) : folder === "spam" ? null : (
              <ToolbarButton label="Archive" onClick={() => onBulkAction({ kind: "archive" })}>
                <Archive aria-hidden="true" />
              </ToolbarButton>
            )}
            {folder === "spam" ? (
              <ToolbarButton
                label="Not spam"
                showLabel
                onClick={() => onBulkAction({ kind: "notSpam" })}
              >
                <Inbox aria-hidden="true" />
              </ToolbarButton>
            ) : (
              <ToolbarButton label="Report spam" onClick={() => onBulkAction({ kind: "spam" })}>
                <OctagonAlert aria-hidden="true" />
              </ToolbarButton>
            )}
            {folder === "trash" ? null : (
              <ToolbarButton label="Delete" onClick={() => onBulkAction({ kind: "trash" })}>
                <Trash2 aria-hidden="true" />
              </ToolbarButton>
            )}
            <span className="mail-toolbar-divider" aria-hidden="true" />
            <ToolbarButton
              label={anyUnread ? "Mark as read" : "Mark as unread"}
              onClick={() => onBulkAction({ kind: "read", unread: !anyUnread })}
            >
              {anyUnread ? <MailOpen aria-hidden="true" /> : <Mail aria-hidden="true" />}
            </ToolbarButton>
            {folder === "trash" || folder === "spam" ? null : (
              <MailSnoozePopover onSnooze={onBulkSnooze}>
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
                <MoveMenuItems
                  parts={DROPDOWN_PARTS}
                  folder={folder}
                  labels={labels}
                  onMove={onBulkMove}
                />
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
                  applied={(slug) => appliedState(selectedRows, slug)}
                  onToggle={(slug, add) =>
                    onBulkAction({
                      kind: "label",
                      add: add ? [slug] : [],
                      remove: add ? [] : [slug],
                    })
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
                  icon={allStarred ? <StarOff /> : <Star />}
                  onSelect={() => onBulkAction({ kind: "star", starred: !allStarred })}
                >
                  {allStarred ? "Remove star" : "Add star"}
                </MenuItem>
                <MenuItem
                  icon={<Filter />}
                  onSelect={() => openFilterDialog({ from: selectedRows[0]?.fromEmail ?? "" })}
                >
                  Filter messages like these
                </MenuItem>
              </MenuContent>
            </Menu>
          </>
        ) : (
          <>
            <ToolbarButton label="Refresh" onClick={onRefresh}>
              <RefreshCw aria-hidden="true" />
            </ToolbarButton>
            <Menu>
              <MenuTrigger asChild>
                <ToolbarButton label="More actions">
                  <MoreVertical aria-hidden="true" />
                </ToolbarButton>
              </MenuTrigger>
              <MenuContent aria-label="More actions">
                <MenuItem icon={<MailCheck />} onSelect={onMarkAllRead}>
                  Mark all as read
                </MenuItem>
                <ViewOptionsItems />
              </MenuContent>
            </Menu>
          </>
        )}
      </div>
      {rows.length === 0 ? null : (
        <Pager
          className="mail-toolbar-pager"
          start={offset}
          pageCount={rows.length}
          total={total}
          onPrevious={() => onPage(Math.max(0, offset - pageSize))}
          onNext={() => onPage(offset + pageSize)}
        />
      )}
    </div>
  );
}
