import { iconMap as Icons } from "@/components/icon-map";
import { ChevronDown as ChevronDownIcon } from "lucide-react";
/* The admin console's grouped section navigation: Home, then Directory, Apps,
 * Security, Reporting and Account. Groups fold, and the fold is remembered;
 * the group holding the current page always stays open. */

import {
  ADMIN_NAV_GROUPS,
  ADMIN_NAV_ROOT,
  type AdminSectionId,
} from "@/features/admin/admin-console-data";
import { useAdminRealtimeState } from "@/features/admin/use-admin-realtime";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

const COLLAPSED_GROUPS_KEY = "helix.admin.nav.collapsed-groups";

function readCollapsedGroups(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function writeCollapsedGroups(titles: readonly string[]): void {
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(titles));
  } catch {
    /* Private mode or a full quota: the fold still works for this visit. */
  }
}

function groupSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
}

interface AdminNavItem {
  readonly id: AdminSectionId;
  readonly label: string;
  readonly icon: keyof typeof Icons;
}

function AdminNavLink({
  item,
  active,
  onPreload,
}: {
  readonly item: AdminNavItem;
  readonly active: boolean;
  readonly onPreload?: (id: AdminSectionId) => void;
}) {
  const Icon = Icons[item.icon];
  /* All sections share one route, so the router's intent preload cannot warm
     a section's chunk; hover and focus do it here. */
  const preload = onPreload === undefined ? undefined : () => onPreload(item.id);
  return (
    <Link
      to="/admin/$section"
      params={{ section: item.id }}
      aria-current={active ? "page" : undefined}
      className="surf-nav-row"
      onPointerEnter={preload}
      onFocus={preload}
    >
      <Icon size={16} aria-hidden="true" />
      <span className="label">{item.label}</span>
    </Link>
  );
}

export function AdminSidebar({
  section,
  onPreloadSection,
}: {
  readonly section: AdminSectionId;
  /** Warms a section's chunk and data on hover/focus. */
  readonly onPreloadSection?: (id: AdminSectionId) => void;
}) {
  const navRef = useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState<readonly string[]>(readCollapsedGroups);

  function toggleGroup(title: string): void {
    setCollapsed((previous) => {
      const next = previous.includes(title)
        ? previous.filter((entry) => entry !== title)
        : [...previous, title];
      writeCollapsedGroups(next);
      return next;
    });
  }

  useEffect(() => {
    /* Deep links to the last rows (Webhooks) must not land on a nav that
       appears to be missing them. jsdom has no scrollIntoView. */
    const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [section]);

  return (
    <nav className="surf-sidebar admin-nav" aria-label="Administration" ref={navRef}>
      <AdminNavLink
        item={ADMIN_NAV_ROOT}
        active={section === ADMIN_NAV_ROOT.id}
        onPreload={onPreloadSection}
      />
      {ADMIN_NAV_GROUPS.map((group) => {
        const slug = groupSlug(group.title);
        const headingId = `admin-nav-${slug}`;
        const listId = `admin-nav-${slug}-list`;
        const holdsActive = group.items.some((item) => item.id === section);
        const open = holdsActive || !collapsed.includes(group.title);
        return (
          <div className="admin-nav-group" key={group.title}>
            <h2 className="admin-nav-group-title" id={headingId}>
              {holdsActive ? (
                <span className="admin-nav-group-heading">{group.title}</span>
              ) : (
                <button
                  type="button"
                  className="admin-nav-group-heading admin-nav-group-toggle"
                  aria-expanded={open}
                  aria-controls={listId}
                  onClick={() => {
                    toggleGroup(group.title);
                  }}
                >
                  <span className="admin-nav-group-label">{group.title}</span>
                  <ChevronDownIcon
                    className="admin-nav-group-chevron"
                    size={14}
                    aria-hidden="true"
                  />
                </button>
              )}
            </h2>
            <ul id={listId} aria-labelledby={headingId} hidden={!open}>
              {group.items.map((item) => (
                <li key={item.id}>
                  <AdminNavLink
                    item={item}
                    active={section === item.id}
                    onPreload={onPreloadSection}
                  />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <AdminRealtimeIndicator />
    </nav>
  );
}

/* Shown only while live updates are down, so a dead connection never reads as
   a quiet system. A section with no live updates has nothing to report. */
function AdminRealtimeIndicator() {
  const state = useAdminRealtimeState();
  if (state === "live" || state === "idle") {
    return null;
  }
  return (
    <p className="admin-nav-realtime" data-state={state} role="status">
      {state === "offline"
        ? "Live updates are off. Pages refresh on their own schedule."
        : "Connecting to live updates…"}
    </p>
  );
}
