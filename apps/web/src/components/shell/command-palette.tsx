import { cn } from "@/lib/utils";
import { iconMap as Icons, type IconName } from "@/components/icon-map";
import { ChevronRight as ChevronRightIcon, Search as SearchIcon } from "lucide-react";
/* CommandPalette — ⌘K global launcher.
   Matching commands first (apps, actions, settings, plugin commands), then
   content: a jump to the full results page, and mail, files, chat messages,
   events and people. Arrow keys move; Enter selects; Escape closes. */

import { APPS } from "@/components/apps";
import { Avatar } from "@/components/ui/avatar";
import { useEnabledApps } from "@/features/apps/use-enabled-apps";
import type { GlobalSearchType } from "@/features/search/api";
import {
  SEARCH_TYPE_LABELS,
  searchHitDetail,
  searchHitTarget,
  searchHitTitle,
} from "@/features/search/search-hits";
import { useContentSearch, type ContentSearchState } from "@/features/search/use-content-search";
import { usePlatformSnapshot, type CommandItem, type WebPlatformHost } from "@helix/sdk-web";
import { useNavigate, type UseNavigateResult } from "@tanstack/react-router";
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

const CONTENT_ICONS: Readonly<Record<GlobalSearchType, IconName>> = {
  mail: "Mail",
  drive: "Drive",
  chat: "Chat",
  calendar: "Calendar",
};

type Navigate = UseNavigateResult<string>;

/* "Create X" entries open the owning surface's editor through its URL state:
   `/mail?compose=new` and `/calendar?create=event`. */
function actionCommands(navigate: Navigate): PaletteItem[] {
  return [
    {
      id: "new-email",
      group: "Actions",
      title: "New email",
      icon: "EditPen",
      keywords: ["compose", "write", "message"],
      action: () => void navigate({ to: "/mail", search: { compose: "new" } }),
    },
    {
      id: "schedule-meeting",
      group: "Actions",
      title: "Schedule meeting",
      icon: "Calendar",
      keywords: ["event", "invite", "create"],
      action: () => void navigate({ to: "/calendar", search: { create: "event" } }),
    },
    {
      id: "start-meet-call",
      group: "Actions",
      title: "Start a video call",
      icon: "Video",
      keywords: ["meet", "call"],
      action: () => void navigate({ to: "/meet" }),
    },
  ];
}

/** Content results after the commands: a full-search jump, then hits by app. */
function contentItems(content: ContentSearchState, navigate: Navigate): PaletteItem[] {
  if (content.query.length === 0) {
    return [];
  }
  const q = content.query;
  return [
    {
      id: "search-all",
      group: "Search",
      title: `Search Helix for “${q}”`,
      sub: "Mail, files, chat messages, events and people",
      icon: "Grid",
      action: () => void navigate({ to: "/search", search: { q } }),
    },
    ...content.hitsByType.flatMap(({ type, hits }) =>
      hits.map<PaletteItem>((hit) => ({
        id: `hit:${hit.id}`,
        group: SEARCH_TYPE_LABELS[type],
        title: searchHitTitle(hit),
        sub: searchHitDetail(hit),
        icon: CONTENT_ICONS[type],
        action: () => void navigate(searchHitTarget(hit)),
      })),
    ),
    ...content.people.map<PaletteItem>((person) => ({
      id: `person:${person.id}`,
      group: "People",
      title: person.displayName,
      sub: person.email ?? undefined,
      avatar: person.displayName,
      action: () =>
        void navigate({
          to: "/mail",
          search: person.email === null ? {} : { compose: "new", to: person.email },
        }),
    })),
  ];
}

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
  const content = useContentSearch(query, open);
  /* Same gating as the launcher: Admin only for admins, Helix AI only while
     a provider answers, and no app the API does not serve. */
  const enabled = useEnabledApps();
  const adminEnabled = enabled.isEnabled("admin");
  // Keyed on the ids, not the array: `isEnabled` is rebuilt every render and a
  // fresh list would reset the highlighted option on each keystroke.
  const enabledAppIds = APPS.filter((app) => enabled.isEnabled(app.id))
    .map((app) => app.id)
    .join(" ");
  const enabledApps = useMemo(() => {
    const ids = new Set(enabledAppIds.split(" "));
    return APPS.filter((app) => ids.has(app.id));
  }, [enabledAppIds]);

  const goto = useCallback(
    (route: string) => {
      void navigate({ to: route });
    },
    [navigate],
  );

  const items = useMemo<PaletteItem[]>(() => {
    const base: PaletteItem[] = [
      ...enabledApps.map((app) => ({
        id: `app:${app.id}`,
        group: "Apps",
        title: `Go to ${app.name}`,
        icon: app.icon,
        keywords: [app.name, app.route],
        action: () => goto(app.route),
      })),
      ...actionCommands(navigate),
      {
        id: "account-settings",
        group: "Settings",
        title: "Account settings",
        icon: "Settings",
        action: openSettings,
      },
      ...(adminEnabled
        ? [
            {
              id: "admin-console",
              group: "Settings",
              title: "Admin console",
              icon: "Shield" as const,
              action: () => goto("/admin"),
            },
          ]
        : []),
      ...registeredCommands.map(commandPaletteItemFromPlatformCommand),
    ];
    if (!query) {
      return base;
    }
    const lower = query.toLowerCase();
    return [
      ...base.filter((item) => paletteItemMatchesQuery(item, lower)),
      ...contentItems(content, navigate),
    ];
  }, [query, goto, navigate, openSettings, registeredCommands, content, enabledApps, adminEnabled]);

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
            className="flex-1 [border:none] outline-none bg-transparent type-body"
          />
          <span className="kbd">esc</span>
        </div>
        <div className="overflow-y-auto flex-1 p-1.5">
          <div id="command-palette-results" role="listbox" aria-label="Commands and results">
            {Array.from(groups.entries()).map(([group, groupItems]) => {
              const groupLabelId = `command-palette-group-${group.toLowerCase().replaceAll(" ", "-")}`;
              return (
                <div key={group} role="group" aria-labelledby={groupLabelId}>
                  <div
                    id={groupLabelId}
                    className="type-chip text-muted-foreground font-semibold uppercase [letter-spacing:.06em] [padding:8px_12px_4px]"
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
                          "w-full flex items-center gap-2.5 [padding:8px_12px] rounded-md type-body-sm text-left",
                          active && !disabled
                            ? "[background:var(--accent-soft)]"
                            : "bg-transparent",
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
                            <div className="truncate type-caption [color:var(--text-2)]">
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
          </div>
          <div className="palette-status" role="status" aria-live="polite">
            {paletteStatus(query, items.length, content)}
          </div>
        </div>
        <div className="[border-top:1px_solid_var(--border)] [padding:8px_14px] flex gap-4 type-caption text-muted-foreground">
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

function paletteStatus(query: string, count: number, content: ContentSearchState): string {
  if (query.trim().length === 0) return "";
  if (content.loading) return "Searching mail, files, chat and events…";
  if (content.failed) return "Content search is unavailable right now.";
  return count === 0 ? `No results for “${query.trim()}”` : "";
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
