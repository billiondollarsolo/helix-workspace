/* CommandPalette — ⌘K global launcher.
   Ported from the design handoff (overlays.jsx → CommandPalette).
   Categorized results (Apps / Actions / Settings / People / Documents);
   arrow-key navigation; Enter selects; Escape closes. */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePlatformSnapshot, type CommandItem, type WebPlatformHost } from "@helix/sdk-web";
import { Icons, type IconName } from "@/components/icons";
import { APPS } from "@/components/apps";
import { Avatar } from "@/components/ui/avatar";

interface PaletteItem {
  id: string;
  group: string;
  title: string;
  sub?: string;
  icon?: IconName;
  avatar?: string;
  keywords?: readonly string[];
  shortcut?: string;
  disabledReason?: string;
  action: () => void | Promise<void>;
}

/* "Create X" entries. Each one currently just lands on the owning surface —
   the surfaces open their own composer from there. */
const ACTION_COMMANDS: readonly { id: string; title: string; icon: IconName; route: string }[] = [
  { id: "new-email", title: "New email", icon: "EditPen", route: "/mail" },
  { id: "new-doc", title: "New doc", icon: "Doc", route: "/docs" },
  { id: "new-sheet", title: "New sheet", icon: "Sheet", route: "/sheets" },
  { id: "new-slide-deck", title: "New slide deck", icon: "Image", route: "/slides" },
  { id: "schedule-meeting", title: "Schedule meeting", icon: "Calendar", route: "/calendar" },
  { id: "start-meet-call", title: "Start a Helix Meet call", icon: "Video", route: "/meet" },
];

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  openSettings: () => void;
}

