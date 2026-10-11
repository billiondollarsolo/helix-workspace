/* Mail: sidebar, conversation list and conversation view, with the reading
   pane layout the person picked (no split, right of the list, below it).
   Searching looks across All Mail with Gmail-style operators. Every action
   updates the list at once and offers Undo (see use-mail-actions). */

import { SurfaceFrame } from "@/components/shell";
import { EmptyState } from "@/components/ui/empty-state";
import { sessionUserQueryOptions } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { useDebouncedCallback } from "@tanstack/react-pacer/debouncer";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail as MailIcon, MailOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type {
  MailFolderKey,
  MailLabelSummary,
  MailThreadDetail,
  MailThreadRow,
  MailThreadsListInput,
} from "./api";
import { collectThreadIds, type MailAction } from "./mail-actions";
import { Compose } from "./mail-compose";
import type { MoveTarget } from "./mail-menus";
import { useMailReadingPane, useMailShowAvatars } from "./mail-preferences";
import type { ReplyMode } from "./mail-reply-panel";
import { MailSearchOptions } from "./mail-search-options";
import "./mail-list.css";
import "./mail-shell.css";
import { MailSidebar, type MailDropTarget } from "./mail-sidebar";
import { ThreadList } from "./mail-thread-list";
import { ThreadView } from "./mail-thread-view";
import {
  mailFoldersQueryOptions,
  mailLabelsQueryOptions,
  mailThreadQueryOptions,
  mailThreadsQueryOptions,
} from "./queries";
import { useMailActions } from "./use-mail-actions";
import { useMailRealtime } from "./use-mail-realtime";
import { useMailShortcuts } from "./use-mail-shortcuts";
import { useMailUrlState } from "./use-mail-url-state";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const NARROW_QUERY = "(max-width: 760px)";

function narrowQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY) : null;
}

function useNarrowScreen(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = narrowQuery();
      query?.addEventListener("change", onChange);
      return () => query?.removeEventListener("change", onChange);
    },
    () => narrowQuery()?.matches ?? false,
    () => false,
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : "Check your connection and try again.";
}

/** A list row for a conversation opened from a link that is not on this page. */
function rowFromDetail(detail: MailThreadDetail, folder: MailFolderKey): MailThreadRow {
  const last = detail.messages.at(-1);
  return {
    threadId: detail.id,
    messageId: last?.id ?? detail.id,
    subject: detail.subject,
    from: last?.from?.name ?? last?.from?.address ?? "",
    fromEmail: last?.from?.address ?? "",
    preview: detail.preview,
    time: detail.lastActivity,
    unread: detail.unread,
    starred: detail.starred,
    hasAttachment: detail.messages.some((message) => message.hasAttachment),
    messageCount: detail.messages.length,
    labels: [...detail.labels],
    category: "primary",
    folder,
    snoozedUntil: detail.snoozedUntil,
    participants: [],
  };
}

/** The action that moves conversations from `folder` to `target`. */
function moveAction(folder: MailFolderKey, target: MoveTarget): MailAction {
  switch (target.kind) {
    case "spam":
      return { kind: "spam" };
    case "trash":
      return { kind: "trash" };
    case "label":
      return { kind: "moveToLabel", label: target.slug };
    case "inbox":
      if (folder === "trash") return { kind: "restore" };
      if (folder === "spam") return { kind: "notSpam" };
      if (folder === "snoozed") return { kind: "unsnooze" };
      return { kind: "unarchive" };
  }
}

