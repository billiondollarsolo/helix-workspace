/* Runs mail actions the way people expect from a mail client: the list
   changes at once (optimistic), a snackbar confirms with Undo, `z` undoes the
   last action, and a failure puts the server's state back and says so. */

import { dismissNotification, notify } from "@/components/ui/toast";
import { useShortcuts } from "@/lib/shortcuts/use-shortcuts";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import type { MailThreadRow, MailThreadsListResult } from "./api";
import {
  actionFailure,
  actionMessage,
  inverseMailAction,
  leavesView,
  patchRow,
  performMailAction,
  runBatched,
  type MailAction,
  type MailView,
} from "./mail-actions";

const UNDO_TOAST_ID = "mail-undo";

interface MailActionsInput {
  readonly view: MailView;
  /** Query key of the list on screen; rows leave only this list optimistically. */
  readonly listKey: QueryKey;
  /** Rows currently loaded, for undo state. */
  readonly rows: readonly MailThreadRow[];
  readonly labelName: (slug: string) => string;
  /** Called with the ids that left the view, e.g. to close the open conversation. */
  readonly onLeave: (ids: ReadonlySet<string>) => void;
}

interface RunOptions {
  /** No snackbar (opening a thread marks it read quietly). */
  readonly quiet?: boolean;
  /** No Undo on the snackbar (stars). */
  readonly undoable?: boolean;
}

interface MailActions {
  readonly run: (ids: Iterable<string>, action: MailAction, options?: RunOptions) => Promise<void>;
  /** Undo the most recent action, if it can still be undone. */
  readonly undo: () => boolean;
}

export function useMailActions(input: MailActionsInput): MailActions {
  const queryClient = useQueryClient();
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  });
  const undoRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["mail", "threads"] });
    void queryClient.invalidateQueries({ queryKey: ["mail", "thread"] });
    void queryClient.invalidateQueries({ queryKey: ["mail", "folders"] });
    void queryClient.invalidateQueries({ queryKey: ["mail", "labels"] });
  }, [queryClient]);

  const applyOptimistic = useCallback(
    (ids: ReadonlySet<string>, action: MailAction) => {
      const { view, listKey } = inputRef.current;
      void queryClient.cancelQueries({ queryKey: ["mail", "threads"] });
      queryClient.setQueriesData<MailThreadsListResult>(
        { queryKey: ["mail", "threads"] },
        (list) =>
          list === undefined
            ? list
            : {
                ...list,
                threads: list.threads.map((row) =>
                  ids.has(row.threadId) ? patchRow(row, action) : row,
                ),
              },
      );
      if (leavesView(action, view)) {
        queryClient.setQueryData<MailThreadsListResult>(listKey, (list) => {
          if (list === undefined) return list;
          const threads = list.threads.filter((row) => !ids.has(row.threadId));
          return {
            ...list,
            threads,
            total: Math.max(0, list.total - (list.threads.length - threads.length)),
          };
        });
        inputRef.current.onLeave(ids);
      }
    },
    [queryClient],
  );

  const undoAll = useCallback(
    async (
      ids: readonly string[],
      action: MailAction,
      before: ReadonlyMap<string, MailThreadRow>,
    ) => {
      const inverses = ids
        .map((id) => ({ id, inverse: inverseMailAction(action, before.get(id)) }))
        .filter((entry): entry is { id: string; inverse: MailAction } => entry.inverse !== null);
      for (const { id, inverse } of inverses) applyOptimistic(new Set([id]), inverse);
      const failed = await runBatched(
        inverses.map((entry) => entry.id),
        (id) => {
          const entry = inverses.find((candidate) => candidate.id === id);
          return entry === undefined ? Promise.resolve() : performMailAction(entry.inverse, id);
        },
      );
      refresh();
      notify(
        failed.length > 0
          ? { message: "Couldn't undo that action.", tone: "error", id: UNDO_TOAST_ID }
          : { message: "Action undone", id: UNDO_TOAST_ID },
      );
    },
    [applyOptimistic, refresh],
  );

  const run = useCallback(
    async (idList: Iterable<string>, action: MailAction, options: RunOptions = {}) => {
      const ids = [...new Set(idList)];
      if (ids.length === 0) return;
      const before = new Map(
        inputRef.current.rows
          .filter((row) => ids.includes(row.threadId))
          .map((row) => [row.threadId, row]),
      );
      applyOptimistic(new Set(ids), action);
      const pending = runBatched(ids, (id) => performMailAction(action, id));
      // The snackbar and `z` are available at once; Undo waits for the action to land first.
      let undo: (() => void) | null = null;
      if (options.quiet !== true) {
        const message = actionMessage(action, ids.length, inputRef.current.labelName);
        if (options.undoable === false) {
          undoRef.current = null;
          notify({ message, id: UNDO_TOAST_ID });
        } else {
          const undoThis = () => {
            undoRef.current = null;
            dismissNotification(UNDO_TOAST_ID);
            void pending.then((failed) =>
              undoAll(
                ids.filter((id) => !failed.includes(id)),
                action,
                before,
              ),
            );
          };
          undo = undoThis;
          undoRef.current = undoThis;
          notify({
            message,
            id: UNDO_TOAST_ID,
            action: { label: "Undo", onAction: undoThis },
            onClose: (reason) => {
              if (reason !== "action" && undoRef.current === undoThis) undoRef.current = null;
            },
          });
        }
      }
      const failed = await pending;
      refresh();
      if (failed.length > 0) {
        if (undo !== null && undoRef.current === undo) undoRef.current = null;
        notify({
          id: UNDO_TOAST_ID,
          message: actionFailure(action, failed.length),
          description: "Check your connection and try again.",
          tone: "error",
          action: { label: "Retry", onAction: () => void run(failed, action, options) },
        });
      }
    },
    [applyOptimistic, refresh, undoAll],
  );

  const undo = useCallback(() => {
    const pending = undoRef.current;
    if (pending === null) return false;
    pending();
    return true;
  }, []);

  useShortcuts("mail", { "mail.undo": () => (undo() ? undefined : false) });

  return { run, undo };
}
