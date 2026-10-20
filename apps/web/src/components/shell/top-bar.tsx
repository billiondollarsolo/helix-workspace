import {
  Bell as BellIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
  X as XIcon,
} from "lucide-react";
/* TopBar — navigation toggle, surface title, search, surface actions,
   notifications, quick settings and the account button.

   Search is always a real search form. A surface that passes `onSearchChange`
   owns the query (Mail searches mail, Drive searches files) and is told about
   Enter through `onSearchSubmit`. Otherwise Enter opens `/search?q=…`, scoped
   to the current app when its content is indexed. */

import { appForRoute } from "@/components/apps";
import { useShellOverlays } from "@/components/shell/overlay-context";
import { ProfileMenu } from "@/components/shell/profile-menu";
import { searchFilterForApp } from "@/features/search/route-search";
import { useShortcuts } from "@/lib/shortcuts/use-shortcuts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";

export interface TopBarProps {
  /** Surface name shown left of search. */
  title: string;
  /** Navigation toggle rendered before the title. */
  navigationToggle?: ReactNode;
  /** Icon next to the title. */
  icon?: ReactNode;
  /** Search placeholder text, also the field's accessible name. */
  searchPlaceholder?: string;
  /** A surface-specific search control, such as the administration directory. */
  searchContent?: ReactNode;
  /** Surface-specific action buttons rendered before the shell controls. */
  actions?: ReactNode;
  /** Unread notification count — drives the bell badge. */
  notifUnread?: number;
  /** Surface-owned query. Supply with `onSearchChange`. */
  searchValue?: string;
  /** Makes the surface own the query instead of opening `/search`. */
  onSearchChange?: (value: string) => void;
  /** Enter in a surface-owned search. */
  onSearchSubmit?: (value: string) => void;
}

export function TopBar({
  title,
  navigationToggle,
  icon,
  searchPlaceholder = "Search Helix",
  actions,
  searchContent,
  notifUnread = 0,
  searchValue,
  onSearchChange,
  onSearchSubmit,
}: TopBarProps) {
  const overlays = useShellOverlays();
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const surfaceOwnsSearch = typeof onSearchChange === "function";
  const value = surfaceOwnsSearch ? (searchValue ?? "") : draft;
  const setValue = surfaceOwnsSearch ? onSearchChange : setDraft;
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const customSearchRef = useRef<HTMLDivElement | null>(null);
  useShortcuts("global", {
    "global.focus-search": () => {
      if (searchContent) customSearchRef.current?.querySelector("input")?.focus();
      else searchInputRef.current?.focus();
    },
  });

  return (
    <header className="topbar">
      {navigationToggle}
      <div className="topbar-title">
        {icon}
        <span>{title}</span>
      </div>
      {searchContent ? (
        <div className="topbar-surface-search" ref={customSearchRef}>
          {searchContent}
        </div>
      ) : (
        <form
          role="search"
          className="search"
          onSubmit={(event) => {
            event.preventDefault();
            if (surfaceOwnsSearch) {
              onSearchSubmit?.(value);
              return;
            }
            const q = value.trim();
            if (q.length === 0) return;
            // Read at submit time: the app the person is in when they press Enter.
            const scope = searchFilterForApp(appForRoute(window.location.pathname)?.id);
            void navigate({ to: "/search", search: { q, ...(scope ? { type: scope } : {}) } });
          }}
        >
          <SearchIcon size={16} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="text"
            name={`${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-search`}
            autoComplete="off"
            enterKeyHint="search"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
          {value ? (
            <button
              type="button"
              className="icon-btn search-clear"
              onClick={() => setValue("")}
              aria-label="Clear search"
            >
              <XIcon size={16} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="search-palette"
              onClick={overlays.openPalette}
              aria-label="Open command palette"
              title="Command palette"
            >
              <span className="kbd" aria-hidden="true">
                ⌘K
              </span>
            </button>
          )}
        </form>
      )}
      <div className="topbar-actions">
        {actions}
        <button
          type="button"
          className="icon-btn relative"
          onClick={overlays.openNotifications}
          data-notifications-trigger
          title="Notifications"
          aria-label={
            notifUnread > 0 ? `Notifications, ${String(notifUnread)} unread` : "Notifications"
          }
        >
          <BellIcon size={16} aria-hidden="true" />
          {notifUnread > 0 ? (
            <span className="topbar-badge" aria-hidden="true">
              {notifUnread > 99 ? "99+" : notifUnread}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="icon-btn topbar-quick-settings"
          onClick={overlays.openQuickSettings}
          title="Quick settings"
          aria-label="Quick settings"
          aria-haspopup="dialog"
        >
          <SettingsIcon size={16} aria-hidden="true" />
        </button>
        <ProfileMenu openSettings={overlays.openSettings} />
      </div>
    </header>
  );
}
