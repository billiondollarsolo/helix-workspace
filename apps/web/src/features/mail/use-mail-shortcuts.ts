/* Mail keyboard shortcuts (Gmail layout). The list cursor is DOM focus on a
   thread row (`data-thread-id`), so j/k give a visible focus ring and Enter
   on the focused row opens it natively. Actions (s e # ! ⇧I ⇧U) apply to the
   checked conversations, else the focused row, else the open conversation. */

import { useShortcuts } from "@/lib/shortcuts/use-shortcuts";
import type { MailThreadRow } from "./api";

type ThreadIds = ReadonlySet<string>;

interface MailShortcutsInput {
  readonly threads: readonly MailThreadRow[];
  /** The conversation open in the reading view, if any. */
  readonly openThreadId: string | null;
  readonly checkedIds: ThreadIds;
  readonly onCheckedChange: (ids: ThreadIds) => void;
  readonly onCompose: () => void;
  readonly onOpen: (threadId: string) => void;
  readonly onBack: () => void;
  readonly onStar: (ids: ThreadIds, starred: boolean) => void;
  readonly onArchive: (ids: ThreadIds) => void;
  readonly onDelete: (ids: ThreadIds) => void;
  /** Omitted where reporting spam does not apply (the Spam folder). */
  readonly onSpam?: (ids: ThreadIds) => void;
  readonly onRead: (ids: ThreadIds, unread: boolean) => void;
}

function threadRow(threadId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`);
}

function focusedThreadId(): string | null {
  const active = document.activeElement;
  return active instanceof Element
    ? (active.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId ?? null)
    : null;
}

export function useMailShortcuts(input: MailShortcutsInput) {
  const { threads, openThreadId, checkedIds } = input;
  const inList = openThreadId === null;

  const targets = (): ThreadIds | null => {
    if (openThreadId !== null) return new Set([openThreadId]);
    if (checkedIds.size > 0) return checkedIds;
    const focused = focusedThreadId();
    return focused === null ? null : new Set([focused]);
  };

  /** Run `action` on the targets; decline the key when there are none. */
  const act = (action: ((ids: ThreadIds) => void) | undefined) =>
    action === undefined
      ? undefined
      : () => {
          const ids = targets();
          if (ids === null) return false;
          action(ids);
        };

  const moveCursor = (step: 1 | -1) => () => {
    const current = threads.findIndex((thread) => thread.threadId === focusedThreadId());
    const next = current === -1 ? (step === 1 ? 0 : threads.length - 1) : current + step;
    const nextThread = threads[Math.min(Math.max(next, 0), threads.length - 1)];
    if (nextThread === undefined) return false;
    threadRow(nextThread.threadId)?.focus();
  };

  const openSibling = (step: 1 | -1) => () => {
    const current = threads.findIndex((thread) => thread.threadId === openThreadId);
    const sibling = current === -1 ? undefined : threads[current + step];
    if (sibling === undefined) return false;
    input.onOpen(sibling.threadId);
  };

  useShortcuts("mail", {
    "mail.compose": input.onCompose,
    "mail.next": inList ? moveCursor(1) : undefined,
    "mail.previous": inList ? moveCursor(-1) : undefined,
    "mail.open": inList
      ? () => {
          const focused = focusedThreadId();
          if (focused === null) return false;
          input.onOpen(focused);
        }
      : undefined,
    "mail.select": inList
      ? () => {
          const focused = focusedThreadId();
          if (focused === null) return false;
          const next = new Set(checkedIds);
          if (!next.delete(focused)) next.add(focused);
          input.onCheckedChange(next);
        }
      : undefined,
    "mail.star": act((ids) => {
      const allStarred = threads
        .filter((thread) => ids.has(thread.threadId))
        .every((thread) => thread.starred);
      input.onStar(ids, !allStarred);
    }),
    "mail.archive": act(input.onArchive),
    "mail.delete": act(input.onDelete),
    "mail.spam": act(input.onSpam),
    "mail.mark-read": act((ids) => input.onRead(ids, false)),
    "mail.mark-unread": act((ids) => input.onRead(ids, true)),
  });

  useShortcuts("mail.thread", {
    "mail.thread.older": inList ? undefined : openSibling(1),
    "mail.thread.newer": inList ? undefined : openSibling(-1),
    "mail.thread.back":
      openThreadId === null
        ? undefined
        : () => {
            input.onBack();
            requestAnimationFrame(() => threadRow(openThreadId)?.focus());
          },
  });
}
