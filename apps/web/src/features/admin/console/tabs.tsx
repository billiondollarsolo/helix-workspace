/* Tabs for sibling views of one admin page (WAI-ARIA tabs: roving tabindex,
 * arrow keys, Home/End). The selected tab lives in the URL (`?tab=`) through
 * `useAdminSectionTab`, so every view is linkable. */

import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

export interface AdminTab<TId extends string> {
  readonly id: TId;
  readonly label: string;
}

export function AdminTabs<TId extends string>({
  label,
  idPrefix,
  tabs,
  selected,
  onSelect,
  children,
}: {
  /** Accessible name of the tab list, e.g. "Mail settings". */
  readonly label: string;
  /** Prefix for the tab and panel element ids. */
  readonly idPrefix: string;
  readonly tabs: readonly AdminTab<TId>[];
  readonly selected: TId;
  readonly onSelect: (id: TId) => void;
  /** The selected tab's panel. */
  readonly children: ReactNode;
}) {
  const refs = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});
  const tabId = (id: TId) => `${idPrefix}-tab-${id}`;
  const panelId = (id: TId) => `${idPrefix}-panel-${id}`;

  const move = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = tabs.findIndex((tab) => tab.id === selected);
    const last = tabs.length - 1;
    const index =
      event.key === "ArrowRight"
        ? (current + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (current + last) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    const next = index === null ? undefined : tabs[index];
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    onSelect(next.id);
    refs.current[next.id]?.focus();
  };

  return (
    <>
      <div role="tablist" aria-label={label} className="admin-tabs" onKeyDown={move}>
        {tabs.map((tab) => {
          const active = tab.id === selected;
          return (
            <button
              key={tab.id}
              id={tabId(tab.id)}
              ref={(node) => {
                refs.current[tab.id] = node;
              }}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId(tab.id)}
              tabIndex={active ? 0 : -1}
              className="admin-tab focus-ring"
              onClick={() => onSelect(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        id={panelId(selected)}
        role="tabpanel"
        aria-labelledby={tabId(selected)}
        className="admin-tabpanel"
      >
        {children}
      </div>
    </>
  );
}
