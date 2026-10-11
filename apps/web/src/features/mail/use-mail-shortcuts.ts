/* Mail keyboard shortcuts (Gmail layout). The conversation list is a
   SelectableList: while a row has focus it handles j/k, x, o/Enter and
   Escape itself, so the registry handlers below cover the same keys when
   focus is elsewhere (j or k jumps into the list). Actions (s e # ! ⇧I ⇧U)
   apply to the selected conversations, else the focused row, else the open
   conversation. `z` (undo) is bound by useMailActions. */

import { useShortcuts } from "@/lib/shortcuts/use-shortcuts";
import type { MailThreadRow } from "./api";
import type { MailAction } from "./mail-actions";

type ThreadIds = ReadonlySet<string>;

interface MailShortcutsInput {
  readonly threads: readonly MailThreadRow[];
  /** The conversation open in the reading view, if any. */
  readonly openThreadId: string | null;
  readonly selectedIds: ThreadIds;
  readonly onSelectedChange: (ids: Set<string>) => void;
  readonly onCompose: () => void;
  readonly onOpen: (threadId: string) => void;
  readonly onBack: () => void;
  readonly onAction: (ids: readonly string[], action: MailAction) => void;
  /** False in the Spam folder, where "report spam" does not apply. */
  readonly canReportSpam: boolean;
}

function threadRowElement(threadId: string): HTMLElement | null {
  return (
    document
      .querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(threadId)}"]`)
      ?.closest<HTMLElement>('[role="row"]') ?? null
  );
}

function focusedThreadId(): string | null {
  const active = document.activeElement;
  if (!(active instanceof Element)) return null;
  const row = active.closest('[role="row"]');
  return row?.querySelector<HTMLElement>("[data-thread-id]")?.dataset.threadId ?? null;
}

export function useMailShortcuts(input: MailShortcutsInput) {
  const { threads, openThreadId, selectedIds } = input;
  const inList = openThreadId === null;

  const targets = (): readonly string[] | null => {
    if (openThreadId !== null) return [openThreadId];
    if (selectedIds.size > 0) return [...selectedIds];
    const focused = focusedThreadId();
    return focused === null ? null : [focused];
  };

  /** Run `action` on the targets; decline the key when there are none. */
  const act = (action: (ids: readonly string[]) => MailAction) => () => {
    const ids = targets();
    if (ids === null) return false;
    input.onAction(ids, action(ids));
  };

  const moveCursor = (step: 1 | -1) => () => {
    const current = threads.findIndex((thread) => thread.threadId === focusedThreadId());
    const next = current === -1 ? (step === 1 ? 0 : threads.length - 1) : current + step;
    const nextThread = threads[Math.min(Math.max(next, 0), threads.length - 1)];
    if (nextThread === undefined) return false;
    threadRowElement(nextThread.threadId)?.focus();
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
          const next = new Set(selectedIds);
          if (!next.delete(focused)) next.add(focused);
          input.onSelectedChange(next);
        }
      : undefined,
    "mail.star": act((ids) => ({
      kind: "star",
      starred: !threads
        .filter((thread) => ids.includes(thread.threadId))
        .every((thread) => thread.starred),
    })),
    "mail.archive": act(() => ({ kind: "archive" })),
    "mail.delete": act(() => ({ kind: "trash" })),
    "mail.spam": input.canReportSpam ? act(() => ({ kind: "spam" })) : undefined,
    "mail.mark-read": act(() => ({ kind: "read", unread: false })),
    "mail.mark-unread": act(() => ({ kind: "read", unread: true })),
  });

  useShortcuts("mail.thread", {
    "mail.thread.older": inList ? undefined : openSibling(1),
    "mail.thread.newer": inList ? undefined : openSibling(-1),
    "mail.thread.back":
      openThreadId === null
        ? undefined
        : () => {
            input.onBack();
            requestAnimationFrame(() => threadRowElement(openThreadId)?.focus());
          },
  });
}

/** ⌘/Ctrl+Enter sends while focus is inside the compose window (and not in a
    confirmation dialog stacked on top of it). */
export function useComposeSendShortcut(send: () => void, canSend: boolean) {
  useShortcuts("dialog", {
    "dialog.send": canSend
      ? (event) => {
          const target = event.target instanceof Element ? event.target : null;
          const inCompose = target?.closest('[aria-labelledby="mail-compose-title"]') != null;
          if (!inCompose || target?.closest('[aria-modal="true"]') != null) return false;
          send();
        }
      : undefined,
  });
}
