import {
  Bell as BellIcon,
  Moon as MoonIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Sun as SunIcon,
  X as XIcon,
} from "lucide-react";
/* TopBar — surface title, search slot, action slot, theme toggle, bell,
   settings cog, profile avatar. Ported from the design handoff
   (shell.jsx → TopBar). 44px compact / 56px roomy via CSS.

   The search renders as a live `<input>` when `onSearchChange` is supplied
   (e.g. Mail's operator search); otherwise it is a button that opens the
   ⌘K command palette. */

import { toggleTheme, useAppearance } from "@/components/settings-store";
import { useShellOverlays } from "@/components/shell/overlay-context";
import { ProfileMenu } from "@/components/shell/profile-menu";
import { Avatar } from "@/components/ui/avatar";
import { sessionUserQueryOptions } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";

export interface TopBarProps {
  /** Surface name shown left of search. */
  title: string;
  navigationToggle?: ReactNode;
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
  navigationToggle,
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
  const profileButtonRef = useRef<HTMLButtonElement | null>(null);
  const sessionQuery = useQuery(sessionUserQueryOptions());
  const avatarName = sessionQuery.data?.name ?? sessionQuery.data?.email ?? "User";

  const hasLiveSearch = typeof onSearchChange === "function";

  return (
    <header className="topbar relative">
      {navigationToggle}
      <div className="topbar-title">
        {icon}
        <span>{title}</span>
      </div>
      <div className="w-4" />
      {hasLiveSearch ? (
        <div className="search">
          <SearchIcon size={16} />
          <input
            name={`${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-search`}
            value={searchValue ?? ""}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
          {searchValue ? (
            <button
              type="button"
              className="icon-btn w-5.5 h-5.5"

              onClick={() => onSearchChange("")}
              aria-label="Clear search"
            >
              <XIcon size={16} />
            </button>
          ) : (
            <span className="kbd">⌘K</span>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={overlays.openPalette}
          className="search cursor-pointer text-left"

          aria-label="Open command palette"
        >
          <SearchIcon size={16} />
          <span className="flex-1 text-muted-foreground [font-size:var(--text-body-sm)]">
            {searchPlaceholder}
          </span>
          <span className="kbd">⌘K</span>
        </button>
      )}
      <div className="topbar-actions row gap-2 ml-auto">
        {actions}
        <button
          type="button"
          className="icon-btn"
          onClick={toggleTheme}
          title="Toggle theme"
          aria-label="Toggle theme"
        >
          {theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        </button>
        <button
          type="button"
          className="icon-btn relative"
          onClick={overlays.openNotifications}
          title="Notifications"
          aria-label="Notifications"
        >
          <BellIcon size={16} />
          {notifUnread > 0 ? (
            <span className="absolute top-1 right-1 min-w-3.5 h-3.5 [padding:0_3px] [background:var(--danger)] [color:white] [font-size:var(--text-overline)] font-bold [border-radius:999px] grid [place-items:center] [border:2px_solid_var(--surface)]">
              {notifUnread}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => overlays.openSettings()}
          title="Settings"
          aria-label="Settings"
        >
          <SettingsIcon size={16} />
        </button>
        <button
          ref={profileButtonRef}
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          className="[border-radius:999px] p-0 [border:none] [background:none] cursor-pointer"
          aria-label="Profile"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls="profile-menu"
        >
          <Avatar name={avatarName} size={28} />
        </button>
      </div>
      <ProfileMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={profileButtonRef}
        openSettings={overlays.openSettings}
      />
    </header>
  );
}
