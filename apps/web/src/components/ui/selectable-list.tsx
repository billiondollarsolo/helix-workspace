/* SelectableList — keyboard-first list with checkbox selection, for mail
   threads, files, contacts, and admin rows.

   Structure: role="grid" (multi-selectable) → role="row" → two gridcells,
   a checkbox cell and the consumer's content cell. The row is NOT a button:
   it is the roving focus target, and buttons inside the content cell (star,
   hover actions) stay separate controls, which removes the nested-interactive
   pattern. Pass `state.tabIndex` to those inner controls so only the active
   row's controls sit in the Tab order.

   Keys on a focused row:
     j / ArrowDown, k / ArrowUp   move (Shift extends the selection)
     Home / End                   first / last row
     x / Space                    toggle the row's checkbox
     Enter / o                    open (onOpen)
     Ctrl/Cmd+A                   select all (onSelectAll, else every row)
     Escape                       clear the selection
   Mouse: Shift-click a checkbox or row selects the range from the last
   toggled row; Ctrl/Cmd-click toggles; a plain click opens. */

import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

export interface SelectableRowState {
  selected: boolean;
  active: boolean;
  /** 0 on the active row, -1 elsewhere: spread onto in-row controls. */
  tabIndex: 0 | -1;
}

export interface SelectableListProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  /** Accessible name of the list, e.g. "Conversations". */
  label: string;
  /** Short name of one row for its checkbox, e.g. the subject. */
  getItemLabel: (item: T) => string;
  selectedKeys: ReadonlySet<string>;
  onSelectedKeysChange: (next: Set<string>) => void;
  /** Row content; rendered inside the row's content cell. */
  renderItem: (item: T, state: SelectableRowState) => ReactNode;
  /** Plain click, Enter, or o on a row. */
  onOpen?: (item: T) => void;
  /** Ctrl/Cmd+A. Defaults to selecting every loaded row; pass this to offer
   *  "select all N matching" for server-side lists instead. */
  onSelectAll?: () => void;
  /** Controlled active (focused) row. Uncontrolled when omitted. */
  activeKey?: string | null;
  onActiveKeyChange?: (key: string) => void;
  /** Extra classes per row; receives the row state. */
  rowClassName?: (item: T, state: SelectableRowState) => string | undefined;
  className?: string;
}

/** Keys from `fromKey` to `toKey` inclusive, in list order. */
export function keyRange(keys: readonly string[], fromKey: string, toKey: string): string[] {
  const from = keys.indexOf(fromKey);
  const to = keys.indexOf(toKey);
  if (from === -1 || to === -1) return [toKey];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return keys.slice(lo, hi + 1);
}

/** Clicks on these inside a row belong to the control, not the row. */
const INNER_CONTROLS = "a, button, input, select, textarea, label, [role='button']";

const MOVE_KEYS: Readonly<Record<string, number | "first" | "last">> = {
  ArrowDown: 1,
  j: 1,
  J: 1,
  ArrowUp: -1,
  k: -1,
  K: -1,
  Home: "first",
  End: "last",
};