export function MailShell() {
  const queryClient = useQueryClient();
  useMailRealtime(true);
  const [view, setView] = useMailUrlState();
  const { folder, tab, label, query, thread } = view;
  const [searchDraft, setSearchDraft] = useState(query);
  const [offset, setOffset] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyIntent, setReplyIntent] = useState<{
    readonly threadId: string;
    readonly mode: ReplyMode;
  } | null>(null);
  const narrow = useNarrowScreen();
  const savedPane = useMailReadingPane();
  const pane = narrow ? "none" : savedPane;
  const showAvatars = useMailShowAvatars();

  // A new view starts on its first page with nothing selected.
  const viewKey = `${folder}|${tab}|${label ?? ""}|${query}`;
  useEffect(() => {
    setOffset(0);
    setSelectedIds(new Set());
    setAllMatching(false);
  }, [viewKey]);

  // Typing searches after a short pause; Back/Forward to another query refills the box.
  useEffect(() => setSearchDraft((draft) => (draft.trim() === query ? draft : query)), [query]);
  const commitSearch = useDebouncedCallback(
    (next: string) => setView({ query: next.trim(), thread: null }),
    { wait: SEARCH_DEBOUNCE_MS },
  );

  const foldersQuery = useQuery(mailFoldersQueryOptions());
  const labelsQuery = useQuery(mailLabelsQueryOptions());
  const sessionQuery = useQuery(sessionUserQueryOptions());
  const labels = useMemo(() => labelsQuery.data ?? [], [labelsQuery.data]);
  const labelsBySlug = useMemo(() => new Map(labels.map((entry) => [entry.slug, entry])), [labels]);
  const activeLabel: MailLabelSummary | null =
    label === null
      ? null
      : (labelsBySlug.get(label) ?? {
          id: label,
          slug: label,
          name: label,
          color: "",
          colorName: "gray",
          parentId: null,
          sortOrder: 0,
          threadCount: 0,
          unreadCount: 0,
          shared: false,
        });

  // A label removed here or in Settings takes its view with it.
  const labelGone = label !== null && labelsQuery.isSuccess && !labelsBySlug.has(label);
  useEffect(() => {
    if (labelGone) setView({ label: null, thread: null });
  }, [labelGone, setView]);

  const threadsInput: MailThreadsListInput = useMemo(
    () => ({
      // Searches and label views cover All Mail; `in:` in the query narrows it.
      folder: query !== "" || label !== null ? "all" : folder,
      ...(query === "" && label === null && folder === "inbox" ? { tab } : {}),
      ...(query === "" && label !== null ? { label } : {}),
      ...(query === "" ? {} : { query }),
      limit: PAGE_SIZE,
      offset,
    }),
    [folder, label, offset, query, tab],
  );
  const threadsQuery = useQuery({
    ...mailThreadsQueryOptions(threadsInput),
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => threadsQuery.data?.threads ?? [], [threadsQuery.data]);
  const total = threadsQuery.data?.total ?? 0;

  const detailQuery = useQuery({
    ...mailThreadQueryOptions(thread ?? ""),
    enabled: thread !== null,
  });
  const openRow = useMemo(() => {
    if (thread === null) return null;
    const listed = rows.find((row) => row.threadId === thread);
    if (listed !== undefined) return listed;
    return detailQuery.data == null ? null : rowFromDetail(detailQuery.data, folder);
  }, [detailQuery.data, folder, rows, thread]);

  const actions = useMailActions({
    view: { folder, label, query },
    listKey: mailThreadsQueryOptions(threadsInput).queryKey,
    rows,
    labelName: (slug) => labelsBySlug.get(slug)?.name ?? slug,
    onLeave: (ids) => {
      if (thread !== null && ids.has(thread)) setView({ thread: null });
      setSelectedIds((current) => new Set([...current].filter((id) => !ids.has(id))));
    },
  });
  const { run } = actions;

  const onAction = useCallback(
    (ids: readonly string[], action: MailAction) => {
      void run(ids, action, action.kind === "star" ? { undoable: false, quiet: true } : {});
    },
    [run],
  );

  /** The selection, or every conversation the view matches after "Select all N". */
  const bulk = useCallback(
    (action: MailAction) => {
      const ids = [...selectedIds];
      setSelectedIds(new Set());
      setAllMatching(false);
      if (!allMatching) {
        onAction(ids, action);
        return;
      }
      void collectThreadIds({ ...threadsInput, offset: 0 }).then((all) => onAction(all, action));
    },
    [allMatching, onAction, selectedIds, threadsInput],
  );

  const openThread = useCallback(
    (row: MailThreadRow) => {
      setView({ thread: row.threadId });
      if (row.unread) void run([row.threadId], { kind: "read", unread: false }, { quiet: true });
    },
    [run, setView],
  );

  const reply = useCallback(
    (threadId: string, mode: ReplyMode) => {
      setReplyIntent({ threadId, mode });
      const row = rows.find((entry) => entry.threadId === threadId);
      if (row === undefined) setView({ thread: threadId });
      else openThread(row);
    },
    [openThread, rows, setView],
  );

  const drop = useCallback(
    (ids: readonly string[], target: MailDropTarget) => {
      if (target.kind === "label") {
        onAction(ids, { kind: "label", add: [target.slug], remove: [] });
        return;
      }
      const actionByFolder: Partial<Record<MailFolderKey, MailAction>> = {
        inbox: moveAction(folder, { kind: "inbox" }),
        starred: { kind: "star", starred: true },
        archive: { kind: "archive" },
        spam: { kind: "spam" },
        trash: { kind: "trash" },
      };
      const action = actionByFolder[target.folder];
      if (action !== undefined) void run(ids, action);
      setSelectedIds(new Set());
    },
    [folder, onAction, run],
  );

  const markAllRead = useCallback(() => {
    void collectThreadIds({
      ...threadsInput,
      offset: 0,
      query: `${threadsInput.query ?? ""} is:unread`.trim(),
    }).then((ids) => onAction(ids, { kind: "read", unread: false }));
  }, [onAction, threadsInput]);

  const goTo = (patch: { folder?: MailFolderKey; tab?: typeof tab; label?: string | null }) => {
    setSearchDraft("");
    setView({ folder: "inbox", tab: "primary", label: null, query: "", thread: null, ...patch });
  };

  const index = openRow === null ? -1 : rows.findIndex((row) => row.threadId === openRow.threadId);
  const newer = index > 0 ? rows[index - 1] : undefined;
  const older = index >= 0 ? rows[index + 1] : undefined;

  useMailShortcuts({
    threads: rows,
    openThreadId: openRow?.threadId ?? null,
    selectedIds,
    onSelectedChange: setSelectedIds,
    onCompose: () => setComposeOpen(true),
    onOpen: (threadId) => {
      const row = rows.find((entry) => entry.threadId === threadId);
      if (row !== undefined) openThread(row);
    },
    onBack: () => setView({ thread: null }),
    onAction,
    canReportSpam: folder !== "spam" || query !== "" || label !== null,
  });

  const list = (
    <ThreadList
      rows={rows}
      folder={query !== "" ? "all" : folder}
      tab={tab}
      onTab={(next) => setView({ tab: next, thread: null })}
      query={query}
      onClearSearch={() => {
        setSearchDraft("");
        setView({ query: "" });
      }}
      activeLabel={query === "" ? activeLabel : null}
      labels={labels}
      labelsBySlug={labelsBySlug}
      total={total}
      offset={offset}
      pageSize={PAGE_SIZE}
      onPage={setOffset}
      loading={threadsQuery.isPending}
      error={threadsQuery.isError ? errorText(threadsQuery.error) : null}
      retrying={threadsQuery.isFetching}
      onRetry={() =>
        void queryClient.invalidateQueries({
          queryKey: mailThreadsQueryOptions(threadsInput).queryKey,
        })
      }
      selectedIds={selectedIds}
      onSelectedChange={setSelectedIds}
      allMatching={allMatching}
      onAllMatchingChange={setAllMatching}
      openThreadId={pane === "none" ? null : thread}
      onOpen={openThread}
      onRefresh={() => void queryClient.invalidateQueries({ queryKey: ["mail"] })}
      onMarkAllRead={markAllRead}
      onCompose={() => setComposeOpen(true)}
      showAvatars={showAvatars}
      onAction={onAction}
      onSnooze={(ids, until) => onAction(ids, { kind: "snooze", until })}
      onMove={(ids, target) => onAction(ids, moveAction(folder, target))}
      onReply={reply}
      onBulkAction={bulk}
      onBulkMove={(target) => bulk(moveAction(folder, target))}
      onBulkSnooze={(until) => bulk({ kind: "snooze", until })}
    />
  );

  const conversation =
    openRow === null ? null : (
      <ThreadView
        key={openRow.threadId}
        row={openRow}
        detail={detailQuery.data}
        loading={detailQuery.isPending}
        error={detailQuery.isError ? errorText(detailQuery.error) : null}
        retrying={detailQuery.isFetching}
        onRetry={() =>
          void queryClient.invalidateQueries({
            queryKey: mailThreadQueryOptions(openRow.threadId).queryKey,
          })
        }
        folder={query !== "" ? "all" : folder}
        labels={labels}
        labelsBySlug={labelsBySlug}
        position={
          index === -1
            ? null
            : {
                index: offset + index + 1,
                total,
                onNewer: newer === undefined ? undefined : () => openThread(newer),
                onOlder: older === undefined ? undefined : () => openThread(older),
              }
        }
        myAddress={sessionQuery.data?.email ?? null}
        initialReply={replyIntent?.threadId === openRow.threadId ? replyIntent.mode : null}
        onBack={() => {
          setReplyIntent(null);
          setView({ thread: null });
        }}
        onAction={(action) => onAction([openRow.threadId], action)}
        onMarkUnread={() => {
          onAction([openRow.threadId], { kind: "read", unread: true });
          setView({ thread: null });
        }}
        onSnooze={(until) => onAction([openRow.threadId], { kind: "snooze", until })}
        onMove={(target) => onAction([openRow.threadId], moveAction(folder, target))}
      />
    );

  return (
    <>
      <SurfaceFrame
        title="Mail"
        icon={<MailIcon size={16} />}
        searchPlaceholder="Search mail"
        searchValue={searchDraft}
        onSearchChange={(next) => {
          setSearchDraft(next);
          commitSearch(next);
        }}
        onSearchSubmit={(next) => {
          setSearchDraft(next);
          setView({ query: next.trim(), thread: null });
        }}
        actions={
          <MailSearchOptions
            query={query}
            onSearch={(next) => {
              setSearchDraft(next);
              setView({ query: next, thread: null });
            }}
          />
        }
      >
        <h1 className="sr-only">Mail</h1>
        <MailSidebar
          activeFolder={query === "" && label === null ? folder : null}
          activeTab={tab}
          activeLabel={query === "" ? label : null}
          folders={foldersQuery.data ?? []}
          labels={labels}
          onFolder={(next) => goTo({ folder: next })}
          onCategory={(next) => goTo({ tab: next })}
          onLabel={(slug) => goTo({ label: slug })}
          onCompose={() => setComposeOpen(true)}
          onDrop={drop}
        />
        <div
          className={cn("mail-main", `mail-pane-${pane}`)}
          data-open={openRow === null ? undefined : true}
        >
          {pane === "none" ? (
            (conversation ?? list)
          ) : (
            <>
              {list}
              {conversation ?? (
                <div className="mail-pane-empty">
                  <EmptyState
                    icon={<MailOpen />}
                    title="No conversation selected"
                    body="Pick a conversation from the list to read it here."
                    size="inline"
                  />
                </div>
              )}
            </>
          )}
        </div>
      </SurfaceFrame>
      {composeOpen ? (
        <Compose
          onClose={() => setComposeOpen(false)}
          onSent={() => void queryClient.invalidateQueries({ queryKey: ["mail"] })}
        />
      ) : null}
    </>
  );
}
