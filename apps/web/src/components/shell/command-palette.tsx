/* CommandPalette — ⌘K global launcher.
   Ported from the design handoff (overlays.jsx → CommandPalette).
   Categorized results (Apps / Actions / Settings / People / Documents);
   arrow-key navigation; Enter selects; Escape closes. */

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Icons, type IconName } from "@/components/icons";
import { APPS } from "@/components/apps";
import { Avatar } from "@/components/ui/avatar";
import { PEOPLE } from "@/components/people";

interface PaletteItem {
  group: string;
  title: string;
  sub?: string;
  icon?: IconName;
  avatar?: string;
  action: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  openSettings: () => void;
}

export function CommandPalette({ open, onClose, openSettings }: CommandPaletteProps) {
  const navigate = useNavigate();
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
        group: "Apps",
        title: `Go to ${app.name}`,
        icon: app.icon,
        action: () => goto(app.route),
      })),
      { group: "Actions", title: "New email", icon: "EditPen", action: () => goto("/mail") },
      { group: "Actions", title: "New doc", icon: "Doc", action: () => goto("/docs") },
      { group: "Actions", title: "New sheet", icon: "Sheet", action: () => goto("/sheets") },
      {
        group: "Actions",
        title: "New slide deck",
        icon: "Image",
        action: () => goto("/slides"),
      },
      {
        group: "Actions",
        title: "Schedule meeting",
        icon: "Calendar",
        action: () => goto("/calendar"),
      },
      {
        group: "Actions",
        title: "Start a Helix Meet call",
        icon: "Video",
        action: () => goto("/meet"),
      },
      {
        group: "Settings",
        title: "Account settings",
        icon: "Settings",
        action: openSettings,
      },
      {
        group: "Settings",
        title: "Admin console",
        icon: "Shield",
        action: () => goto("/admin"),
      },
      ...PEOPLE.slice(0, 6).map((person) => ({
        group: "People",
        title: `Email ${person.name}`,
        sub: person.role,
        avatar: person.name,
        action: () => goto("/mail"),
      })),
      ...[
        "Q3 Roadmap — final draft",
        "Helix design principles",
        "Postmortem — Auth incident 05/15",
      ].map((title): PaletteItem => ({
        group: "Documents",
        title,
        icon: "Doc",
        action: () => goto("/docs"),
      })),
    ];
    if (!query) {
      return base;
    }
    const lower = query.toLowerCase();
    return base.filter(
      (item) =>
        item.title.toLowerCase().includes(lower) ||
        (item.sub ?? "").toLowerCase().includes(lower),
    );
  }, [query, goto, openSettings]);

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
        items[index]?.action();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
        onClick={(event) => event.stopPropagation()}
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
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search apps, docs, people, actions…"
            aria-label="Search apps, docs, people, actions"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 14,
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <div style={{ overflowY: "auto", flex: 1, padding: 6 }}>
          {Array.from(groups.entries()).map(([group, groupItems]) => (
            <div key={group}>
              <div
                style={{
                  fontSize: 10,
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
                return (
                  <button
                    key={`${item.group}-${item.title}-${myIndex}`}
                    type="button"
                    onClick={() => {
                      item.action();
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
                      fontSize: 13,
                      textAlign: "left",
                      background: active ? "var(--accent-soft)" : "transparent",
                      color: active ? "var(--accent)" : "var(--text)",
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
                      {item.sub ? (
                        <div
                          className="truncate"
                          style={{ fontSize: 11, color: "var(--text-3)" }}
                        >
                          {item.sub}
                        </div>
                      ) : null}
                    </div>
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
            fontSize: 11,
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