export function SelectableList<T>({
  items,
  getKey,
  label,
  getItemLabel,
  selectedKeys,
  onSelectedKeysChange,
  renderItem,
  onOpen,
  onSelectAll,
  activeKey: controlledActive,
  onActiveKeyChange,
  rowClassName,
  className,
}: SelectableListProps<T>) {
  const keys = items.map(getKey);
  const [uncontrolledActive, setUncontrolledActive] = useState<string | null>(null);
  const requestedActive = controlledActive === undefined ? uncontrolledActive : controlledActive;
  const activeKey =
    requestedActive !== null && keys.includes(requestedActive)
      ? requestedActive
      : (keys[0] ?? null);
  const anchorRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const activate = useCallback(
    (key: string, focus: boolean) => {
      setUncontrolledActive(key);
      onActiveKeyChange?.(key);
      if (focus) rowRefs.current.get(key)?.focus();
    },
    [onActiveKeyChange],
  );

  const toggle = (key: string) => {
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    anchorRef.current = key;
    onSelectedKeysChange(next);
  };

  const selectRange = (toKey: string) => {
    const from = anchorRef.current ?? activeKey ?? toKey;
    const next = new Set(selectedKeys);
    for (const key of keyRange(keys, from, toKey)) next.add(key);
    onSelectedKeysChange(next);
  };

  const selectAll = () => {
    if (onSelectAll) onSelectAll();
    else onSelectedKeysChange(new Set(keys));
  };

  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, item: T, key: string) => {
    if (event.target !== event.currentTarget) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && (event.key === "a" || event.key === "A")) {
      event.preventDefault();
      selectAll();
      return;
    }
    if (mod || event.altKey) return;
    const move = MOVE_KEYS[event.key];
    if (move !== undefined) {
      event.preventDefault();
      const index = keys.indexOf(key);
      const target =
        move === "first"
          ? keys[0]
          : move === "last"
            ? keys.at(-1)
            : keys[Math.max(0, Math.min(keys.length - 1, index + move))];
      if (target === undefined) return;
      if (event.shiftKey) {
        if (anchorRef.current === null) anchorRef.current = key;
        selectRange(target);
      }
      activate(target, true);
      return;
    }
    switch (event.key) {
      case "x":
      case " ":
        event.preventDefault();
        toggle(key);
        return;
      case "Enter":
      case "o":
        if (onOpen) {
          event.preventDefault();
          onOpen(item);
        }
        return;
      case "Escape":
        if (selectedKeys.size > 0) {
          event.preventDefault();
          anchorRef.current = null;
          onSelectedKeysChange(new Set());
        }
        return;
      default:
    }
  };

  const onRowClick = (event: ReactMouseEvent<HTMLDivElement>, item: T, key: string) => {
    const control = event.target instanceof Element ? event.target.closest(INNER_CONTROLS) : null;
    if (control && control !== event.currentTarget && event.currentTarget.contains(control)) return;
    activate(key, false);
    if (event.shiftKey) {
      event.preventDefault();
      selectRange(key);
      anchorRef.current = key;
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      toggle(key);
      return;
    }
    onOpen?.(item);
  };

  return (
    <div
      role="grid"
      aria-label={label}
      aria-multiselectable="true"
      aria-rowcount={items.length}
      data-slot="selectable-list"
      className={cn("flex flex-col", className)}
    >
      {items.map((item, index) => {
        const key = getKey(item);
        const state: SelectableRowState = {
          selected: selectedKeys.has(key),
          active: key === activeKey,
          tabIndex: key === activeKey ? 0 : -1,
        };
        return (
          <div
            key={key}
            ref={(node) => {
              if (node) rowRefs.current.set(key, node);
              else rowRefs.current.delete(key);
            }}
            role="row"
            aria-rowindex={index + 1}
            aria-selected={state.selected}
            tabIndex={state.tabIndex}
            data-active={state.active || undefined}
            data-selected={state.selected || undefined}
            onKeyDown={(event) => onRowKeyDown(event, item, key)}
            onClick={(event) => onRowClick(event, item, key)}
            onFocus={(event) => {
              if (event.target === event.currentTarget && !state.active) activate(key, false);
            }}
            className={cn(
              "group/row relative flex min-h-[var(--rd-list-row-h)] cursor-pointer items-center outline-none select-none",
              "hover:bg-[var(--hover)] data-[selected]:bg-[var(--accent-soft)]",
              "focus-visible:shadow-[inset_3px_0_0_var(--focus-ring-color)] focus-visible:bg-[var(--hover-strong)]",
              rowClassName?.(item, state),
            )}
          >
            <div role="gridcell" className="flex shrink-0 items-center pl-[var(--rd-row-px)] pr-1">
              <input
                type="checkbox"
                tabIndex={-1}
                aria-label={`Select ${getItemLabel(item)}`}
                checked={state.selected}
                readOnly
                onClick={(event) => {
                  event.stopPropagation();
                  activate(key, false);
                  if (event.shiftKey) {
                    selectRange(key);
                    anchorRef.current = key;
                  } else {
                    toggle(key);
                  }
                }}
                className="size-4 cursor-pointer accent-[var(--accent)]"
              />
            </div>
            <div role="gridcell" className="flex min-w-0 flex-1 items-center">
              {renderItem(item, state)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export interface SelectAllCheckboxProps {
  /** Rows that could be selected. */
  total: number;
  selectedCount: number;
  /** Select all when nothing or some are selected; clear when all are. */
  onToggle: (selectAll: boolean) => void;
  label?: string;
  className?: string;
}

/** Tri-state header checkbox that pairs with SelectableList. */
export function SelectAllCheckbox({
  total,
  selectedCount,
  onToggle,
  label = "Select all",
  className,
}: SelectAllCheckboxProps) {
  const all = total > 0 && selectedCount >= total;
  const some = selectedCount > 0 && !all;
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={all}
      disabled={total === 0}
      ref={(node) => {
        if (node) node.indeterminate = some;
      }}
      onChange={() => onToggle(!all)}
      className={cn("size-4 cursor-pointer accent-[var(--accent)] focus-ring", className)}
    />
  );
}
