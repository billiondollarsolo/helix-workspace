import { SurfaceFrame } from "@/components/shell";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Mail as MailIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyMailLabels,
  archiveMailThread,
  createMailFilter,
  deleteMailThread,
  setMailThreadRead,
  setMailThreadStarred,
  snoozeMailThread,
  spamMailThread,
  unspamMailThread,
  type MailFolderKey,
  type MailThreadRow,
} from "./api";
import { Compose } from "./mail-compose";
import "./mail-shell.css";
import { MailSidebar } from "./mail-sidebar";
import { type MailTabId } from "./mail-taxonomy";
import { ThreadList } from "./mail-thread-list";
import { ThreadView } from "./mail-thread-view";
import { isBetaSpamCatch, restoreActionLabel, reverseMailboxState } from "./mail-view-helpers";
import {
  mailFoldersQueryOptions,
  mailLabelsQueryOptions,
  mailThreadQueryOptions,
  mailThreadsQueryOptions,
} from "./queries";
import { useMailRealtime } from "./use-mail-realtime";

/* ------------------------------------------------------------------- shell */

const PAGE_SIZE = 50;

export function MailShell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Push-driven inbox: SSE invalidates mail queries on activity.mail.* events.
  useMailRealtime(true);
  // URL-hydrated initial values — back button restores the prior view.
  const urlSearch: Partial<{
    folder: string;
    tab: MailTabId;
    thread: string;
    q: string;
    label: string;
  }> = useSearch({ strict: false });
  const [folder, setFolder] = useState<MailFolderKey>(
    (urlSearch.folder as MailFolderKey | undefined) ?? "inbox",
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
        // Label views are exclusive — omit folder/tab so URL is ?label=…
        ...(activeLabel
          ? { label: activeLabel }
          : {
              ...(folder === "inbox" ? {} : { folder }),
              ...(tab === "primary" ? {} : { tab }),
            }),
        ...(selected ? { thread: selected } : {}),
        ...(query.length === 0 ? {} : { q: query }),
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
  }, [urlSearch.folder, urlSearch.tab, urlSearch.thread, urlSearch.q, urlSearch.label]);
  const [offset, setOffset] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  // Checked (bulk-select) thread IDs
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());

  const foldersQuery = useQuery(mailFoldersQueryOptions());
  const labelsQuery = useQuery(mailLabelsQueryOptions());

  // Label view is exclusive of folder tabs: labeled mail often lives outside
  // Primary (e.g. Finance → Updates). Applying inbox+primary+label empties the list
  // while the label still shows a non-zero count.
  const threadsInput = useMemo(
    () => ({
      folder: activeLabel !== null ? "inbox" : folder,
      // Skip category tabs whenever a label filter is active.
      tab: activeLabel === null && folder === "inbox" ? tab : undefined,
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

  const labelColors = useMemo(() => new Map(labels.map((label) => [label.slug, label])), [labels]);

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

  const restoreMutation = useMutation({
    mutationFn: (threadId: string) => reverseMailboxState(folder, threadId),
    onMutate: clearActionError,
    onError: () => {
      setActionError("Could not restore the thread. Try again.");
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

  const notSpamMutation = useMutation({
    mutationFn: (threadId: string) => unspamMailThread(threadId),
    onMutate: clearActionError,
    onError: () => {
      setActionError("Could not mark as not spam. Try again.");
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

  const handleRowRestore = useCallback(
    (threadId: string) => {
      restoreMutation.mutate(threadId);
    },
    [restoreMutation],
  );

  const handleRowToggleRead = useCallback(
    (thread: MailThreadRow) => {
      readMutation.mutate({ threadId: thread.threadId, unread: !thread.unread });
    },
    [readMutation],
  );

  // Bulk actions — apply to all checked IDs, then clear selection
  const runBulk = useCallback((ids: ReadonlySet<string>, apply: (threadId: string) => void) => {
    for (const threadId of ids) {
      apply(threadId);
    }
    setCheckedIds(new Set());
  }, []);

  const handleBulkArchive = useCallback(
    (ids: ReadonlySet<string>) => {
      runBulk(ids, (threadId) => archiveMutation.mutate(threadId));
    },
    [archiveMutation, runBulk],
  );

  const handleBulkDelete = useCallback(
    (ids: ReadonlySet<string>) => {
      runBulk(ids, (threadId) => deleteMutation.mutate(threadId));
    },
    [deleteMutation, runBulk],
  );

  const handleBulkSpam = useCallback(
    (ids: ReadonlySet<string>) => {
      runBulk(ids, (threadId) => spamMutation.mutate(threadId));
    },
    [spamMutation, runBulk],
  );

  const handleBulkNotSpam = useCallback(
    (ids: ReadonlySet<string>) => {
      runBulk(ids, (threadId) => notSpamMutation.mutate(threadId));
    },
    [notSpamMutation, runBulk],
  );

  const handleBulkRead = useCallback(
    (ids: ReadonlySet<string>, unread: boolean) => {
      runBulk(ids, (threadId) => readMutation.mutate({ threadId, unread }));
    },
    [readMutation, runBulk],
  );

  const handleBulkSnooze = useCallback(
    (ids: ReadonlySet<string>) => {
      runBulk(ids, (threadId) => snoozeMutation.mutate(threadId));
    },
    [snoozeMutation, runBulk],
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
        } else if (folderId === "inbox") {
          // Moving out of spam (or generic restore to inbox) clears spam flag.
          notSpamMutation.mutate(threadId);
        }
      }
      setCheckedIds(new Set());
    },
    [archiveMutation, deleteMutation, spamMutation, notSpamMutation],
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
    restoreMutation.isPending ||
    labelMutation.isPending ||
    spamMutation.isPending ||
    notSpamMutation.isPending;

  return (
    <>
      <SurfaceFrame
        title="Mail"
        icon={<MailIcon size={16} />}
        searchPlaceholder="Search mail (try from:mira, has:attachment, label:urgent)"
        searchValue={query}
        onSearchChange={(next) => {
          setQuery(next);
          setOffset(0);
        }}
      >
        <div className="[display:contents]">
          <h1 className="sr-only">Mail</h1>
          <MailSidebar
            folder={folder}
            onFolder={(next) => {
              // Folder view is exclusive of labels.
              setFolder(next);
              setActiveLabel(null);
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
              // Label view is exclusive of folder chrome (inbox stays data scope only).
              setActiveLabel(next);
              if (next !== null) {
                setFolder("inbox");
              }
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
              restoreLabel={restoreActionLabel(folder)}
              onRestore={() => {
                restoreMutation.mutate(selectedRow.threadId);
              }}
              onToggleLabel={() => {
                const firstLabel = labels[0];
                if (firstLabel === undefined) {
                  return;
                }
                const applied = (threadDetailQuery.data?.labels ?? selectedRow.labels).includes(
                  firstLabel.slug,
                );
                labelMutation.mutate({
                  threadId: selectedRow.threadId,
                  ...(applied ? { remove: [firstLabel.slug] } : { add: [firstLabel.slug] }),
                });
              }}
              onReportSpam={
                folder === "spam"
                  ? undefined
                  : () => {
                      spamMutation.mutate(selectedRow.threadId);
                    }
              }
              onNotSpam={
                folder === "spam"
                  ? () => {
                      notSpamMutation.mutate(selectedRow.threadId);
                    }
                  : undefined
              }
              onConfirmAiSpam={
                folder === "spam" && isBetaSpamCatch(selectedRow)
                  ? () => {
                      // Re-affirm spam so durable feedback records user agreement with AI/rules.
                      spamMutation.mutate(selectedRow.threadId);
                    }
                  : undefined
              }
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
              hideCategoryTabs={activeLabel !== null}
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
                starMutation.isPending ? (starMutation.variables?.threadId ?? null) : null
              }
              onArchive={handleRowArchive}
              onDelete={handleRowDelete}
              onSnooze={handleRowSnooze}
              onRestore={handleRowRestore}
              onToggleRead={handleRowToggleRead}
              checkedIds={checkedIds}
              onCheckedChange={setCheckedIds}
              onBulkArchive={handleBulkArchive}
              onBulkDelete={handleBulkDelete}
              onBulkSpam={handleBulkSpam}
              onBulkNotSpam={handleBulkNotSpam}
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
