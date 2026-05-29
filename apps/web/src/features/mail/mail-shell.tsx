/* Helix Mail — production surface.
   Recreated from the design handoff (app-mail.jsx): folder/label sidebar,
   category tab bar, ThreadRow list with live operator search, thread view
   with AI summary + inline composer, and the bottom-right compose modal.

   Data: wired to the real Mail backend via TanStack Query —
   `mail.folders.list` / `mail.labels.list` back the sidebar, `mail.threads.list`
   backs the thread list (folder + category tab + label filter + operator
   query + pagination), `mail.thread.get` backs the thread view, and the
   write tools (`mail.send`, `mail.reply`, `mail.archive`, `mail.snooze`,
   `mail.delete`, `mail.read.set`, `mail.star.set`, `mail.label.apply`) back
   the row + thread actions. The typed `mail-seed.ts` is kept ONLY as an
   offline/error fallback when a query fails. */

import "./mail-shell.css";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Icons, type IconName } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { SurfaceFrame } from "@/components/shell";
import {
  applyMailLabels,
  archiveMailThread,
  createMailFilter,
  deleteMailThread,
  replyToMail,
  sendMail,
  setMailThreadRead,
  setMailThreadStarred,
  snoozeMailThread,
  spamMailThread,
  type MailAttachment,
  type MailFolderKey,
  type MailFolderSummary,
  type MailLabelSummary,
  type MailSendInput,
  type MailThreadDetail,
  type MailThreadRow,
} from "./api";
import {
  MAIL_EMPTY_STATES,
  MAIL_TABS,
  type MailTabId,
} from "./mail-seed";
import {
  mailFoldersQueryOptions,
  mailLabelsQueryOptions,
  mailThreadQueryOptions,
  mailThreadsQueryOptions,
} from "./queries";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ----------------------------------------------------------- icons + time */

/** Static folder → icon map; the backend `mail.folders.list` is icon-free. */
const FOLDER_ICONS: Readonly<Record<MailFolderKey, IconName>> = {
  inbox: "Inbox",
  starred: "Star",
  snoozed: "Snooze",
  sent: "Send",
  drafts: "EditPen",
  archive: "Archive",
  spam: "Bell",
  trash: "Trash",
};

/** Folder display order in the left rail. */
const FOLDER_ORDER: readonly MailFolderKey[] = [
  "inbox",
  "starred",
  "snoozed",
  "sent",
  "drafts",
  "archive",
  "trash",
];

/** Renders an ISO timestamp into a compact, mailbox-style display string. */
function formatThreadTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((now.getTime() - date.getTime()) / dayMs);
  if (diffDays === 1) {
    return "Yesterday";
  }
  if (diffDays > 1 && diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ----------------------------------------------------------------- sidebar */

interface MailSidebarProps {
  readonly folder: MailFolderKey;
  readonly onFolder: (folder: MailFolderKey) => void;
  readonly onCompose: () => void;
  readonly folders: readonly MailFolderSummary[];
  readonly labels: readonly MailLabelSummary[];
  readonly activeLabel: string | null;
  readonly onLabel: (label: string | null) => void;
}

function MailSidebar({
  folder,
  onFolder,
  onCompose,
  folders,
  labels,
  activeLabel,
  onLabel,
}: MailSidebarProps) {
  const byId = new Map(folders.map((entry) => [entry.id, entry]));
  const ordered = FOLDER_ORDER.map((id) => byId.get(id)).filter(
    (entry): entry is MailFolderSummary => entry != null,
  );

  return (
    <aside className="surf-sidebar">
      <button
        type="button"
        className="btn primary lg"
        style={{ width: "100%", marginBottom: 12 }}
        onClick={onCompose}
      >
        <Icons.EditPen /> Compose
      </button>
      <div style={{ overflowY: "auto", flex: 1 }}>
        {ordered.map((entry) => {
          const Icon = Icons[FOLDER_ICONS[entry.id]];
          const active = folder === entry.id;
          const badge = entry.id === "inbox" ? entry.unread : entry.total;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onFolder(entry.id)}
              aria-current={active ? "page" : undefined}
              className="surf-nav-row"
            >
              <Icon />
              <span className="label">{entry.label}</span>
              {badge > 0 && <span className="count">{badge}</span>}
            </button>
          );
        })}
        <div className="surf-section-label">Labels</div>
        {labels.map((label) => {
          const active = activeLabel === label.slug;
          return (
            <button
              key={label.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onLabel(active ? null : label.slug)}
              className="surf-nav-row"
            >
              <span style={{ width: 8, height: 8, borderRadius: 2, background: label.color, flexShrink: 0 }} />
              <span className="label">{label.name}</span>
              {label.threadCount > 0 && <span className="count">{label.threadCount}</span>}
            </button>
          );
        })}
        <button type="button" className="surf-nav-row" style={{ color: "var(--text-3)" }}>
          <Icons.Plus />
          <span className="label">New label</span>
        </button>
        <div className="surf-section-label">Filters</div>
        <div style={{ padding: "0 var(--nav-row-px)" }}>
          <span className="chip">has:attachment</span>
        </div>
      </div>
    </aside>
  );
}

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
  readonly onToggleRead: () => void;
  readonly busy: boolean;
}

