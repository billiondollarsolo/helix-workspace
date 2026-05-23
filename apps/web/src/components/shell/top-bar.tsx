/* TopBar — surface title, search slot, action slot, theme toggle, bell,
   settings cog, profile avatar. Ported from the design handoff
   (shell.jsx → TopBar). 44px compact / 56px roomy via CSS.

   The search renders as a live `<input>` when `onSearchChange` is supplied
   (e.g. Mail's operator search); otherwise it is a button that opens the
   ⌘K command palette. */

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { sessionUserQueryOptions } from "@/lib/auth";
import { useShellOverlays } from "@/components/shell/overlay-context";
import { ProfileMenu } from "@/components/shell/profile-menu";
import { toggleTheme, useAppearance } from "@/components/settings-store";

export interface TopBarProps {
  /** Surface name shown left of search. */
  title: string;
  /** Icon next to the title. */
  icon?: ReactNode;
  /** Search input / palette button placeholder text. */
  searchPlaceholder?: string;
  /** Surface-specific action buttons rendered before the shell controls. */
  actions?: ReactNode;
  /** Unread notification count — drives the bell badge. */
  notifUnread?: number;
  /** Live search value. When provided with `onSearchChange`, search is a
   *  controlled input instead of a palette trigger. */
  searchValue?: string;
  /** Live search change handler — its presence switches search to a live input. */
  onSearchChange?: (value: string) => void;
}

export function TopBar({
  title,
  icon,
  searchPlaceholder = "Search",
  actions,
  notifUnread = 0,
  searchValue,
  onSearchChange,
}: TopBarProps) {
  const overlays = useShellOverlays();
  const theme = useAppearance((s) => s.theme);
  const [menuOpen, setMenuOpen] = useState(false);
  const sessionQuery = useQuery(sessionUserQueryOptions());
  const avatarName = sessionQuery.data?.name ?? sessionQuery.data?.email ?? "User";

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  const hasLiveSearch = typeof onSearchChange === "function";

  return (
    <div className="topbar" style={{ position: "relative" }}>
      <div className="topbar-title">
        {icon}
        <span>{title}</span>
      </div>
      <div style={{ width: 16 }} />
      {hasLiveSearch ? (
        <div className="search">
          <Icons.Search />
          <input
            value={searchValue ?? ""}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
          {searchValue ? (
            <button
              type="button"
              className="icon-btn"
              style={{ width: 22, height: 22 }}
              onClick={() => onSearchChange("")}
              aria-label="Clear search"
            >
              <Icons.X />
            </button>
          ) : (
            <span className="kbd">⌘K</span>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={overlays.openPalette}
          className="search"
          style={{ cursor: "pointer", textAlign: "left" }}
          aria-label="Open command palette"
        >
          <Icons.Search />
          <span style={{ flex: 1, color: "var(--text-3)", fontSize: "var(--text-body-sm)" }}>
            {searchPlaceholder}
          </span>
          <span className="kbd">⌘K</span>
        </button>
      )}
      <div className="row gap-2" style={{ marginLeft: "auto" }}>
        {actions}
        <button
          type="button"
          className="icon-btn"
          onClick={toggleTheme}
          title="Toggle theme"
          aria-label="Toggle theme"
        >
          {theme === "dark" ? <Icons.Sun /> : <Icons.Moon />}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={overlays.openNotifications}
          title="Notifications"
          aria-label="Notifications"
          style={{ position: "relative" }}
        >
          <Icons.Bell />
          {notifUnread > 0 ? (
            <span
              style={{
                position: "absolute",
                top: 4,
                right: 4,
                minWidth: 14,
                height: 14,
                padding: "0 3px",
                background: "var(--danger)",
                color: "white",
                fontSize: "var(--text-overline)",
                fontWeight: 700,
                borderRadius: 999,
                display: "grid",
                placeItems: "center",
                border: "2px solid var(--surface)",
              }}
            >
              {notifUnread}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={overlays.openSettings}
          title="Settings"
          aria-label="Settings"
        >
          <Icons.Settings />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((open) => !open);
          }}
          style={{
            borderRadius: 999,
            padding: 0,
            border: "none",
            background: "none",
            cursor: "pointer",
          }}
          aria-label="Profile"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <Avatar name={avatarName} size={28} />
        </button>
      </div>
      <ProfileMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        openSettings={overlays.openSettings}
      />
    </div>
  );
}
