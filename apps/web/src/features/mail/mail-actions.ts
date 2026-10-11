/* Mail actions as data: what each one calls, how it changes a row on screen,
   whether the row leaves the current view, what the snackbar says, and the
   action that undoes it. `use-mail-actions.ts` runs them. */

import {
  applyMailLabels,
  archiveMailThread,
  deleteMailThread,
  listMailThreads,
  restoreMailThread,
  setMailThreadRead,
  setMailThreadStarred,
  snoozeMailThread,
  spamMailThread,
  unarchiveMailThread,
  unsnoozeMailThread,
  unspamMailThread,
  type MailFolderKey,
  type MailThreadRow,
  type MailThreadsListInput,
} from "./api";

export type MailAction =
  | { readonly kind: "archive" }
  | { readonly kind: "unarchive" }
  | { readonly kind: "trash" }
  | { readonly kind: "restore" }
  | { readonly kind: "spam" }
  | { readonly kind: "notSpam" }
  | { readonly kind: "read"; readonly unread: boolean }
  | { readonly kind: "snooze"; readonly until: string }
  | { readonly kind: "unsnooze" }
  | { readonly kind: "label"; readonly add: readonly string[]; readonly remove: readonly string[] }
  /** "Move to <label>": label it and take it out of the Inbox. */
  | { readonly kind: "moveToLabel"; readonly label: string }
  | { readonly kind: "moveFromLabel"; readonly label: string }
  | { readonly kind: "star"; readonly starred: boolean };

/** What the list on screen is showing, which decides whether a row leaves it. */
export interface MailView {
  readonly folder: MailFolderKey;
  readonly label: string | null;
  readonly query: string;
}

export async function performMailAction(action: MailAction, threadId: string): Promise<void> {
  switch (action.kind) {
    case "archive":
      return archiveMailThread(threadId);
    case "unarchive":
      return unarchiveMailThread(threadId);
    case "trash":
      return deleteMailThread(threadId);
    case "restore":
      return restoreMailThread(threadId);
    case "spam":
      return spamMailThread(threadId);
    case "notSpam":
      return unspamMailThread(threadId);
    case "read":
      return setMailThreadRead({ threadId, unread: action.unread });
    case "snooze":
      return snoozeMailThread({ threadId, until: action.until });
    case "unsnooze":
      return unsnoozeMailThread(threadId);
    case "label":
      return applyMailLabels({ threadId, add: action.add, remove: action.remove });
    case "moveToLabel":
      await applyMailLabels({ threadId, add: [action.label] });
      return archiveMailThread(threadId);
    case "moveFromLabel":
      await applyMailLabels({ threadId, remove: [action.label] });
      return unarchiveMailThread(threadId);
    case "star":
      return setMailThreadStarred({ threadId, starred: action.starred });
  }
}

/** The action that puts one thread back the way it was before `action`. */
export function inverseMailAction(
  action: MailAction,
  before: MailThreadRow | undefined,
): MailAction | null {
  switch (action.kind) {
    case "archive":
      return { kind: "unarchive" };
    case "unarchive":
      return { kind: "archive" };
    case "trash":
      return { kind: "restore" };
    case "restore":
      return { kind: "trash" };
    case "spam":
      return { kind: "notSpam" };
    case "notSpam":
      return { kind: "spam" };
    case "read":
      return { kind: "read", unread: before?.unread ?? !action.unread };
    case "snooze":
      return before?.snoozedUntil != null
        ? { kind: "snooze", until: before.snoozedUntil }
        : { kind: "unsnooze" };
    case "unsnooze":
      return before?.snoozedUntil != null ? { kind: "snooze", until: before.snoozedUntil } : null;
    case "label": {
      const had = new Set(before?.labels ?? []);
      return {
        kind: "label",
        add: action.remove.filter((slug) => had.has(slug)),
        remove: action.add.filter((slug) => !had.has(slug)),
      };
    }
    case "moveToLabel":
      return { kind: "moveFromLabel", label: action.label };
    case "moveFromLabel":
      return { kind: "moveToLabel", label: action.label };
    case "star":
      return { kind: "star", starred: before?.starred ?? !action.starred };
  }
}

