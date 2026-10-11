/* Mail navigation: Compose, the folders in the familiar order (Inbox,
   Starred, Snoozed, Sent, Drafts, Scheduled), "More" with All Mail,
   Archive, Spam, Trash and the Inbox categories, then Labels with colour
   dots, nesting and unread counts. Each label has a ⋮ menu. Folders and
   labels accept conversations dragged from the list. Counts: unread for
   Inbox and labels, the total for Drafts. */

import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import { ChevronDown, FolderPlus, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";
import { type MailFolderKey, type MailFolderSummary, type MailLabelSummary } from "./api";
import { labelTree } from "./mail-label-tree";
import { TriggerButton } from "./mail-menus";
import { LabelColorMenu, openLabelDialog, openRemoveLabelDialog } from "./settings";
import {
  folderCount,
  MAIL_FOLDERS,
  MAIL_TABS,
  MORE_FOLDERS,
  PRIMARY_FOLDERS,
  type MailTabId,
} from "./mail-taxonomy";
import { MAIL_DRAG_TYPE } from "./mail-thread-row";
import { labelDotStyle } from "./mail-view-helpers";

export type MailDropTarget =
  | { readonly kind: "folder"; readonly folder: MailFolderKey }
  | { readonly kind: "label"; readonly slug: string };

/** Folders that take dropped conversations: each maps to one action. */
const DROP_FOLDERS: ReadonlySet<MailFolderKey> = new Set([
  "inbox",
  "starred",
  "archive",
  "spam",
  "trash",
]);

interface MailSidebarProps {
  /** The folder on screen, or null in a label view or search. */
  readonly activeFolder: MailFolderKey | null;
  readonly activeTab: MailTabId;
  readonly activeLabel: string | null;
  readonly folders: readonly MailFolderSummary[];
  readonly labels: readonly MailLabelSummary[];
  readonly onFolder: (folder: MailFolderKey) => void;
  readonly onCategory: (tab: MailTabId) => void;
  readonly onLabel: (slug: string) => void;
  readonly onCompose: () => void;
  readonly onDrop: (ids: readonly string[], target: MailDropTarget) => void;
}

function readDraggedIds(event: DragEvent): string[] | null {
  try {
    const parsed: unknown = JSON.parse(event.dataTransfer.getData(MAIL_DRAG_TYPE));
    return Array.isArray(parsed) && parsed.every((id) => typeof id === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/** Drag-over highlighting and drop for one sidebar row. */
function useDropTarget(accepts: boolean, onDropIds: (ids: string[]) => void) {
  const [over, setOver] = useState(false);
  if (!accepts) return { over: false, props: {} };
  const carriesThreads = (event: DragEvent) => event.dataTransfer.types.includes(MAIL_DRAG_TYPE);
  return {
    over,
    props: {
      onDragOver: (event: DragEvent) => {
        if (!carriesThreads(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        setOver(false);
        const ids = readDraggedIds(event);
        if (ids === null) return;
        event.preventDefault();
        onDropIds(ids);
      },
    },
  };
}

function NavRow({
  active,
  icon,
  label,
  count,
  bold = false,
  depth = 0,
  onClick,
  dropTarget,
  onDrop,
}: {
  readonly active: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly count: number;
  readonly bold?: boolean;
  readonly depth?: number;
  readonly onClick: () => void;
  readonly dropTarget: boolean;
  readonly onDrop: (ids: string[]) => void;
}) {
  const drop = useDropTarget(dropTarget, onDrop);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn("surf-nav-row mail-nav-row", drop.over && "is-drop-target", bold && "is-bold")}
      style={
        depth > 0 ? { paddingLeft: `calc(var(--nav-row-px) + ${String(depth * 14)}px)` } : undefined
      }
      {...drop.props}
    >
      {icon}
      <span className="label">{label}</span>
      {count > 0 ? (
        <span className="count">
          {count}
          <span className="sr-only">{bold ? " unread" : ""}</span>
        </span>
      ) : null}
    </button>
  );
}

function LabelRow({
  label,
  depth,
  active,
  onOpen,
  onDrop,
}: {
  readonly label: MailLabelSummary;
  readonly depth: number;
  readonly active: boolean;
  readonly onOpen: () => void;
  readonly onDrop: (ids: string[]) => void;
}) {
  return (
    <div className="mail-label-item">
      <NavRow
        active={active}
        icon={<span aria-hidden="true" className="mail-label-dot" style={labelDotStyle(label)} />}
        label={label.name}
        count={label.unreadCount}
        bold={label.unreadCount > 0}
        depth={depth}
        onClick={onOpen}
        dropTarget
        onDrop={onDrop}
      />
      <Menu>
        <MenuTrigger asChild>
          <TriggerButton
            className="mail-label-menu focus-ring"
            aria-label={`Options for ${label.name}`}
          >
            <MoreVertical aria-hidden="true" />
          </TriggerButton>
        </MenuTrigger>
        <MenuContent align="start" aria-label={`Options for ${label.name}`}>
          <LabelColorMenu label={label} />
          <MenuItem
            icon={<Pencil />}
            onSelect={() => openLabelDialog({ mode: "edit", labelId: label.id })}
          >
            Edit
          </MenuItem>
          <MenuItem icon={<Trash2 />} destructive onSelect={() => openRemoveLabelDialog(label.id)}>
            Remove label
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<FolderPlus />}
            onSelect={() => openLabelDialog({ mode: "create", parentId: label.id })}
          >
            Add sublabel
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

export function MailSidebar({
  activeFolder,
  activeTab,
  activeLabel,
  folders,
  labels,
  onFolder,
  onCategory,
  onLabel,
  onCompose,
  onDrop,
}: MailSidebarProps) {
  const summaries = new Map(folders.map((folder) => [folder.id, folder]));
  const [moreOpen, setMoreOpen] = useState(
    activeFolder !== null && MORE_FOLDERS.includes(activeFolder),
  );

  const folderRow = (id: MailFolderKey) => {
    const meta = MAIL_FOLDERS[id];
    const Icon = meta.icon;
    const summary = summaries.get(id);
    return (
      <NavRow
        key={id}
        active={activeFolder === id && (id !== "inbox" || activeTab === "primary")}
        icon={<Icon size={16} aria-hidden="true" />}
        label={meta.label}
        count={summary === undefined ? 0 : folderCount(summary)}
        bold={id === "inbox" && (summary?.unread ?? 0) > 0}
        onClick={() => onFolder(id)}
        dropTarget={DROP_FOLDERS.has(id)}
        onDrop={(ids) => onDrop(ids, { kind: "folder", folder: id })}
      />
    );
  };

  return (
    <aside className="surf-sidebar mail-sidebar" aria-label="Mail navigation">
      <button type="button" className="btn primary mail-compose-button" onClick={onCompose}>
        <Pencil aria-hidden="true" /> Compose
      </button>
      <nav className="mail-nav" aria-label="Folders">
        {PRIMARY_FOLDERS.map(folderRow)}
        <button
          type="button"
          className="surf-nav-row mail-nav-row"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={cn("mail-more-chevron", moreOpen && "is-open")}
          />
          <span className="label">{moreOpen ? "Less" : "More"}</span>
        </button>
        {moreOpen ? (
          <>
            {MORE_FOLDERS.map(folderRow)}
            <div className="mail-nav-subhead">Categories</div>
            {MAIL_TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <NavRow
                  key={tab.id}
                  active={activeFolder === "inbox" && activeTab === tab.id && tab.id !== "primary"}
                  icon={<Icon size={16} aria-hidden="true" />}
                  label={tab.label}
                  count={0}
                  depth={1}
                  onClick={() => onCategory(tab.id)}
                  dropTarget={false}
                  onDrop={() => undefined}
                />
              );
            })}
          </>
        ) : null}
      </nav>
      <div className="mail-labels-head">
        <h2 className="surf-section-label">Labels</h2>
        <button
          type="button"
          className="mail-label-menu focus-ring"
          aria-label="Create new label"
          onClick={() => openLabelDialog({ mode: "create" })}
        >
          <Plus aria-hidden="true" />
        </button>
      </div>
      <nav className="mail-nav" aria-label="Labels">
        {labelTree(labels).map(({ label, depth }) => (
          <LabelRow
            key={label.id}
            label={label}
            depth={depth}
            active={activeLabel === label.slug}
            onOpen={() => onLabel(label.slug)}
            onDrop={(ids) => onDrop(ids, { kind: "label", slug: label.slug })}
          />
        ))}
      </nav>
    </aside>
  );
}