function ThreadRow({
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
  onToggleRead,
  busy,
}: ThreadRowProps) {
  const labels = thread.labels
    .map((slug) => labelColors.get(slug))
    .filter((label): label is MailLabelSummary => label != null);

  return (
    <div
      className="mail-thread-row"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      style={{
        display: "grid",
        gridTemplateColumns: "20px 20px 24px minmax(0, 200px) minmax(0, 1fr) auto",
        alignItems: "center",
        columnGap: 12,
        padding: "var(--rd-row-py) 16px",
        borderBottom: "1px solid var(--border)",
        cursor: "pointer",
        background: checked
          ? "var(--accent-soft)"
          : selected
            ? "var(--accent-soft)"
            : "transparent",
        transition: "background 0.08s",
        fontSize: "var(--rd-row-fs)",
        minHeight: "var(--rd-list-row-h)",
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
        style={{ accentColor: "var(--accent)", margin: 0 }}
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
        style={{
          width: 18,
          height: 18,
          display: "grid",
          placeItems: "center",
          color: thread.starred ? "#f59e0b" : "var(--text-3)",
        }}
      >
        <Icons.Star />
      </button>
      <Avatar name={thread.from.split(",")[0] ?? thread.from} size={22} />
      <span
        className="truncate"
        style={{
          fontWeight: thread.unread ? 600 : 500,
          color: thread.unread ? "var(--text)" : "var(--text-2)",
        }}
      >
        {thread.from}
        {thread.messageCount > 1 && (
          <span style={{ color: "var(--text-3)", fontWeight: 400 }}>
            {" "}
            ({thread.messageCount})
          </span>
        )}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {labels.map((label) => (
          <span
            key={label.id}
            style={{
              fontSize: "var(--text-chip)",
              padding: "0 5px",
              height: 16,
              lineHeight: "16px",
              borderRadius: 3,
              fontWeight: 500,
              flexShrink: 0,
              background: `${label.color}1f`,
              color: label.color,
            }}
          >
            {label.name}
          </span>
        ))}
        <span className="truncate" style={{ minWidth: 0 }}>
          <span
            style={{
              fontWeight: thread.unread ? 600 : 500,
              color: thread.unread ? "var(--text)" : "var(--text-2)",
            }}
          >
            {thread.subject}
          </span>
          <span style={{ color: "var(--text-3)", fontWeight: 400 }}>
            {" "}
            — {thread.preview}
          </span>
        </span>
      </div>
      {/* Date + inline hover actions cell */}
      <div className="mail-thread-row-meta">
        <span
          className="mail-thread-row-date"
          style={{
            fontSize: "var(--text-caption)",
            fontWeight: thread.unread ? 600 : 400,
            color: thread.unread ? "var(--text-2)" : "var(--text-3)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {thread.hasAttachment && <Icons.Paperclip />}
          <span>{formatThreadTime(thread.time)}</span>
        </span>
        {/* Hover action strip — visible on :hover / :focus-within via CSS */}
        <div
          className="mail-thread-row-actions"
          role="toolbar"
          aria-label={`Actions for ${thread.subject}`}
        >
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
            <Icons.Archive />
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
            <Icons.Trash />
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
            {thread.unread ? <Icons.Eye /> : <Icons.Mail />}
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
            <Icons.Snooze />
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- empty state */

function EmptyState({
  icon,
  title,
  body,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly body: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="empty" style={{ padding: 64 }}>
      {icon}
      <div style={{ fontSize: "var(--text-body)", fontWeight: 500, color: "var(--text)" }}>{title}</div>
      <div>{body}</div>
      {children}
    </div>
  );
}

/* --------------------------------------------------------------- thread list */

type SelectAllSubset = "all" | "none" | "read" | "unread" | "starred" | "unstarred";

interface ThreadListProps {
  readonly tab: MailTabId;
  readonly onTab: (tab: MailTabId) => void;
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
  readonly threads: readonly MailThreadRow[];
  readonly folder: MailFolderKey;
  readonly query: string;
  readonly onClearQuery: () => void;
  readonly labelColors: ReadonlyMap<string, MailLabelSummary>;
  readonly labels: readonly MailLabelSummary[];
  readonly folders: readonly MailFolderSummary[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly onPage: (offset: number) => void;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly onToggleStar: (thread: MailThreadRow) => void;
  readonly pendingThreadId: string | null;
  // Row-level mutations
  readonly onArchive: (threadId: string) => void;
  readonly onDelete: (threadId: string) => void;
  readonly onSnooze: (threadId: string) => void;
  readonly onToggleRead: (thread: MailThreadRow) => void;
  // Bulk
  readonly checkedIds: ReadonlySet<string>;
  readonly onCheckedChange: (ids: ReadonlySet<string>) => void;
  readonly onBulkArchive: (ids: ReadonlySet<string>) => void;
  readonly onBulkDelete: (ids: ReadonlySet<string>) => void;
  readonly onBulkSpam: (ids: ReadonlySet<string>) => void;
  readonly onBulkRead: (ids: ReadonlySet<string>, unread: boolean) => void;
  readonly onBulkSnooze: (ids: ReadonlySet<string>) => void;
  readonly onBulkMove: (ids: ReadonlySet<string>, folderId: MailFolderKey) => void;
  readonly onBulkLabel: (
    ids: ReadonlySet<string>,
    labelSlug: string,
    add: boolean,
  ) => void;
  // New toolbar actions
  readonly onRefresh: () => void;
  readonly onMarkAllRead: () => void;
  readonly onBulkStar: (ids: ReadonlySet<string>) => void;
  readonly onBulkFilterLike: (ids: ReadonlySet<string>) => void;
}

/* -------------------------------------------------------------- pager controls */

interface PagerControlsProps {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly threadCount: number;
  readonly isLoading: boolean;
  readonly onPage: (offset: number) => void;
}

function PagerControls({ total, offset, limit, threadCount, isLoading, onPage }: PagerControlsProps) {
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = offset + threadCount;
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      <span>
        {total === 0
          ? "No results"
          : `${String(rangeStart)}–${String(rangeEnd)} of ${String(total)}`}
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label="Newer"
        disabled={offset === 0 || isLoading}
        onClick={() => {
          onPage(Math.max(0, offset - limit));
        }}
      >
        <Icons.ChevronLeft />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Older"
        disabled={offset + limit >= total || isLoading}
        onClick={() => {
          onPage(offset + limit);
        }}
      >
        <Icons.ChevronRight />
      </button>
    </span>
  );
}

function ThreadList({
  tab,
  onTab,
  selected,
  onSelect,
  threads,
  folder,
  query,
  onClearQuery,
  labelColors,
  labels,
  folders,
  total,
  offset,
  limit,
  onPage,
  isLoading,
  isError,
  onToggleStar,
  pendingThreadId,
  onArchive,
  onDelete,
  onSnooze,
  onToggleRead,
  checkedIds,
  onCheckedChange,
  onBulkArchive,
  onBulkDelete,
  onBulkSpam,
  onBulkRead,
  onBulkSnooze,
  onBulkMove,
  onBulkLabel,
  onRefresh,
  onMarkAllRead,
  onBulkStar,
  onBulkFilterLike,
}: ThreadListProps) {
  const emptyState = MAIL_EMPTY_STATES[folder];
  const isEmptyFolder = emptyState != null && threads.length === 0 && !isLoading;
  const noResults =
    query.trim() !== "" && threads.length === 0 && !isEmptyFolder && !isLoading;

  // Select-all dropdown state
  const [selectDropOpen, setSelectDropOpen] = useState(false);
  const selectDropRef = useRef<HTMLDivElement>(null);

  // Idle toolbar "More" menu
  const [idleMoreOpen, setIdleMoreOpen] = useState(false);
  const idleMoreRef = useRef<HTMLDivElement>(null);

  // Bulk menus
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const [labelsMenuOpen, setLabelsMenuOpen] = useState(false);
  const [bulkMoreOpen, setBulkMoreOpen] = useState(false);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  const labelsMenuRef = useRef<HTMLDivElement>(null);
  const bulkMoreRef = useRef<HTMLDivElement>(null);

  // Shift-click tracking: last checked index (by threadId)
  const lastCheckedRef = useRef<string | null>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        selectDropRef.current &&
        !selectDropRef.current.contains(e.target as Node)
      ) {
        setSelectDropOpen(false);
      }
      if (
        idleMoreRef.current &&
        !idleMoreRef.current.contains(e.target as Node)
      ) {
        setIdleMoreOpen(false);
      }
      if (
        moveMenuRef.current &&
        !moveMenuRef.current.contains(e.target as Node)
      ) {
        setMoveMenuOpen(false);
      }
      if (
        labelsMenuRef.current &&
        !labelsMenuRef.current.contains(e.target as Node)
      ) {
        setLabelsMenuOpen(false);
      }
      if (
        bulkMoreRef.current &&
        !bulkMoreRef.current.contains(e.target as Node)
      ) {
        setBulkMoreOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const hasBulk = checkedIds.size > 0;
  const allChecked = threads.length > 0 && threads.every((t) => checkedIds.has(t.threadId));
  const someChecked = !allChecked && checkedIds.size > 0;

  function applySelectSubset(subset: SelectAllSubset) {
    let next: ReadonlySet<string>;
    switch (subset) {
      case "all":
        next = new Set(threads.map((t) => t.threadId));
        break;
      case "none":
        next = new Set();
        break;
      case "read":
        next = new Set(threads.filter((t) => !t.unread).map((t) => t.threadId));
        break;
      case "unread":
        next = new Set(threads.filter((t) => t.unread).map((t) => t.threadId));
        break;
      case "starred":
        next = new Set(threads.filter((t) => t.starred).map((t) => t.threadId));
        break;
      case "unstarred":
        next = new Set(threads.filter((t) => !t.starred).map((t) => t.threadId));
        break;
    }
    onCheckedChange(next);
    setSelectDropOpen(false);
    lastCheckedRef.current = null;
  }

  function handleMasterCheckbox() {
    if (allChecked) {
      onCheckedChange(new Set());
    } else {
      onCheckedChange(new Set(threads.map((t) => t.threadId)));
    }
    lastCheckedRef.current = null;
  }

  function handleRowCheck(thread: MailThreadRow, event: React.MouseEvent) {
    const idx = threads.findIndex((t) => t.threadId === thread.threadId);
    if (event.shiftKey && lastCheckedRef.current !== null) {
      const lastIdx = threads.findIndex((t) => t.threadId === lastCheckedRef.current);
      if (lastIdx !== -1) {
        const lo = Math.min(idx, lastIdx);
        const hi = Math.max(idx, lastIdx);
        const rangeIds = threads.slice(lo, hi + 1).map((t) => t.threadId);
        const next = new Set(checkedIds);
        for (const id of rangeIds) {
          next.add(id);
        }
        onCheckedChange(next);
        lastCheckedRef.current = thread.threadId;
        return;
      }
    }
    const next = new Set(checkedIds);
    if (next.has(thread.threadId)) {
      next.delete(thread.threadId);
    } else {
      next.add(thread.threadId);
    }
    onCheckedChange(next);
    lastCheckedRef.current = thread.threadId;
  }

  // Determine if a majority are unread to decide the bulk read button label
  const checkedUnreadCount = threads.filter(
    (t) => checkedIds.has(t.threadId) && t.unread,
  ).length;
  const bulkReadLabel =
    checkedUnreadCount >= checkedIds.size / 2 ? "Mark read" : "Mark unread";
  const bulkReadUnread = !(checkedUnreadCount >= checkedIds.size / 2);

  const SELECT_SUBSETS: Array<{ label: string; value: SelectAllSubset }> = [
    { label: "All", value: "all" },
    { label: "None", value: "none" },
    { label: "Read", value: "read" },
    { label: "Unread", value: "unread" },
    { label: "Starred", value: "starred" },
    { label: "Unstarred", value: "unstarred" },
  ];

  /* ---- Master checkbox + caret (shared by both toolbar states) ---- */
  const masterCheckboxSection = (
    <div className="mail-select-all-wrap" ref={selectDropRef}>
      <input
        type="checkbox"
        style={{ accentColor: "var(--accent)" }}
        aria-label={hasBulk ? "Deselect all" : "Select all"}
        checked={allChecked}
        ref={(el) => {
          if (el) {
            el.indeterminate = someChecked;
          }
        }}
        onChange={hasBulk ? () => { onCheckedChange(new Set()); } : handleMasterCheckbox}
      />
      <button
        type="button"
        className="mail-select-caret"
        aria-label="Select subset"
        aria-haspopup="listbox"
        aria-expanded={selectDropOpen}
        onClick={() => {
          setSelectDropOpen((v) => !v);
        }}
      >
        <Icons.ChevronDown size={10} />
      </button>
      {selectDropOpen && (
        <div
          className="mail-select-dropdown"
          role="listbox"
          aria-label="Select subset"
        >
          {SELECT_SUBSETS.map((item) => (
            <button
              key={item.value}
              type="button"
              className="mail-select-dropdown-item"
              role="option"
              aria-selected={false}
              onClick={() => {
                applySelectSubset(item.value);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ---- Single persistent toolbar strip (above the category tabs, Gmail-style) ---- */}
      <div className="mail-toolbar-strip" role="toolbar" aria-label={hasBulk ? "Bulk actions" : "Toolbar"}>
        {/* Left section — swaps based on selection state */}
        <div className="mail-toolbar-left">
          {masterCheckboxSection}

          {!hasBulk ? (
            /* Idle state left section */
            <>
              <button
                type="button"
                className="mail-bulk-btn"
                aria-label="Refresh"
                onClick={onRefresh}
              >
                <Icons.Refresh /> Refresh
              </button>
              {query.trim() !== "" && (
                <span
                  style={{
                    marginLeft: 4,
                    fontSize: "var(--text-caption)",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span>Filtering by</span>
                  <span
                    className="chip accent"
                    style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    {query}
                    <button
                      type="button"
                      onClick={onClearQuery}
                      aria-label="Clear search"
                      style={{ display: "inline-flex" }}
                    >
                      <Icons.X size={10} />
                    </button>
                  </span>
                </span>
              )}
              <div className="mail-menu-wrap" ref={idleMoreRef}>
                <button
                  type="button"
                  className="mail-bulk-btn"
                  aria-label="More actions"
                  aria-haspopup="menu"
                  aria-expanded={idleMoreOpen}
                  onClick={() => { setIdleMoreOpen((v) => !v); }}
                >
                  <Icons.More />
                </button>
                {idleMoreOpen && (
                  <div className="mail-menu-dropdown" role="menu" aria-label="More toolbar actions">
                    <button
                      type="button"
                      className="mail-menu-item"
                      role="menuitem"
                      onClick={() => {
                        onMarkAllRead();
                        setIdleMoreOpen(false);
                      }}
                    >
                      Mark all as read
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            /* Active (bulk) state left section */
            <>
              <span className="mail-bulk-toolbar-count">
                {String(checkedIds.size)} selected
              </span>
              <div className="v-divider mail-toolbar-divider" />
              {/* Destructive group */}
              <button
                type="button"
                className="mail-bulk-btn"
                aria-label="Archive selected"
                onClick={() => { onBulkArchive(checkedIds); }}
              >
                <Icons.Archive /> Archive
              </button>
              <button
                type="button"
                className="mail-bulk-btn"
                aria-label="Report spam"
                onClick={() => { onBulkSpam(checkedIds); }}
              >
                <Icons.Bell /> Report spam
              </button>
              <button
                type="button"
                className="mail-bulk-btn"
                aria-label="Delete selected"
                onClick={() => { onBulkDelete(checkedIds); }}
              >
                <Icons.Trash /> Delete
              </button>
              <div className="v-divider mail-toolbar-divider" />
              {/* State group */}
              <button
                type="button"
                className="mail-bulk-btn"
                aria-label={bulkReadLabel}
                onClick={() => { onBulkRead(checkedIds, bulkReadUnread); }}
              >
                <Icons.Eye /> {bulkReadLabel}
              </button>
              <button
                type="button"
                className="mail-bulk-btn"
                aria-label="Snooze selected"
                onClick={() => { onBulkSnooze(checkedIds); }}
              >
                <Icons.Snooze /> Snooze
              </button>
              <div className="v-divider mail-toolbar-divider" />
              {/* Organize group */}
              <div className="mail-menu-wrap" ref={moveMenuRef}>
                <button
                  type="button"
                  className="mail-bulk-btn"
                  aria-label="Move to"
                  aria-haspopup="menu"
                  aria-expanded={moveMenuOpen}
                  onClick={() => {
                    setMoveMenuOpen((v) => !v);
                    setLabelsMenuOpen(false);
                    setBulkMoreOpen(false);
                  }}
                >
                  <Icons.Folder /> Move to <Icons.ChevronDown size={10} />
                </button>
                {moveMenuOpen && (
                  <div className="mail-menu-dropdown" role="menu" aria-label="Move to folder">
                    {folders.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        className="mail-menu-item"
                        role="menuitem"
                        onClick={() => {
                          onBulkMove(checkedIds, f.id);
                          setMoveMenuOpen(false);
                        }}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="mail-menu-wrap" ref={labelsMenuRef}>
                <button
                  type="button"
                  className="mail-bulk-btn"
                  aria-label="Labels"
                  aria-haspopup="menu"
                  aria-expanded={labelsMenuOpen}
                  onClick={() => {
                    setLabelsMenuOpen((v) => !v);
                    setMoveMenuOpen(false);
                    setBulkMoreOpen(false);
                  }}
                >
                  <Icons.Tag /> Labels <Icons.ChevronDown size={10} />
                </button>
                {labelsMenuOpen && (
                  <div className="mail-menu-dropdown" role="menu" aria-label="Apply label">
                    {labels.map((lbl) => {
                      const applied = threads
                        .filter((t) => checkedIds.has(t.threadId))
                        .every((t) => t.labels.includes(lbl.slug));
                      return (
                        <button
                          key={lbl.id}
                          type="button"
                          className="mail-menu-item"
                          role="menuitemcheckbox"
                          aria-checked={applied}
                          onClick={() => {
                            onBulkLabel(checkedIds, lbl.slug, !applied);
                            setLabelsMenuOpen(false);
                          }}
                        >
                          <span
                            className="mail-menu-label-dot"
                            style={{ background: lbl.color }}
                          />
                          {lbl.name}
                          {applied && (
                            <Icons.Check
                              className="mail-menu-item-check"
                              style={{ marginLeft: "auto" }}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              {/* Bulk "More" menu */}
              <div className="mail-menu-wrap" ref={bulkMoreRef}>
                <button
                  type="button"
                  className="mail-bulk-btn"
                  aria-label="More bulk actions"
                  aria-haspopup="menu"
                  aria-expanded={bulkMoreOpen}
                  onClick={() => {
                    setBulkMoreOpen((v) => !v);
                    setMoveMenuOpen(false);
                    setLabelsMenuOpen(false);
                  }}
                >
                  <Icons.More />
                </button>
                {bulkMoreOpen && (
                  <div className="mail-menu-dropdown" role="menu" aria-label="More bulk actions menu">
                    <button
                      type="button"
                      className="mail-menu-item"
                      role="menuitem"
                      onClick={() => {
                        onBulkStar(checkedIds);
                        setBulkMoreOpen(false);
                      }}
                    >
                      Add star
                    </button>
                    <button
                      type="button"
                      className="mail-menu-item"
                      role="menuitem"
                      onClick={() => {
                        onBulkFilterLike(checkedIds);
                        setBulkMoreOpen(false);
                      }}
                    >
                      Filter messages like these
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Right section — pager, never moves */}
        <div className="mail-toolbar-right">
          <PagerControls
            total={total}
            offset={offset}
            limit={limit}
            threadCount={threads.length}
            isLoading={isLoading}
            onPage={onPage}
          />
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label="Mail categories">
        {MAIL_TABS.map((entry) => {
          const Icon = Icons[entry.icon];
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={cx("tab", tab === entry.id && "active")}
              onClick={() => {
                onTab(entry.id);
              }}
            >
              <Icon /> {entry.label}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {isError && (
          <div
            style={{
              margin: "8px 16px 0",
              fontSize: "var(--text-caption)",
              color: "var(--danger)",
            }}
          >
            Could not load mail from the server — showing offline data.
          </div>
        )}
        {isLoading && (
          <EmptyState
            icon={<Icons.Inbox />}
            title="Loading mail…"
            body="Fetching your threads."
          />
        )}
        {!isLoading && noResults && (
          <EmptyState
            icon={<Icons.Search />}
            title={`No results for "${query}"`}
            body={
              <>
                Try a different search or remove an operator like{" "}
                <span className="mono">from:</span> or{" "}
                <span className="mono">has:attachment</span>.
              </>
            }
          >
            <button
              type="button"
              className="btn sm"
              style={{ marginTop: 8 }}
              onClick={onClearQuery}
            >
              Clear search
            </button>
          </EmptyState>
        )}
        {!isLoading &&
          isEmptyFolder &&
          emptyState != null &&
          (() => {
            const Icon = Icons[emptyState.icon];
            return (
              <EmptyState
                icon={<Icon />}
                title={emptyState.title}
                body={emptyState.body}
              />
            );
          })()}
        {!isLoading &&
          !noResults &&
          !isEmptyFolder &&
          threads.map((thread) => (
            <ThreadRow
              key={thread.threadId}
              thread={thread}
              checked={checkedIds.has(thread.threadId)}
              selected={selected === thread.threadId}
              labelColors={labelColors}
              onClick={() => {
                onSelect(thread.threadId);
              }}
              onToggleStar={() => {
                onToggleStar(thread);
              }}
              onToggleCheck={(event) => {
                handleRowCheck(thread, event);
              }}
              onArchive={() => {
                onArchive(thread.threadId);
              }}
              onDelete={() => {
                onDelete(thread.threadId);
              }}
              onSnooze={() => {
                onSnooze(thread.threadId);
              }}
              onToggleRead={() => {
                onToggleRead(thread);
              }}
              busy={pendingThreadId === thread.threadId}
            />
          ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- thread view */

type ReplyMode = "reply" | "replyAll" | "forward";

interface ThreadViewProps {
  readonly row: MailThreadRow;
  readonly detail: MailThreadDetail | null | undefined;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly labelColors: ReadonlyMap<string, MailLabelSummary>;
  readonly onClose: () => void;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
  readonly onSnooze: () => void;
  readonly onToggleLabel: () => void;
  readonly actionBusy: boolean;
  readonly actionError: string | null;
}

function ThreadView({
  row,
  detail,
  isLoading,
  isError,
  labelColors,
  onClose,
  onArchive,
  onDelete,
  onSnooze,
  onToggleLabel,
  actionBusy,
  actionError,
}: ThreadViewProps) {
  const [aiSummary, setAiSummary] = useState(false);
  const [replyMode, setReplyMode] = useState<ReplyMode | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [replyFailed, setReplyFailed] = useState(false);
  const senderName = row.from.split(",")[0] ?? row.from;
  const subject = detail?.subject ?? row.subject;
  const labels = (detail?.labels ?? row.labels)
    .map((slug) => labelColors.get(slug))
    .filter((label): label is MailLabelSummary => label != null);
  const messages = detail?.messages ?? [];
  const participantCount = detail?.participants.length ?? row.messageCount;

  const replyMutation = useMutation({
    mutationFn: (input: MailSendInput) => replyToMail({ ...input, threadId: row.threadId }),
    onMutate: () => {
      setReplyFailed(false);
    },
    onError: () => {
      setReplyFailed(true);
    },
    onSuccess: () => {
      setReplyMode(null);
      setReplyText("");
      setReplyTo("");
    },
  });

  const closeReply = useCallback(() => {
    setReplyMode(null);
    setReplyText("");
    setReplyTo("");
    setReplyFailed(false);
  }, []);

  const handleReplySend = useCallback(() => {
    const fallbackAddress = detail?.messages.at(-1)?.from?.address ?? row.fromEmail;
    const recipients =
      replyMode === "forward"
        ? parseRecipients(replyTo)
        : fallbackAddress.trim() === ""
          ? []
          : [{ address: fallbackAddress }];
    if (recipients.length === 0 || replyText.trim() === "") {
      return;
    }
    replyMutation.mutate({
      to: recipients,
      subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
      bodyText: replyText,
    });
  }, [detail, replyMode, replyMutation, replyText, replyTo, row.fromEmail, subject]);

  return (
    <div
      className="flex-1"
      style={{ display: "flex", flexDirection: "column", background: "var(--surface)" }}
    >
      <div
        style={{
          height: 44,
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          gap: 4,
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <button type="button" className="icon-btn" aria-label="Back" onClick={onClose}>
          <Icons.ArrowLeft />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Archive"
          disabled={actionBusy}
          onClick={onArchive}
        >
          <Icons.Archive />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Delete"
          disabled={actionBusy}
          onClick={onDelete}
        >
          <Icons.Trash />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Snooze"
          disabled={actionBusy}
          onClick={onSnooze}
        >
          <Icons.Snooze />
        </button>
        <div className="v-divider" style={{ height: 18, margin: "0 4px" }} />
        <button
          type="button"
          className="icon-btn"
          aria-label="Label"
          disabled={actionBusy}
          onClick={onToggleLabel}
        >
          <Icons.Tag />
        </button>
        <button type="button" className="icon-btn" aria-label="More actions">
          <Icons.MoreV />
        </button>
        <span style={{ marginLeft: "auto", fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
          {messages.length > 0 ? `${String(messages.length)} messages` : ""}
        </span>
        <button type="button" className="icon-btn" aria-label="Previous conversation">
          <Icons.ChevronLeft />
        </button>
        <button type="button" className="icon-btn" aria-label="Next conversation">
          <Icons.ChevronRight />
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
        <div style={{ maxWidth: 880, margin: "0 auto", padding: "20px 32px" }}>
          <div style={{ marginBottom: 16 }}>
            <h1
              style={{ margin: "0 0 8px", fontSize: "var(--text-h2)", fontWeight: 600, lineHeight: 1.35 }}
            >
              {subject}
            </h1>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {labels.map((label) => (
                <span
                  key={label.id}
                  style={{
                    fontSize: "var(--text-caption)",
                    padding: "2px 6px",
                    borderRadius: 4,
                    fontWeight: 500,
                    background: `${label.color}20`,
                    color: label.color,
                  }}
                >
                  {label.name}
                </span>
              ))}
            </div>
          </div>

          {isError && (
            <div style={{ marginBottom: 12, fontSize: "var(--text-caption)", color: "var(--danger)" }}>
              Could not load the full conversation — showing the list preview.
            </div>
          )}
          {actionError != null && (
            <div style={{ marginBottom: 12, fontSize: "var(--text-caption)", color: "var(--danger)" }}>
              {actionError}
            </div>
          )}

          <button
            type="button"
            className="btn sm"
            style={{ marginBottom: 16 }}
            onClick={() => {
              setAiSummary((value) => !value);
            }}
          >
            <Icons.Sparkles />{" "}
            {aiSummary ? "Hide AI summary" : "Summarize with Helix AI"}
          </button>
          {aiSummary && (
            <div
              style={{
                background: "var(--accent-soft)",
                border: "1px solid var(--accent-soft-border)",
                borderRadius: 8,
                padding: 12,
                fontSize: "var(--text-meta)",
                marginBottom: 16,
                lineHeight: 1.55,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontWeight: 600,
                  marginBottom: 6,
                  color: "var(--accent)",
                }}
              >
                <Icons.Sparkles /> Summary
              </div>
              {senderName} is asking for sign-off on this thread. Key open items and
              requested next steps are highlighted below — review before replying.
              <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setReplyMode("reply");
                  }}
                >
                  Draft reply
                </button>
                <button type="button" className="btn sm">
                  Schedule meeting
                </button>
              </div>
            </div>
          )}

          {isLoading && messages.length === 0 && (
            <div
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 16,
                marginBottom: 12,
                fontSize: "var(--text-body-sm)",
                color: "var(--text-3)",
              }}
            >
              Loading conversation…
            </div>
          )}

          {(messages.length > 0
            ? messages
            : [
                {
                  id: row.messageId,
                  from: { address: row.fromEmail, name: senderName },
                  to: [],
                  cc: [],
                  bcc: [],
                  sentAt: row.time,
                  body: row.preview,
                  bodyFormat: "plain" as const,
                  hasAttachment: row.hasAttachment,
                },
              ]
          ).map((message) => {
            const msgSender = message.from?.name ?? message.from?.address ?? senderName;
            return (
              <div
                key={message.id}
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 16,
                  marginBottom: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <Avatar name={msgSender} size={32} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ fontWeight: 600, fontSize: "var(--text-body-sm)" }}>{msgSender}</span>
                      <span style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
                        {message.from?.address ?? row.fromEmail}
                      </span>
                      <span
                        style={{
                          marginLeft: "auto",
                          fontSize: "var(--text-caption)",
                          color: "var(--text-3)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatThreadTime(message.sentAt)}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: "var(--text-caption)",
                        color: "var(--text-3)",
                        marginBottom: 12,
                      }}
                    >
                      to{" "}
                      {message.to.length > 0
                        ? message.to
                            .map((addr) => addr.name ?? addr.address)
                            .join(", ")
                        : "me"}
                    </div>
                    <div
                      style={{ whiteSpace: "pre-wrap", fontSize: "var(--text-body-sm)", lineHeight: 1.6 }}
                    >
                      {message.body}
                    </div>
                    {message.hasAttachment && (
                      <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
                        <div
                          style={{
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            padding: "8px 10px",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            fontSize: "var(--text-meta)",
                          }}
                        >
                          <Icons.Doc />
                          <div>
                            <div style={{ fontWeight: 500 }}>Attachment</div>
                            <div style={{ fontSize: "var(--text-chip)", color: "var(--text-3)" }}>
                              View in conversation
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setReplyMode("reply");
              }}
            >
              <Icons.Reply /> Reply
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setReplyMode("replyAll");
              }}
            >
              <Icons.Reply /> Reply all
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setReplyMode("forward");
              }}
            >
              <Icons.Forward /> Forward
            </button>
            <button type="button" className="btn">
              <Icons.Sparkles /> Smart reply
            </button>
          </div>

          {replyMode != null && (
            <div
              style={{
                marginTop: 16,
                background: "var(--surface)",
                border: "1px solid var(--accent-soft-border)",
                borderRadius: 8,
                padding: 0,
                boxShadow: "0 0 0 3px var(--accent-soft)",
              }}
            >
              <div
                style={{
                  padding: "8px 14px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: "var(--text-meta)",
                }}
              >
                {replyMode === "forward" ? <Icons.Forward /> : <Icons.Reply />}
                <span style={{ fontWeight: 600 }}>
                  {replyMode === "reply" && `Replying to ${senderName}`}
                  {replyMode === "replyAll" &&
                    `Replying all (${String(participantCount)} people)`}
                  {replyMode === "forward" && `Forwarding "${subject}"`}
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  style={{ marginLeft: "auto" }}
                  onClick={closeReply}
                  aria-label="Close reply"
                >
                  <Icons.X />
                </button>
              </div>
              {replyMode === "forward" && (
                <div
                  style={{
                    padding: "8px 14px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", width: 50 }}>
                    To
                  </span>
                  <input
                    className="input"
                    aria-label="Forward recipients"
                    placeholder="Add recipients"
                    value={replyTo}
                    onChange={(event) => {
                      setReplyTo(event.target.value);
                    }}
                    style={{ flex: 1, border: "none", height: 26 }}
                  />
                </div>
              )}
              <textarea
                value={replyText}
                onChange={(event) => {
                  setReplyText(event.target.value);
                }}
                placeholder="Write your reply…"
                aria-label="Reply body"
                style={{
                  width: "100%",
                  minHeight: 120,
                  padding: 14,
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  fontSize: "var(--text-body-sm)",
                  lineHeight: 1.55,
                  resize: "vertical",
                  fontFamily: "inherit",
                }}
              />
              {replyFailed && (
                <div
                  style={{
                    margin: "0 14px 8px",
                    fontSize: "var(--text-caption)",
                    color: "var(--danger)",
                  }}
                >
                  Could not send reply. Try again.
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "8px 12px",
                  borderTop: "1px solid var(--border)",
                }}
              >
                <button
                  type="button"
                  className="btn primary"
                  disabled={replyMutation.isPending || replyText.trim() === ""}
                  onClick={handleReplySend}
                >
                  <Icons.Send /> {replyMutation.isPending ? "Sending…" : "Send"}
                </button>
                <button type="button" className="icon-btn" aria-label="Attach">
                  <Icons.Paperclip />
                </button>
                <button type="button" className="icon-btn" aria-label="Insert link">
                  <Icons.Link />
                </button>
                <button type="button" className="icon-btn" aria-label="Emoji">
                  <Icons.Smile />
                </button>
                <button type="button" className="icon-btn" aria-label="AI assist">
                  <Icons.Sparkles />
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  style={{ marginLeft: "auto" }}
                  onClick={closeReply}
                >
                  Discard
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ compose */

interface ComposeProps {
  readonly onClose: () => void;
  readonly onSent: () => void;
}

/** Parses a comma/semicolon-separated recipient string into addresses. */
function parseRecipients(raw: string): MailSendInput["to"] {
  return raw
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((address) => ({ address }));
}

/**
 * Reads a File into a base-64 string asynchronously.
 * Strips the "data:<type>;base64," prefix produced by FileReader so the
 * backend receives a plain base-64 payload.
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader did not return a string"));
        return;
      }
      // "data:<mime>;base64,<data>" → keep only <data>
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("FileReader error"));
    };
    reader.readAsDataURL(file);
  });
}

function Compose({ onClose, onSent }: ComposeProps) {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const [attachments, setAttachments] = useState<readonly MailAttachment[]>([]);
  /** Drag-enter depth counter — incremented on dragenter, decremented on
   *  dragleave.  The overlay shows while > 0, which prevents flickering when
   *  the cursor moves over child elements (each child fires its own enter/leave
   *  pair without the counter ever reaching zero). */
  const dragDepth = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sendMutation = useMutation({
    mutationFn: (input: MailSendInput) => sendMail(input),
    onMutate: () => {
      setSendFailed(false);
    },
    onError: () => {
      setSendFailed(true);
    },
    onSuccess: () => {
      onSent();
      onClose();
    },
  });

  const recipients = parseRecipients(to);
  const canSend = recipients.length > 0 && !sendMutation.isPending;

  const handleSend = useCallback(() => {
    if (recipients.length === 0) {
      return;
    }
    sendMutation.mutate({
      to: recipients,
      cc: parseRecipients(cc),
      bcc: parseRecipients(bcc),
      subject,
      bodyText: body,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  }, [attachments, bcc, body, cc, recipients, sendMutation, subject]);

  /** Convert a FileList (from picker or drop) into MailAttachment records and
   *  append them to the current attachment list. */
  const attachFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const resolved = await Promise.all(
      fileArray.map(async (file) => {
        const content = await fileToBase64(file);
        const attachment: MailAttachment = {
          filename: file.name,
          contentType: file.type !== "" ? file.type : "application/octet-stream",
          content,
        };
        return attachment;
      }),
    );
    setAttachments((prev) => [...prev, ...resolved]);
  }, []);

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current += 1;
    if (dragDepth.current === 1) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    // Setting dropEffect signals to the browser that a drop is accepted.
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setIsDragOver(false);
      const { files } = event.dataTransfer;
      if (files.length > 0) {
        void attachFiles(files);
      }
    },
    [attachFiles],
  );

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { files } = event.target;
      if (files !== null && files.length > 0) {
        void attachFiles(files);
      }
      // Reset the input so the same file can be re-selected if removed.
      event.target.value = "";
    },
    [attachFiles],
  );

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, idx) => idx !== index));
  }, []);

  return (
    <div
      className="compose compose-drop-root"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="compose-drop-overlay" aria-label="Drop files to attach">
          <Icons.Paperclip />
          Drop files to attach
        </div>
      )}
      {/* Hidden file input — triggered by the Attach toolbar button */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        aria-label="Attach files"
        style={{ display: "none" }}
        onChange={handleFileInputChange}
      />
      <div className="compose-header">
        <span>New message</span>
        <div style={{ display: "flex", gap: 2 }}>
          <button type="button" className="icon-btn" aria-label="Minimize">
            <Icons.ChevronDown />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
          >
            <Icons.X />
          </button>
        </div>
      </div>
      <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "4px 0",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", width: 50 }}>To</span>
          <input
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
            }}
            aria-label="To"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: "var(--text-body-sm)",
            }}
          />
          <button
            type="button"
            aria-pressed={showCc}
            onClick={() => {
              setShowCc((value) => !value);
            }}
            style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}
          >
            Cc
          </button>
          <span style={{ margin: "0 6px", color: "var(--text-3)" }}>·</span>
          <button
            type="button"
            aria-pressed={showBcc}
            onClick={() => {
              setShowBcc((value) => !value);
            }}
            style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}
          >
            Bcc
          </button>
        </div>
        {showCc && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "4px 0",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", width: 50 }}>Cc</span>
            <input
              value={cc}
              onChange={(event) => {
                setCc(event.target.value);
              }}
              aria-label="Cc"
              style={{
                flex: 1,
                border: "none",
                outline: "none",
                background: "transparent",
                fontSize: "var(--text-body-sm)",
              }}
            />
          </div>
        )}
        {showBcc && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "4px 0",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", width: 50 }}>Bcc</span>
            <input
              value={bcc}
              onChange={(event) => {
                setBcc(event.target.value);
              }}
              aria-label="Bcc"
              style={{
                flex: 1,
                border: "none",
                outline: "none",
                background: "transparent",
                fontSize: "var(--text-body-sm)",
              }}
            />
          </div>
        )}
        <div style={{ padding: "4px 0" }}>
          <input
            value={subject}
            onChange={(event) => {
              setSubject(event.target.value);
            }}
            placeholder="Subject"
            aria-label="Subject"
            style={{
              width: "100%",
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: "var(--text-body-sm)",
              fontWeight: 500,
            }}
          />
        </div>
      </div>
      <textarea
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
        }}
        placeholder="Write your message…"
        aria-label="Message body"
        style={{
          width: "100%",
          minHeight: 200,
          padding: 14,
          border: "none",
          outline: "none",
          background: "transparent",
          fontSize: "var(--text-body-sm)",
          lineHeight: 1.55,
          resize: "none",
          fontFamily: "inherit",
        }}
      />
      {attachments.length > 0 && (
        <div className="compose-attachments" aria-label="Attached files">
          {attachments.map((attachment, index) => (
            <div key={`${attachment.filename}-${String(index)}`} className="compose-attachment-chip">
              <Icons.Paperclip />
              <span title={attachment.filename}>{attachment.filename}</span>
              <button
                type="button"
                aria-label={`Remove attachment ${attachment.filename}`}
                onClick={() => {
                  removeAttachment(index);
                }}
              >
                <Icons.X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      {sendFailed && (
        <div style={{ margin: "0 14px 8px", fontSize: "var(--text-caption)", color: "var(--danger)" }}>
          Could not send message. Try again.
        </div>
      )}
      {scheduling && (
        <div
          style={{
            margin: "0 14px 8px",
            padding: 10,
            background: "var(--accent-soft)",
            borderRadius: 6,
            border: "1px solid var(--accent-soft-border)",
            fontSize: "var(--text-meta)",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4, color: "var(--accent)" }}>
            Schedule send
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn sm">
              Tomorrow 8:00 AM
            </button>
            <button type="button" className="btn sm">
              Monday 8:00 AM
            </button>
            <button type="button" className="btn sm">
              Pick date &amp; time
            </button>
          </div>
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "8px 12px",
          borderTop: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex" }}>
          <button
            type="button"
            className="btn primary"
            disabled={!canSend}
            onClick={handleSend}
          >
            <Icons.Send /> {sendMutation.isPending ? "Sending…" : "Send"}
          </button>
          <button
            type="button"
            className="btn primary icon"
            aria-label="Schedule send"
            style={{
              borderLeft: "1px solid rgba(255,255,255,0.2)",
              marginLeft: 1,
              borderRadius: "0 6px 6px 0",
            }}
            onClick={() => {
              setScheduling((value) => !value);
            }}
          >
            <Icons.ChevronDown />
          </button>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Attach"
          onClick={() => {
            fileInputRef.current?.click();
          }}
        >
          <Icons.Paperclip />
        </button>
        <button type="button" className="icon-btn" aria-label="Insert link">
          <Icons.Link />
        </button>
        <button type="button" className="icon-btn" aria-label="Emoji">
          <Icons.Smile />
        </button>
        <button type="button" className="icon-btn" aria-label="Insert image">
          <Icons.Image />
        </button>
        <button type="button" className="icon-btn" aria-label="AI assist">
          <Icons.Sparkles />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Discard draft"
          style={{ marginLeft: "auto" }}
          onClick={onClose}
        >
          <Icons.Trash />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- shell */

const PAGE_SIZE = 50;

export function MailShell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // URL-hydrated initial values — back button restores the prior view.
  const urlSearch: Partial<{ folder: string; tab: MailTabId; thread: string; q: string; label: string }> =
    useSearch({ strict: false });
  const [folder, setFolder] = useState<MailFolderKey>(
    ((urlSearch.folder as MailFolderKey | undefined) ?? "inbox"),
  );
  const [tab, setTab] = useState<MailTabId>(urlSearch.tab ?? "primary");
  const [activeLabel, setActiveLabel] = useState<string | null>(urlSearch.label ?? null);
  const [selected, setSelected] = useState<string | null>(urlSearch.thread ?? null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [query, setQuery] = useState(urlSearch.q ?? "");

  // Two-way bind to the URL. Local state pushes new history entries when the
  // user navigates; popstate (browser back/forward) flips urlSearch which we
  // pull back into local state below. Without the reverse sync, hitting back
  // changed the URL but left the React tree on the still-selected thread.
  useEffect(() => {
    void navigate({
      to: "/mail",
      search: {
        ...(folder === "inbox" ? {} : { folder }),
        ...(tab === "primary" ? {} : { tab }),
        ...(selected ? { thread: selected } : {}),
        ...(query.length === 0 ? {} : { q: query }),
        ...(activeLabel ? { label: activeLabel } : {}),
      },
      replace: false,
    });
  }, [folder, tab, selected, query, activeLabel]);

  // Reverse sync: when the URL changes externally (browser back/forward,
  // deep-link navigation), pull the new search params back into local state.
  // Guard against echo loops — only update when the URL value differs from
  // what local state would emit.
  useEffect(() => {
    const urlFolder = (urlSearch.folder as MailFolderKey | undefined) ?? "inbox";
    const urlTab = urlSearch.tab ?? "primary";
    const urlThread = urlSearch.thread ?? null;
    const urlQuery = urlSearch.q ?? "";
    const urlLabel = urlSearch.label ?? null;
    if (urlFolder !== folder) setFolder(urlFolder);
    if (urlTab !== tab) setTab(urlTab);
    if (urlThread !== selected) setSelected(urlThread);
    if (urlQuery !== query) setQuery(urlQuery);
    if (urlLabel !== activeLabel) setActiveLabel(urlLabel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSearch.folder, urlSearch.tab, urlSearch.thread, urlSearch.q, urlSearch.label]);
  const [offset, setOffset] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  // Checked (bulk-select) thread IDs
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());

  const foldersQuery = useQuery(mailFoldersQueryOptions());
  const labelsQuery = useQuery(mailLabelsQueryOptions());

  const threadsInput = useMemo(
    () => ({
      folder,
      tab: folder === "inbox" ? tab : undefined,
      label: activeLabel ?? undefined,
      query: query.trim() === "" ? undefined : query.trim(),
      limit: PAGE_SIZE,
      offset,
    }),
    [activeLabel, folder, offset, query, tab],
  );
  const threadsQuery = useQuery(mailThreadsQueryOptions(threadsInput));

  const folders = foldersQuery.data ?? [];
  const labels = labelsQuery.data ?? [];

  const threadsResult = threadsQuery.data;
  const threads = threadsResult?.threads ?? [];
  const total = threadsResult?.total ?? 0;

  const labelColors = useMemo(
    () => new Map(labels.map((label) => [label.slug, label])),
    [labels],
  );

  const selectedRow = useMemo(
    () => threads.find((thread) => thread.threadId === selected) ?? null,
    [selected, threads],
  );

  const threadDetailQuery = useQuery({
    ...mailThreadQueryOptions(selected ?? ""),
    enabled: selected != null,
  });

  const invalidateLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["mail", "threads"] });
    void queryClient.invalidateQueries({ queryKey: ["mail", "folders"] });
    void queryClient.invalidateQueries({ queryKey: ["mail", "labels"] });
  }, [queryClient]);

  const clearActionError = useCallback(() => {
    setActionError(null);
  }, []);

  const starMutation = useMutation({
    mutationFn: (input: { readonly threadId: string; readonly starred: boolean }) =>
      setMailThreadStarred(input),
    onMutate: clearActionError,
    onError: () => {
      setActionError("Could not update the star. Try again.");
    },
    onSuccess: invalidateLists,
  });

  const archiveMutation = useMutation({
    mutationFn: (threadId: string) => archiveMailThread(threadId),
    onMutate: clearActionError,
    onError: () => {
      setActionError("Could not archive the thread. Try again.");
    },
    onSuccess: () => {
      invalidateLists();
      setSelected(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (threadId: string) => deleteMailThread(threadId),
    onMutate: clearActionError,
    onError: () => {
      setActionError("Could not delete the thread. Try again.");
    },
    onSuccess: () => {
      invalidateLists();
      setSelected(null);
    },
  });

  const snoozeMutation = useMutation({
    mutationFn: (threadId: string) =>
      snoozeMailThread({
        threadId,
        until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
    onMutate: clearActionError,
    onError: () => {
      setActionError("Could not snooze the thread. Try again.");
    },
    onSuccess: () => {
      invalidateLists();
      setSelected(null);
    },
  });

  const readMutation = useMutation({
    mutationFn: (input: { readonly threadId: string; readonly unread: boolean }) =>
      setMailThreadRead(input),
    onMutate: clearActionError,
    onError: () => {
      setActionError("Could not update the read state. Try again.");
    },
    onSuccess: invalidateLists,
  });

  const labelMutation = useMutation({
    mutationFn: (input: {
      readonly threadId: string;
      readonly add?: readonly string[];
      readonly remove?: readonly string[];
    }) => applyMailLabels(input),
    onMutate: clearActionError,
    onError: () => {
      setActionError("Could not update labels. Try again.");
    },
    onSuccess: invalidateLists,
  });

  const spamMutation = useMutation({
    mutationFn: (threadId: string) => spamMailThread(threadId),
    onMutate: clearActionError,
    onError: () => {
      setActionError("Could not report spam. Try again.");
    },
    onSuccess: () => {
      invalidateLists();
      setSelected(null);
    },
  });

  const filterMutation = useMutation({
    mutationFn: (input: { readonly from: string }) =>
      createMailFilter({
        name: `From ${input.from}`,
        enabled: true,
        criteria: { fromContains: input.from },
      }),
    onMutate: clearActionError,
    onError: () => {
      setActionError("Could not create filter. Try again.");
    },
    onSuccess: () => {
      // Brief success acknowledgement — clear any previous error
      clearActionError();
    },
  });

  const handleSelect = useCallback(
    (id: string) => {
      setSelected(id);
      const row = threads.find((thread) => thread.threadId === id);
      if (row?.unread === true) {
        readMutation.mutate({ threadId: id, unread: false });
      }
    },
    [readMutation, threads],
  );

  // Row-level hover actions
  const handleRowArchive = useCallback(
    (threadId: string) => {
      archiveMutation.mutate(threadId);
    },
    [archiveMutation],
  );

  const handleRowDelete = useCallback(
    (threadId: string) => {
      deleteMutation.mutate(threadId);
    },
    [deleteMutation],
  );

  const handleRowSnooze = useCallback(
    (threadId: string) => {
      snoozeMutation.mutate(threadId);
    },
    [snoozeMutation],
  );

  const handleRowToggleRead = useCallback(
    (thread: MailThreadRow) => {
      readMutation.mutate({ threadId: thread.threadId, unread: !thread.unread });
    },
    [readMutation],
  );

  // Bulk actions — apply to all checked IDs, then clear selection
  const handleBulkArchive = useCallback(
    (ids: ReadonlySet<string>) => {
      for (const threadId of ids) {
        archiveMutation.mutate(threadId);
      }
      setCheckedIds(new Set());
    },
    [archiveMutation],
  );

  const handleBulkDelete = useCallback(
    (ids: ReadonlySet<string>) => {
      for (const threadId of ids) {
        deleteMutation.mutate(threadId);
      }
      setCheckedIds(new Set());
    },
    [deleteMutation],
  );

  const handleBulkSpam = useCallback(
    (ids: ReadonlySet<string>) => {
      for (const threadId of ids) {
        spamMutation.mutate(threadId);
      }
      setCheckedIds(new Set());
    },
    [spamMutation],
  );

  const handleBulkRead = useCallback(
    (ids: ReadonlySet<string>, unread: boolean) => {
      for (const threadId of ids) {
        readMutation.mutate({ threadId, unread });
      }
      setCheckedIds(new Set());
    },
    [readMutation],
  );

  const handleBulkSnooze = useCallback(
    (ids: ReadonlySet<string>) => {
      for (const threadId of ids) {
        snoozeMutation.mutate(threadId);
      }
      setCheckedIds(new Set());
    },
    [snoozeMutation],
  );

  const handleBulkMove = useCallback(
    (ids: ReadonlySet<string>, folderId: MailFolderKey) => {
      // Move is implemented via archive (if target is archive) or a label move.
      // For now we use archiveMailThread for "archive" and delete for "trash".
      for (const threadId of ids) {
        if (folderId === "archive") {
          archiveMutation.mutate(threadId);
        } else if (folderId === "trash") {
          deleteMutation.mutate(threadId);
        } else if (folderId === "spam") {
          spamMutation.mutate(threadId);
        }
      }
      setCheckedIds(new Set());
    },
    [archiveMutation, deleteMutation, spamMutation],
  );

  const handleBulkLabel = useCallback(
    (ids: ReadonlySet<string>, labelSlug: string, add: boolean) => {
      for (const threadId of ids) {
        labelMutation.mutate({
          threadId,
          ...(add ? { add: [labelSlug] } : { remove: [labelSlug] }),
        });
      }
      setCheckedIds(new Set());
    },
    [labelMutation],
  );

  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["mail", "threads"] });
  }, [queryClient]);

  const handleMarkAllRead = useCallback(() => {
    const unreadThreads = threads.filter((t) => t.unread);
    for (const thread of unreadThreads) {
      readMutation.mutate({ threadId: thread.threadId, unread: false });
    }
  }, [readMutation, threads]);

  const handleBulkStar = useCallback(
    (ids: ReadonlySet<string>) => {
      for (const threadId of ids) {
        starMutation.mutate({ threadId, starred: true });
      }
      setCheckedIds(new Set());
    },
    [starMutation],
  );

  const handleBulkFilterLike = useCallback(
    (ids: ReadonlySet<string>) => {
      const firstId = [...ids][0];
      if (firstId === undefined) {
        return;
      }
      const firstThread = threads.find((t) => t.threadId === firstId);
      if (firstThread === undefined) {
        return;
      }
      filterMutation.mutate({ from: firstThread.fromEmail || firstThread.from });
      setCheckedIds(new Set());
    },
    [filterMutation, threads],
  );

  const actionBusy =
    archiveMutation.isPending ||
    deleteMutation.isPending ||
    snoozeMutation.isPending ||
    labelMutation.isPending ||
    spamMutation.isPending;

  return (
    <>
      <SurfaceFrame
        title="Mail"
        icon={<Icons.Mail />}
        searchPlaceholder="Search mail (try from:mira, has:attachment, label:urgent)"
        searchValue={query}
        onSearchChange={(next) => {
          setQuery(next);
          setOffset(0);
        }}
        actions={
          <button type="button" className="btn">
            <Icons.Filter /> Filters
          </button>
        }
      >
        <div style={{ display: "contents" }}>
          <MailSidebar
            folder={folder}
            onFolder={(next) => {
              setFolder(next);
              setSelected(null);
              setOffset(0);
              setCheckedIds(new Set());
            }}
            onCompose={() => {
              setComposeOpen(true);
            }}
            folders={folders}
            labels={labels}
            activeLabel={activeLabel}
            onLabel={(next) => {
              setActiveLabel(next);
              setSelected(null);
              setOffset(0);
              setCheckedIds(new Set());
            }}
          />
          {selectedRow != null ? (
            <ThreadView
              row={selectedRow}
              detail={threadDetailQuery.data}
              isLoading={threadDetailQuery.isLoading}
              isError={threadDetailQuery.isError}
              labelColors={labelColors}
              onClose={() => {
                setSelected(null);
              }}
              onArchive={() => {
                archiveMutation.mutate(selectedRow.threadId);
              }}
              onDelete={() => {
                deleteMutation.mutate(selectedRow.threadId);
              }}
              onSnooze={() => {
                snoozeMutation.mutate(selectedRow.threadId);
              }}
              onToggleLabel={() => {
                const firstLabel = labels[0];
                if (firstLabel === undefined) {
                  return;
                }
                const applied = (
                  threadDetailQuery.data?.labels ?? selectedRow.labels
                ).includes(firstLabel.slug);
                labelMutation.mutate({
                  threadId: selectedRow.threadId,
                  ...(applied
                    ? { remove: [firstLabel.slug] }
                    : { add: [firstLabel.slug] }),
                });
              }}
              actionBusy={actionBusy}
              actionError={actionError}
            />
          ) : (
            <ThreadList
              tab={tab}
              onTab={(next) => {
                setTab(next);
                setOffset(0);
              }}
              selected={selected}
              onSelect={handleSelect}
              threads={threads}
              folder={folder}
              query={query}
              onClearQuery={() => {
                setQuery("");
                setOffset(0);
              }}
              labelColors={labelColors}
              labels={labels}
              folders={folders}
              total={total}
              offset={offset}
              limit={PAGE_SIZE}
              onPage={setOffset}
              isLoading={threadsQuery.isLoading}
              isError={threadsQuery.isError}
              onToggleStar={(thread) => {
                starMutation.mutate({
                  threadId: thread.threadId,
                  starred: !thread.starred,
                });
              }}
              pendingThreadId={
                starMutation.isPending
                  ? (starMutation.variables?.threadId ?? null)
                  : null
              }
              onArchive={handleRowArchive}
              onDelete={handleRowDelete}
              onSnooze={handleRowSnooze}
              onToggleRead={handleRowToggleRead}
              checkedIds={checkedIds}
              onCheckedChange={setCheckedIds}
              onBulkArchive={handleBulkArchive}
              onBulkDelete={handleBulkDelete}
              onBulkSpam={handleBulkSpam}
              onBulkRead={handleBulkRead}
              onBulkSnooze={handleBulkSnooze}
              onBulkMove={handleBulkMove}
              onBulkLabel={handleBulkLabel}
              onRefresh={handleRefresh}
              onMarkAllRead={handleMarkAllRead}
              onBulkStar={handleBulkStar}
              onBulkFilterLike={handleBulkFilterLike}
            />
          )}
        </div>
      </SurfaceFrame>
      {composeOpen && (
        <Compose
          onClose={() => {
            setComposeOpen(false);
          }}
          onSent={invalidateLists}
        />
      )}
    </>
  );
}
