/* CommandPalette — ⌘K global launcher.
   Ported from the design handoff (overlays.jsx → CommandPalette).
   Categorized results (Apps / Actions / Settings / People / Documents);
   arrow-key navigation; Enter selects; Escape closes. */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlatformSnapshot, type CommandItem, type WebPlatformHost } from "@helix/sdk-web";
import { Icons, type IconName } from "@/components/icons";
import { APPS, CORE_WORKSPACE_STORAGE_ONLY } from "@/components/apps";
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

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  openSettings: () => void;
}

const searchLabel = CORE_WORKSPACE_STORAGE_ONLY
  ? "Search apps, files, people, actions"
  : "Search apps, docs, people, actions";

export function CommandPalette({ open, onClose, openSettings }: CommandPaletteProps) {
  const navigate = useNavigate();
  const selectCommands = useCallback((host: WebPlatformHost) => host.getCommandPaletteItems(), []);
  const registeredCommands = usePlatformSnapshot(selectCommands);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const goto = useMemo(
    () => (route: string) => {
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
        action: () => {
          goto(app.route);
        },
      })),
      {
        id: "new-email",
        group: "Actions",
        title: "New email",
        icon: "EditPen",
        action: () => {
          goto("/mail");
        },
      },
      ...(CORE_WORKSPACE_STORAGE_ONLY
        ? []
        : [
            {
              id: "new-doc",
              group: "Actions",
              title: "New doc",
              icon: "Doc" as const,
              action: () => {
                goto("/docs");
              },
            },
            {
              id: "new-sheet",
              group: "Actions",
              title: "New sheet",
              icon: "Sheet" as const,
              action: () => {
                goto("/sheets");
              },
            },
            {
              id: "new-slide-deck",
              group: "Actions",
              title: "New slide deck",
              icon: "Image" as const,
              action: () => {
                goto("/slides");
              },
            },
            {
              id: "schedule-meeting",
              group: "Actions",
              title: "Schedule meeting",
              icon: "Calendar" as const,
              action: () => {
                goto("/calendar");
              },
            },
            {
              id: "start-meet-call",
              group: "Actions",
              title: "Start a Helix Meet call",
              icon: "Video" as const,
              action: () => {
                goto("/meet");
              },
            },
          ]),
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
        action: () => {
          goto("/admin");
        },
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
    setIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex((i) => Math.min(items.length - 1, i + 1));
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
      }
      if (event.key === "Enter") {
        const item = items[index];
        if (item === undefined || item.disabledReason !== undefined) {
          return;
        }
        void item.action();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, index, items, onClose]);

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
      onClick={onClose}
    >
      <div
        onClick={(event) => {
          event.stopPropagation();
        }}
        role="dialog"
        aria-label="Command palette"
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
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder={`${searchLabel}…`}
            aria-label={searchLabel}
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
        <div style={{ overflowY: "auto", flex: 1, padding: 6 }}>
          {Array.from(groups.entries()).map(([group, groupItems]) => (
            <div key={group}>
              <div
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
                return (
                  <button
                    key={`${item.group}-${item.title}-${String(myIndex)}`}
                    type="button"
                    disabled={disabled}
                    title={item.disabledReason}
                    onClick={() => {
                      if (disabled) {
                        return;
                      }
                      void item.action();
                      onClose();
                    }}
                    onMouseEnter={() => {
                      setIndex(myIndex);
                    }}
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
                      color: disabled ? "var(--text-3)" : active ? "var(--accent)" : "var(--text)",
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
                      {item.avatar ? (
                        <Avatar name={item.avatar} size={20} />
                      ) : Icon ? (
                        <Icon />
                      ) : null}
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
          ))}
          {items.length === 0 ? (
            <div className="empty" style={{ padding: 32 }}>
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
