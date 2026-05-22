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
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons, type IconName } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { SurfaceFrame } from "@/components/shell";
import {
  applyMailLabels,
  archiveMailThread,
  deleteMailThread,
  replyToMail,
  sendMail,
  setMailThreadRead,
  setMailThreadStarred,
  snoozeMailThread,
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
  MAIL_FOLDERS,
  MAIL_LABELS,
  MAIL_TABS,
  MAIL_THREADS,
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

/* ----------------------------------------------------------- seed fallback */

/** Seed folder summaries — used only when `mail.folders.list` fails. */
const FALLBACK_FOLDERS: readonly MailFolderSummary[] = MAIL_FOLDERS.map((folder) => ({
  id: folder.id,
  label: folder.label,
  total: folder.count ?? 0,
  unread: folder.count ?? 0,
}));

/** Seed labels — used only when `mail.labels.list` fails. */
const FALLBACK_LABELS: readonly MailLabelSummary[] = MAIL_LABELS.map((label, index) => ({
  id: label.id,
  slug: label.id,
  name: label.label,
  color: label.color,
  sortOrder: index,
  threadCount: 0,
  shared: true,
}));

/** Seed threads projected into the backend row shape — used only on failure. */
function fallbackThreadRows(
  folder: MailFolderKey,
  tab: MailTabId,
  label: string | null,
  query: string,
): readonly MailThreadRow[] {
  const trimmed = query.trim().toLowerCase();
  const tokens = trimmed === "" ? [] : (trimmed.match(/\S+/g) ?? []);
  return MAIL_THREADS.filter((thread) => {
    if (folder === "starred") {
      if (thread.starred !== true) {
        return false;
      }
    } else if (folder !== "inbox") {
      return false;
    } else if (thread.tab !== tab) {
      return false;
    }
    if (label != null && !thread.labels.includes(label)) {
      return false;
    }
    if (tokens.length > 0) {
      const haystack = [thread.from, thread.subject, thread.preview, thread.body ?? ""]
        .join(" ")
        .toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) {
        return false;
      }
    }
    return true;
  }).map((thread) => ({
    threadId: thread.id,
    messageId: thread.id,
    subject: thread.subject,
    from: thread.from,
    fromEmail: thread.fromEmail ?? "",
    preview: thread.preview,
    time: thread.time,
    unread: thread.unread === true,
    starred: thread.starred === true,
    hasAttachment: thread.hasAttachment === true,
    messageCount: thread.count ?? 1,
    labels: thread.labels,
    category: thread.tab,
    folder,
    snoozedUntil: null,
  }));
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
    <aside
      style={{
        width: 184,
        flexShrink: 0,
        borderRight: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        padding: "10px 8px",
        minHeight: 0,
      }}
    >
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
              onClick={() => {
                onFolder(entry.id);
              }}
              aria-current={active ? "true" : undefined}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                height: "var(--rd-list-row-h)",
                padding: "0 10px",
                borderRadius: 6,
                fontSize: "var(--rd-row-fs)",
                background: active ? "var(--accent-soft)" : "transparent",
                color: active ? "var(--accent)" : "var(--text)",
                fontWeight: active ? 600 : 400,
              }}
            >
              <Icon />
              <span style={{ flex: 1, textAlign: "left" }}>{entry.label}</span>
              {badge > 0 && (
                <span style={{ fontSize: 11, color: "var(--text-3)" }}>{badge}</span>
              )}
            </button>
          );
        })}
        <div className="section-label">Labels</div>
        {labels.map((label) => {
          const active = activeLabel === label.slug;
          return (
            <button
              key={label.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                onLabel(active ? null : label.slug);
              }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                height: "var(--rd-list-row-h)",
                padding: "0 10px",
                borderRadius: 6,
                fontSize: "var(--rd-row-fs)",
                background: active ? "var(--accent-soft)" : "transparent",
                color: active ? "var(--accent)" : "var(--text)",
                fontWeight: active ? 600 : 400,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: label.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, textAlign: "left" }}>{label.name}</span>
              {label.threadCount > 0 && (
                <span style={{ fontSize: 11, color: "var(--text-3)" }}>
                  {label.threadCount}
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 10,
            height: "var(--rd-list-row-h)",
            padding: "0 10px",
            borderRadius: 6,
            fontSize: "var(--rd-row-fs)",
            color: "var(--text-3)",
          }}
        >
          <Icons.Plus />
          <span>New label</span>
        </button>
        <div className="section-label">Filters</div>
        <div style={{ padding: "0 10px" }}>
          <span className="chip" style={{ fontSize: 10 }}>
            has:attachment
          </span>
        </div>
      </div>
    </aside>
  );
}

/* --------------------------------------------------------------- thread row */

interface ThreadRowProps {
  readonly thread: MailThreadRow;
  readonly selected: boolean;
  readonly labelColors: ReadonlyMap<string, MailLabelSummary>;
  readonly onClick: () => void;
  readonly onToggleStar: () => void;
  readonly busy: boolean;
}

function ThreadRow({
  thread,
  selected,
  labelColors,
  onClick,
  onToggleStar,
  busy,
}: ThreadRowProps) {
  const labels = thread.labels
    .map((slug) => labelColors.get(slug))
    .filter((label): label is MailLabelSummary => label != null);

  return (
    <div
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
        background: selected ? "var(--accent-soft)" : "transparent",
        transition: "background 0.08s",
        fontSize: "var(--rd-row-fs)",
        minHeight: "var(--rd-list-row-h)",
      }}
      onMouseEnter={(event) => {
        if (!selected) {
          event.currentTarget.style.background = "var(--hover)";
        }
      }}
      onMouseLeave={(event) => {
        if (!selected) {
          event.currentTarget.style.background = "transparent";
        }
      }}
    >
      <input
        type="checkbox"
        aria-label={`Select ${thread.subject}`}
        onClick={(event) => {
          event.stopPropagation();
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
              fontSize: 10,
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
      <span
        style={{
          fontSize: 11,
          fontWeight: thread.unread ? 600 : 400,
          color: thread.unread ? "var(--text-2)" : "var(--text-3)",
          display: "flex",
          alignItems: "center",
          gap: 6,
          whiteSpace: "nowrap",
        }}
      >
        {thread.hasAttachment && <Icons.Paperclip />}
        <span>{formatThreadTime(thread.time)}</span>
      </span>
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
      <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text)" }}>{title}</div>
      <div>{body}</div>
      {children}
    </div>
  );
}

