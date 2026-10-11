/* Contacts keyboard shortcuts. The contact list is a SelectableList, which
   handles j/k, x and Enter itself while a row has focus; these registry
   handlers cover the same keys when focus is elsewhere (j or k jumps into the
   list). `#` and `e` act on the selection, else the focused row, else the
   open contact. `/` is the global "search the current app". */
import { useShortcuts } from "@/lib/shortcuts/use-shortcuts";

interface ContactsShortcutsInput {
  readonly onCreate: () => void;
  /** Row keys in list order, when a list is on screen. */
  readonly listKeys?: readonly string[];
  readonly selectedKeys?: ReadonlySet<string>;
  readonly onSelectedKeysChange?: (keys: Set<string>) => void;
  /** The contact on the detail page, when one is open. */
  readonly openContactId?: string;
  readonly onEdit?: (id: string) => void;
  readonly onDelete?: (ids: readonly string[]) => void;
}

function rowElement(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[role="row"][data-key="${CSS.escape(key)}"]`);
}

function focusedRowKey(): string | null {
  const active = document.activeElement;
  if (!(active instanceof Element)) return null;
  return active.closest<HTMLElement>('[role="row"][data-key]')?.dataset.key ?? null;
}

export function useContactsShortcuts(input: ContactsShortcutsInput) {
  const { listKeys, selectedKeys, onSelectedKeysChange, openContactId } = input;

  /** The selection, else the focused row, else the open contact. */
  const targets = (): readonly string[] => {
    if (selectedKeys !== undefined && selectedKeys.size > 0) return [...selectedKeys];
    const focused = focusedRowKey();
    if (focused !== null) return [focused];
    return openContactId === undefined ? [] : [openContactId];
  };

  const moveCursor = (step: 1 | -1) => () => {
    if (listKeys === undefined || listKeys.length === 0) return false;
    const current = listKeys.indexOf(focusedRowKey() ?? "");
    const next = current === -1 ? (step === 1 ? 0 : listKeys.length - 1) : current + step;
    const key = listKeys[Math.min(Math.max(next, 0), listKeys.length - 1)];
    if (key === undefined) return false;
    rowElement(key)?.focus();
  };

  useShortcuts("contacts", {
    "contacts.create": input.onCreate,
    "contacts.next": listKeys === undefined ? undefined : moveCursor(1),
    "contacts.previous": listKeys === undefined ? undefined : moveCursor(-1),
    "contacts.select":
      selectedKeys === undefined || onSelectedKeysChange === undefined
        ? undefined
        : () => {
            const focused = focusedRowKey();
            if (focused === null) return false;
            const next = new Set(selectedKeys);
            if (!next.delete(focused)) next.add(focused);
            onSelectedKeysChange(next);
          },
    "contacts.edit":
      input.onEdit === undefined
        ? undefined
        : () => {
            const [first, ...rest] = targets();
            if (first === undefined || rest.length > 0) return false;
            input.onEdit?.(first);
          },
    "contacts.delete":
      input.onDelete === undefined
        ? undefined
        : () => {
            const ids = targets();
            if (ids.length === 0) return false;
            input.onDelete?.(ids);
          },
  });
}
