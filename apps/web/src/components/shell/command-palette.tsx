import { cn } from "@/lib/utils";
import { iconMap as Icons, type IconName } from "@/components/icon-map";
import { ChevronRight as ChevronRightIcon, Search as SearchIcon } from "lucide-react";
/* CommandPalette — ⌘K global launcher.
   Ported from the design handoff (overlays.jsx → CommandPalette).
   Categorized results (Apps / Actions / Settings / People / Documents);
   arrow-key navigation; Enter selects; Escape closes. */

import { APPS } from "@/components/apps";
import { Avatar } from "@/components/ui/avatar";
import { usePlatformSnapshot, type CommandItem, type WebPlatformHost } from "@helix/sdk-web";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
      className="fixed inset-0 [background:rgba(0,0,0,0.4)] flex justify-center items-start [padding-top:12vh] [z-index:1000] [backdrop-filter:blur(4px)]"
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
        className="w-150 [max-width:90vw] [max-height:70vh] bg-card [border:1px_solid_var(--border)] [border-radius:12px] [box-shadow:var(--shadow-lg)] flex flex-col overflow-hidden"
      >
        <h2 id="command-palette-title" className="sr-only">
          Command palette
        </h2>
        <div className="[padding:12px_16px] flex items-center gap-2.5 [border-bottom:1px_solid_var(--border)]">
          <SearchIcon size={16} />
          <input
            ref={searchInputRef}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={activeOptionId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search apps, files, people, actions…"
            aria-label="Search apps, files, people, actions"
            className="flex-1 [border:none] outline-none bg-transparent [font-size:var(--text-body)]"
          />
          <span className="kbd">esc</span>
        </div>
        <div
          id="command-palette-results"
          role="listbox"
          aria-label="Commands"
          className="overflow-y-auto flex-1 p-1.5"
        >
          {Array.from(groups.entries()).map(([group, groupItems]) => {
            const groupLabelId = `command-palette-group-${group.toLowerCase().replaceAll(" ", "-")}`;
            return (
              <div key={group} role="group" aria-labelledby={groupLabelId}>
                <div
                  id={groupLabelId}
                  className="[font-size:var(--text-chip)] text-muted-foreground font-semibold uppercase [letter-spacing:.06em] [padding:8px_12px_4px]"
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
                      className={cn(
                        "w-full flex items-center gap-2.5 [padding:8px_12px] rounded-md [font-size:var(--text-body-sm)] text-left",
                        active && !disabled ? "[background:var(--accent-soft)]" : "bg-transparent",
                        disabled ? "[opacity:0.72]" : "[opacity:1]",
                        disabled
                          ? "cursor-not-allowed text-muted-foreground"
                          : active
                            ? "cursor-pointer text-primary"
                            : "cursor-pointer text-foreground",
                      )}
                    >
                      <span className="w-6 h-6 rounded bg-muted grid [place-items:center] shrink-0">
                        {glyph}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{item.title}</div>
                        {item.sub || item.disabledReason ? (
                          <div className="truncate [font-size:var(--text-caption)] text-muted-foreground">
                            {item.disabledReason ?? item.sub}
                          </div>
                        ) : null}
                      </div>
                      {item.shortcut ? <span className="kbd">{item.shortcut}</span> : null}
                      {active ? <ChevronRightIcon size={16} /> : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {items.length === 0 ? (
            <div className="empty p-8" role="status" aria-live="polite">
              <SearchIcon size={16} />
              <div>No results for &quot;{query}&quot;</div>
            </div>
          ) : null}
        </div>
        <div className="[border-top:1px_solid_var(--border)] [padding:8px_14px] flex gap-4 [font-size:var(--text-caption)] text-muted-foreground">
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
