import { iconMap as Icons } from "@/components/icon-map";
import {
  Archive as ArchiveIcon,
  Bell as BellIcon,
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  Eye as EyeIcon,
  Folder as FolderIcon,
  Inbox as InboxIcon,
  Ellipsis as MoreIcon,
  RefreshCw as RefreshIcon,
  Search as SearchIcon,
  Clock as SnoozeIcon,
  Tag as TagIcon,
  Trash2 as TrashIcon,
  X as XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  type MailFolderKey,
  type MailFolderSummary,
  type MailLabelSummary,
  type MailThreadRow,
} from "./api";
import { MAIL_EMPTY_STATES, MAIL_TABS, type MailTabId } from "./mail-taxonomy";
import { ThreadRow } from "./mail-thread-row";
import { cx, restoreActionLabel } from "./mail-view-helpers";

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
    <div className="empty p-16">
      {icon}
      <div className="[font-size:var(--text-body)] font-medium text-foreground">{title}</div>
      <div>{body}</div>
      {children}
    </div>
  );
}

/* --------------------------------------------------------------- thread list */

type SelectAllSubset = "all" | "none" | "read" | "unread" | "starred" | "unstarred";

const SELECT_SUBSETS: ReadonlyArray<{ readonly label: string; readonly value: SelectAllSubset }> = [
  { label: "All", value: "all" },
  { label: "None", value: "none" },
  { label: "Read", value: "read" },
  { label: "Unread", value: "unread" },
  { label: "Starred", value: "starred" },
  { label: "Unstarred", value: "unstarred" },
];