/* --------------------------------------------------------------- thread list */

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
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly onPage: (offset: number) => void;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly onToggleStar: (thread: MailThreadRow) => void;
  readonly pendingThreadId: string | null;
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
  total,
  offset,
  limit,
  onPage,
  isLoading,
  isError,
  onToggleStar,
  pendingThreadId,
}: ThreadListProps) {
  const emptyState = MAIL_EMPTY_STATES[folder];
  const isEmptyFolder = emptyState != null && threads.length === 0 && !isLoading;
  const noResults =
    query.trim() !== "" && threads.length === 0 && !isEmptyFolder && !isLoading;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = offset + threads.length;

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
      <div
        style={{
          height: 36,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 8,
          borderBottom: "1px solid var(--border)",
          color: "var(--text-3)",
          fontSize: 12,
        }}
      >
        <input
          type="checkbox"
          style={{ accentColor: "var(--accent)" }}
          aria-label="Select all"
        />
        <button type="button" className="icon-btn" aria-label="Filter">
          <Icons.Filter />
        </button>
        <button type="button" className="icon-btn" aria-label="More actions">
          <Icons.More />
        </button>
        {query.trim() !== "" && (
          <span
            style={{
              marginLeft: 4,
              fontSize: 11,
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
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 4,
            whiteSpace: "nowrap",
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
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {isError && (
          <div
            style={{
              margin: "8px 16px 0",
              fontSize: 11,
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
              selected={selected === thread.threadId}
              labelColors={labelColors}
              onClick={() => {
                onSelect(thread.threadId);
              }}
              onToggleStar={() => {
                onToggleStar(thread);
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
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)" }}>
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
              style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600, lineHeight: 1.35 }}
            >
              {subject}
            </h1>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {labels.map((label) => (
                <span
                  key={label.id}
                  style={{
                    fontSize: 11,
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
            <div style={{ marginBottom: 12, fontSize: 11, color: "var(--danger)" }}>
              Could not load the full conversation — showing the list preview.
            </div>
          )}
          {actionError != null && (
            <div style={{ marginBottom: 12, fontSize: 11, color: "var(--danger)" }}>
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
                fontSize: 12,
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
                fontSize: 13,
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
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{msgSender}</span>
                      <span style={{ fontSize: 11, color: "var(--text-3)" }}>
                        {message.from?.address ?? row.fromEmail}
                      </span>
                      <span
                        style={{
                          marginLeft: "auto",
                          fontSize: 11,
                          color: "var(--text-3)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatThreadTime(message.sentAt)}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 11,
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
                      style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.6 }}
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
                            fontSize: 12,
                          }}
                        >
                          <Icons.Doc />
                          <div>
                            <div style={{ fontWeight: 500 }}>Attachment</div>
                            <div style={{ fontSize: 10, color: "var(--text-3)" }}>
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
                  fontSize: 12,
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
                  <span style={{ fontSize: 12, color: "var(--text-3)", width: 50 }}>
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
                  fontSize: 13,
                  lineHeight: 1.55,
                  resize: "vertical",
                  fontFamily: "inherit",
                }}
              />
              {replyFailed && (
                <div
                  style={{
                    margin: "0 14px 8px",
                    fontSize: 11,
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
          <span style={{ fontSize: 12, color: "var(--text-3)", width: 50 }}>To</span>
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
              fontSize: 13,
            }}
          />
          <button
            type="button"
            aria-pressed={showCc}
            onClick={() => {
              setShowCc((value) => !value);
            }}
            style={{ fontSize: 11, color: "var(--text-3)" }}
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
            style={{ fontSize: 11, color: "var(--text-3)" }}
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
            <span style={{ fontSize: 12, color: "var(--text-3)", width: 50 }}>Cc</span>
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
                fontSize: 13,
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
            <span style={{ fontSize: 12, color: "var(--text-3)", width: 50 }}>Bcc</span>
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
                fontSize: 13,
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
              fontSize: 13,
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
          fontSize: 13,
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
        <div style={{ margin: "0 14px 8px", fontSize: 11, color: "var(--danger)" }}>
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
            fontSize: 12,
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
  const [folder, setFolder] = useState<MailFolderKey>("inbox");
  const [tab, setTab] = useState<MailTabId>("primary");
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);

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

  const folders = foldersQuery.isError
    ? FALLBACK_FOLDERS
    : (foldersQuery.data ?? FALLBACK_FOLDERS);
  const labels = labelsQuery.isError
    ? FALLBACK_LABELS
    : (labelsQuery.data ?? FALLBACK_LABELS);

  const threadsResult = threadsQuery.data;
  const threads = threadsQuery.isError
    ? fallbackThreadRows(folder, tab, activeLabel, query)
    : (threadsResult?.threads ?? []);
  const total = threadsQuery.isError
    ? threads.length
    : (threadsResult?.total ?? 0);

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

  const actionBusy =
    archiveMutation.isPending ||
    deleteMutation.isPending ||
    snoozeMutation.isPending ||
    labelMutation.isPending;

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