/** Whether the row stops belonging in the list on screen after `action`. */
export function leavesView(action: MailAction, view: MailView): boolean {
  if (view.query !== "") {
    return action.kind === "trash" || action.kind === "spam";
  }
  if (view.label !== null) {
    return (
      action.kind === "trash" ||
      action.kind === "spam" ||
      (action.kind === "label" && action.remove.includes(view.label))
    );
  }
  switch (action.kind) {
    case "archive":
    case "moveToLabel":
    case "snooze":
      return view.folder === "inbox";
    case "unarchive":
    case "moveFromLabel":
      return view.folder === "archive";
    case "trash":
      return view.folder !== "trash";
    case "restore":
      return view.folder === "trash";
    case "spam":
      return view.folder !== "spam";
    case "notSpam":
      return view.folder === "spam";
    case "unsnooze":
      return view.folder === "snoozed";
    case "star":
      return view.folder === "starred" && !action.starred;
    case "label":
    case "read":
      return false;
  }
}

/** The row as it looks right after `action`, for an optimistic update. */
export function patchRow(row: MailThreadRow, action: MailAction): MailThreadRow {
  switch (action.kind) {
    case "read":
      return { ...row, unread: action.unread };
    case "star":
      return { ...row, starred: action.starred };
    case "snooze":
      return { ...row, snoozedUntil: action.until };
    case "unsnooze":
      return { ...row, snoozedUntil: null };
    case "label":
      return {
        ...row,
        labels: [
          ...row.labels.filter((slug) => !action.remove.includes(slug)),
          ...action.add.filter((slug) => !row.labels.includes(slug)),
        ],
      };
    case "moveToLabel":
      return row.labels.includes(action.label)
        ? row
        : { ...row, labels: [...row.labels, action.label] };
    case "moveFromLabel":
      return { ...row, labels: row.labels.filter((slug) => slug !== action.label) };
    default:
      return row;
  }
}

const SNOOZE_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function conversations(count: number): string {
  return count === 1 ? "Conversation" : `${String(count)} conversations`;
}

/** Snackbar text, e.g. "3 conversations archived". `labelName` resolves slugs. */
export function actionMessage(
  action: MailAction,
  count: number,
  labelName: (slug: string) => string = (slug) => slug,
): string {
  const subject = conversations(count);
  switch (action.kind) {
    case "archive":
      return `${subject} archived`;
    case "unarchive":
    case "restore":
      return `${subject} moved to Inbox`;
    case "trash":
      return `${subject} moved to Trash`;
    case "spam":
      return `${subject} reported as spam`;
    case "notSpam":
      return `${subject} marked as not spam`;
    case "read":
      return `${subject} marked as ${action.unread ? "unread" : "read"}`;
    case "snooze":
      return `${subject} snoozed until ${SNOOZE_TIME.format(new Date(action.until))}`;
    case "unsnooze":
      return `${subject} unsnoozed`;
    case "label": {
      const [added] = action.add;
      const [removed] = action.remove;
      if (action.add.length === 1 && action.remove.length === 0 && added !== undefined) {
        return `${subject} labelled "${labelName(added)}"`;
      }
      if (action.remove.length === 1 && action.add.length === 0 && removed !== undefined) {
        return `Label "${labelName(removed)}" removed`;
      }
      return "Labels updated";
    }
    case "moveToLabel":
      return `${subject} moved to "${labelName(action.label)}"`;
    case "moveFromLabel":
      return `${subject} moved to Inbox`;
    case "star":
      return action.starred ? `${subject} starred` : `${subject} unstarred`;
  }
}

/** Gerund for failures: "Couldn't archive 2 conversations." */
export function actionFailure(action: MailAction, count: number): string {
  const what = count === 1 ? "the conversation" : `${String(count)} conversations`;
  const verb: Record<MailAction["kind"], string> = {
    archive: "archive",
    unarchive: "move",
    trash: "delete",
    restore: "restore",
    spam: "report",
    notSpam: "update",
    read: "update",
    snooze: "snooze",
    unsnooze: "unsnooze",
    label: "label",
    moveToLabel: "move",
    moveFromLabel: "move",
    star: "star",
  };
  return `Couldn't ${verb[action.kind]} ${what}.`;
}

/** Run `task` on every id, a few at a time; resolves to the ids that failed. */
export async function runBatched(
  ids: readonly string[],
  task: (id: string) => Promise<void>,
  concurrency = 6,
): Promise<string[]> {
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next];
      next += 1;
      if (id === undefined) continue;
      try {
        await task(id);
      } catch {
        failed.push(id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return failed;
}

const COLLECT_PAGE = 200;

/** Every thread id a list query matches, for "Select all N conversations". */
export async function collectThreadIds(input: MailThreadsListInput): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += COLLECT_PAGE) {
    const page = await listMailThreads({ ...input, offset, limit: COLLECT_PAGE });
    ids.push(...page.threads.map((thread) => thread.threadId));
    if (page.threads.length < COLLECT_PAGE || ids.length >= page.total) return ids;
  }
}