export function CommandPalette({ open, onClose, openSettings }: CommandPaletteProps) {
  const navigate = useNavigate();
  const selectCommands = useCallback((host: WebPlatformHost) => host.getCommandPaletteItems(), []);
  const registeredCommands = usePlatformSnapshot(selectCommands);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const goto = useCallback(
    (route: string) => {
      void navigate({ to: route });
    },
    [navigate],
  );

  const items = useMemo<PaletteItem[]>(() => {
    const base: PaletteItem[] = [
      ...APPS.map((app) => ({
        id: `app:${app.id}`,
        group: "Apps",
        title: `Go to ${app.name}`,
        icon: app.icon,
        keywords: [app.name, app.route],
        action: () => goto(app.route),
      })),
      ...ACTION_COMMANDS.map((command) => ({
        id: command.id,
        group: "Actions",
        title: command.title,
        icon: command.icon,
        action: () => goto(command.route),
      })),
      {
        id: "account-settings",
        group: "Settings",
        title: "Account settings",
        icon: "Settings",
        action: openSettings,
      },
      {
        id: "admin-console",
        group: "Settings",
        title: "Admin console",
        icon: "Shield",
        action: () => goto("/admin"),
      },
      ...registeredCommands.map(commandPaletteItemFromPlatformCommand),
    ];
    if (!query) {
      return base;
    }
    const lower = query.toLowerCase();
    return base.filter((item) => paletteItemMatchesQuery(item, lower));
  }, [query, goto, openSettings, registeredCommands]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    let cancelled = false;
    setQuery("");
    document.body.style.overflow = "hidden";
    queueMicrotask(() => {
      if (!cancelled) {
        searchInputRef.current?.focus();
      }
    });
    return () => {
      cancelled = true;
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected === true) {
        previousFocus.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    setIndex(firstEnabledIndex(items));
  }, [items]);

  const activeOptionId = index >= 0 ? `command-palette-option-${String(index)}` : undefined;

  useEffect(() => {
    if (!open || activeOptionId === undefined) {
      return;
    }
    const option = document.getElementById(activeOptionId);
    if (option !== null && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  }, [activeOptionId, open]);

  if (!open) {
    return null;
  }

  // Group while preserving a running flat index for keyboard navigation.
  const groups = new Map<string, PaletteItem[]>();
  items.forEach((item) => {
    const list = groups.get(item.group) ?? [];
    list.push(item);
    groups.set(item.group, list);
  });
  let runningIndex = 0;

  return (
    <div
      data-testid="command-palette-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "12vh",
        zIndex: 1000,
        backdropFilter: "blur(4px)",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "Tab") {
            event.preventDefault();
            searchInputRef.current?.focus();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setIndex((current) => nextEnabledIndex(items, current, 1));
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setIndex((current) => nextEnabledIndex(items, current, -1));
            return;
          }
          if (event.key === "Enter") {
            const item = items[index];
            if (item === undefined || item.disabledReason !== undefined) {
              return;
            }
            event.preventDefault();
            void item.action();
            onClose();
          }
        }}
        style={{
          width: 600,
          maxWidth: "90vw",
          maxHeight: "70vh",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <h2 id="command-palette-title" className="sr-only">
          Command palette
        </h2>
        <div
          style={{
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <Icons.Search />
          <input
            ref={searchInputRef}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={activeOptionId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search apps, docs, people, actions…"
            aria-label="Search apps, docs, people, actions"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: "var(--text-body)",
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <div
          id="command-palette-results"
          role="listbox"
          aria-label="Commands"
          style={{ overflowY: "auto", flex: 1, padding: 6 }}
        >
          {Array.from(groups.entries()).map(([group, groupItems]) => {
            const groupLabelId = `command-palette-group-${group.toLowerCase().replaceAll(" ", "-")}`;
            return (
              <div key={group} role="group" aria-labelledby={groupLabelId}>
                <div
                  id={groupLabelId}
                  style={{
                    fontSize: "var(--text-chip)",
                    color: "var(--text-3)",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: ".06em",
                    padding: "8px 12px 4px",
                  }}
                >
                  {group}
                </div>
                {groupItems.map((item) => {
                  const myIndex = runningIndex;
                  runningIndex += 1;
                  const Icon = item.icon ? Icons[item.icon] : null;
                  const active = myIndex === index;
                  const disabled = item.disabledReason !== undefined;
                  let glyph: ReactNode = null;
                  if (item.avatar) {
                    glyph = <Avatar name={item.avatar} size={20} />;
                  } else if (Icon !== null) {
                    glyph = <Icon />;
                  }
                  return (
                    <button
                      key={`${item.group}-${item.title}-${myIndex}`}
                      id={`command-palette-option-${String(myIndex)}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      aria-disabled={disabled}
                      tabIndex={-1}
                      disabled={disabled}
                      title={item.disabledReason}
                      onClick={() => {
                        if (disabled) {
                          return;
                        }
                        void item.action();
                        onClose();
                      }}
                      onMouseEnter={() => setIndex(myIndex)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 12px",
                        borderRadius: 6,
                        fontSize: "var(--text-body-sm)",
                        textAlign: "left",
                        background: active && !disabled ? "var(--accent-soft)" : "transparent",
                        color: paletteItemColor(disabled, active),
                        opacity: disabled ? 0.72 : 1,
                        cursor: disabled ? "not-allowed" : "pointer",
                      }}
                    >
                      <span
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 4,
                          background: "var(--surface-2)",
                          display: "grid",
                          placeItems: "center",
                          flexShrink: 0,
                        }}
                      >
                        {glyph}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="truncate">{item.title}</div>
                        {item.sub || item.disabledReason ? (
                          <div
                            className="truncate"
                            style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}
                          >
                            {item.disabledReason ?? item.sub}
                          </div>
                        ) : null}
                      </div>
                      {item.shortcut ? <span className="kbd">{item.shortcut}</span> : null}
                      {active ? <Icons.ChevronRight /> : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {items.length === 0 ? (
            <div className="empty" role="status" aria-live="polite" style={{ padding: 32 }}>
              <Icons.Search />
              <div>No results for &quot;{query}&quot;</div>
            </div>
          ) : null}
        </div>
        <div
          style={{
            borderTop: "1px solid var(--border)",
            padding: "8px 14px",
            display: "flex",
            gap: 16,
            fontSize: "var(--text-caption)",
            color: "var(--text-3)",
          }}
        >
          <span className="row gap-2">
            <span className="kbd">↑↓</span>navigate
          </span>
          <span className="row gap-2">
            <span className="kbd">↵</span>select
          </span>
          <span className="row gap-2">
            <span className="kbd">esc</span>close
          </span>
        </div>
      </div>
    </div>
  );
}

function paletteItemColor(disabled: boolean, active: boolean): string {
  if (disabled) {
    return "var(--text-3)";
  }
  return active ? "var(--accent)" : "var(--text)";
}

function firstEnabledIndex(items: readonly PaletteItem[]): number {
  return items.findIndex((item) => item.disabledReason === undefined);
}

function nextEnabledIndex(
  items: readonly PaletteItem[],
  current: number,
  direction: 1 | -1,
): number {
  if (items.length === 0) {
    return -1;
  }
  const start = current >= 0 ? current : direction === 1 ? -1 : 0;
  for (let offset = 1; offset <= items.length; offset += 1) {
    const candidate = (start + direction * offset + items.length) % items.length;
    if (items[candidate]?.disabledReason === undefined) {
      return candidate;
    }
  }
  return -1;
}

function commandPaletteItemFromPlatformCommand(command: CommandItem): PaletteItem {
  return {
    id: command.id,
    group: command.group ?? "Actions",
    title: command.label,
    sub: command.pluginId,
    keywords: command.keywords,
    shortcut: command.shortcut,
    disabledReason: command.disabledReason,
    action: command.run,
  };
}

function paletteItemMatchesQuery(item: PaletteItem, query: string): boolean {
  return [
    item.id,
    item.group,
    item.title,
    item.sub ?? "",
    item.disabledReason ?? "",
    item.shortcut ?? "",
    ...(item.keywords ?? []),
  ].some((value) => value.toLowerCase().includes(query));
}