interface ThreadListProps {
  readonly tab: MailTabId;
  readonly onTab: (tab: MailTabId) => void;
  /** Hide Primary/Updates/… tabs for exclusive label views. */
  readonly hideCategoryTabs?: boolean;
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
  readonly onRestore: (threadId: string) => void;
  readonly onToggleRead: (thread: MailThreadRow) => void;
  // Bulk
  readonly checkedIds: ReadonlySet<string>;
  readonly onCheckedChange: (ids: ReadonlySet<string>) => void;
  readonly onBulkArchive: (ids: ReadonlySet<string>) => void;
  readonly onBulkDelete: (ids: ReadonlySet<string>) => void;
  readonly onBulkSpam: (ids: ReadonlySet<string>) => void;
  readonly onBulkNotSpam: (ids: ReadonlySet<string>) => void;
  readonly onBulkRead: (ids: ReadonlySet<string>, unread: boolean) => void;
  readonly onBulkSnooze: (ids: ReadonlySet<string>) => void;
  readonly onBulkMove: (ids: ReadonlySet<string>, folderId: MailFolderKey) => void;
  readonly onBulkLabel: (ids: ReadonlySet<string>, labelSlug: string, add: boolean) => void;
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

function PagerControls({
  total,
  offset,
  limit,
  threadCount,
  isLoading,
  onPage,
}: PagerControlsProps) {
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = offset + threadCount;
  return (
    <span className="flex items-center gap-1 whitespace-nowrap shrink-0">
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
        <ChevronLeftIcon size={16} />
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
        <ChevronRightIcon size={16} />
      </button>
    </span>
  );
}

export function ThreadList({
  tab,
  onTab,
  hideCategoryTabs = false,
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
  onRestore,
  onToggleRead,
  checkedIds,
  onCheckedChange,
  onBulkArchive,
  onBulkDelete,
  onBulkSpam,
  onBulkNotSpam,
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
  const noResults = query.trim() !== "" && threads.length === 0 && !isEmptyFolder && !isLoading;

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
    const menus = [
      [selectDropRef, setSelectDropOpen],
      [idleMoreRef, setIdleMoreOpen],
      [moveMenuRef, setMoveMenuOpen],
      [labelsMenuRef, setLabelsMenuOpen],
      [bulkMoreRef, setBulkMoreOpen],
    ] as const;
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      for (const [ref, setOpen] of menus) {
        if (ref.current && !ref.current.contains(target)) {
          setOpen(false);
        }
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
  const checkedUnreadCount = threads.filter((t) => checkedIds.has(t.threadId) && t.unread).length;
  const majorityUnread = checkedUnreadCount >= checkedIds.size / 2;
  const bulkReadLabel = majorityUnread ? "Mark read" : "Mark unread";
  const bulkReadUnread = !majorityUnread;

  /* ---- Master checkbox + caret (shared by both toolbar states) ---- */
  const masterCheckboxSection = (
    <div className="mail-select-all-wrap" ref={selectDropRef}>
      <input
        type="checkbox"
        className="[accent-color:var(--accent)]"
        aria-label={hasBulk ? "Deselect all" : "Select all"}
        checked={allChecked}
        ref={(el) => {
          if (el) {
            el.indeterminate = someChecked;
          }
        }}
        onChange={
          hasBulk
            ? () => {
                onCheckedChange(new Set());
              }
            : handleMasterCheckbox
        }
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
        <ChevronDownIcon size={10} />
      </button>
      {selectDropOpen && (
        <div className="mail-select-dropdown" role="listbox" aria-label="Select subset">
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
    <div className="flex-1 min-w-0 bg-card flex flex-col">
      {/* ---- Single persistent toolbar strip (above the category tabs, Gmail-style) ---- */}
      <div
        className="mail-toolbar-strip"
        role="toolbar"
        aria-label={hasBulk ? "Bulk actions" : "Toolbar"}
      >
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
                <RefreshIcon size={16} /> Refresh
              </button>
              {query.trim() !== "" && (
                <span className="ml-1 [font-size:var(--text-caption)] flex items-center gap-1.5">
                  <span>Filtering by</span>
                  <span className="chip accent inline-flex items-center gap-1">
                    {query}
                    <button
                      type="button"
                      onClick={onClearQuery}
                      aria-label="Clear search"
                      className="inline-flex"
                    >
                      <XIcon size={10} />
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
                  onClick={() => {
                    setIdleMoreOpen((v) => !v);
                  }}
                >
                  <MoreIcon size={16} />
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
              <span className="mail-bulk-toolbar-count">{String(checkedIds.size)} selected</span>
              <div className="v-divider mail-toolbar-divider" />
              {/* Destructive group */}
              <button
                type="button"
                className="mail-bulk-btn"
                aria-label="Archive selected"
                onClick={() => {
                  onBulkArchive(checkedIds);
                }}
              >
                <ArchiveIcon size={16} /> Archive
              </button>
              {folder === "spam" ? (
                <button
                  type="button"
                  className="mail-bulk-btn"
                  aria-label="Not spam"
                  onClick={() => {
                    onBulkNotSpam(checkedIds);
                  }}
                >
                  <InboxIcon size={16} /> Not spam
                </button>
              ) : (
                <button
                  type="button"
                  className="mail-bulk-btn"
                  aria-label="Report spam"
                  onClick={() => {
                    onBulkSpam(checkedIds);
                  }}
                >
                  <BellIcon size={16} /> Report spam
                </button>
              )}
              <button
                type="button"
                className="mail-bulk-btn"
                aria-label="Delete selected"
                onClick={() => {
                  onBulkDelete(checkedIds);
                }}
              >
                <TrashIcon size={16} /> Delete
              </button>
              <div className="v-divider mail-toolbar-divider" />
              {/* State group */}
              <button
                type="button"
                className="mail-bulk-btn"
                aria-label={bulkReadLabel}
                onClick={() => {
                  onBulkRead(checkedIds, bulkReadUnread);
                }}
              >
                <EyeIcon size={16} /> {bulkReadLabel}
              </button>
              <button
                type="button"
                className="mail-bulk-btn"
                aria-label="Snooze selected"
                onClick={() => {
                  onBulkSnooze(checkedIds);
                }}
              >
                <SnoozeIcon size={16} /> Snooze
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
                  <FolderIcon size={16} /> Move to <ChevronDownIcon size={10} />
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
                  <TagIcon size={16} /> Labels <ChevronDownIcon size={10} />
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
                          <span className="mail-menu-label-dot" style={{ background: lbl.color }} />
                          {lbl.name}
                          {applied && (
                            <CheckIcon size={16} className="mail-menu-item-check ml-auto" />
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
                  <MoreIcon size={16} />
                </button>
                {bulkMoreOpen && (
                  <div
                    className="mail-menu-dropdown"
                    role="menu"
                    aria-label="More bulk actions menu"
                  >
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

      {hideCategoryTabs ? null : (
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
                <Icon size={16} /> {entry.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {isError && (
          <div className="[margin:8px_16px_0] [font-size:var(--text-caption)] text-destructive">
            Could not load mail from the server — showing offline data.
          </div>
        )}
        {isLoading && (
          <EmptyState
            icon={<InboxIcon size={16} />}
            title="Loading mail…"
            body="Fetching your threads."
          />
        )}
        {!isLoading && noResults && (
          <EmptyState
            icon={<SearchIcon size={16} />}
            title={`No results for "${query}"`}
            body={
              <>
                Try a different search or remove an operator like{" "}
                <span className="mono">from:</span> or <span className="mono">has:attachment</span>.
              </>
            }
          >
            <button
              type="button"
              className="btn sm mt-2"

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
                icon={<Icon size={16} />}
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
              restoreLabel={restoreActionLabel(folder)}
              onRestore={() => {
                onRestore(thread.threadId);
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
