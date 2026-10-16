import { iconMap as Icons } from "@/components/icon-map";
/* Phone navigation — a bottom bar with up to four apps and "More". The More
   sheet holds every other app plus search, settings and About. Hidden above
   the shell breakpoint, where the rail takes over. */

import { APPS, appForRoute, type HelixApp } from "@/components/apps";
import { useShellOverlays } from "@/components/shell/overlay-context";
import { useEnabledApps } from "@/features/apps/use-enabled-apps";
import { UnreadBadge, type AppUnreadCounts } from "@/components/shell/unread-badge";
import { Link, useLocation } from "@tanstack/react-router";
import {
  Ellipsis as MoreIcon,
  Info as InfoIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
  X as XIcon,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { useState } from "react";

/** Bottom-bar slots for apps; "More" takes the fifth. */
export const BOTTOM_NAV_APP_SLOTS = 4;

export function BottomNav({ unread }: { readonly unread?: AppUnreadCounts }) {
  const location = useLocation();
  const activeApp = appForRoute(location.pathname);
  const enabled = useEnabledApps();
  const overlays = useShellOverlays();
  const [moreOpen, setMoreOpen] = useState(false);

  const visible = APPS.filter((app) => enabled.isEnabled(app.id));
  const primary = visible.filter((app) => app.pinned).slice(0, BOTTOM_NAV_APP_SLOTS);
  const overflow = visible.filter((app) => !primary.includes(app));
  const moreActive =
    location.pathname === "/search" || overflow.some((app) => app.id === activeApp?.id);

  return (
    <nav className="bottom-nav" aria-label="Apps">
      {primary.map((app) => (
        <BottomNavLink
          key={app.id}
          app={app}
          active={activeApp?.id === app.id}
          unread={
            app.id === "mail" ? (unread?.mail ?? 0) : app.id === "chat" ? (unread?.chat ?? 0) : 0
          }
        />
      ))}
      <Dialog.Root open={moreOpen} onOpenChange={setMoreOpen}>
        <Dialog.Trigger className="bottom-nav-item" data-active={moreActive || undefined}>
          <span className="bottom-nav-pill" aria-hidden="true">
            <MoreIcon size={18} />
          </span>
          <span className="bottom-nav-label">More</span>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="sheet-overlay" />
          <Dialog.Content className="more-sheet" aria-describedby={undefined}>
            <div className="more-sheet-header">
              <Dialog.Title className="more-sheet-title">More</Dialog.Title>
              <Dialog.Close className="icon-btn" aria-label="Close">
                <XIcon size={16} aria-hidden="true" />
              </Dialog.Close>
            </div>
            <ul className="more-sheet-grid">
              {overflow.map((app) => {
                const Icon = Icons[app.icon];
                return (
                  <li key={app.id}>
                    <Link
                      to={app.route}
                      className="launcher-tile"
                      aria-current={activeApp?.id === app.id ? "page" : undefined}
                      onClick={() => setMoreOpen(false)}
                    >
                      <span className="launcher-icon" style={{ background: app.color }}>
                        <Icon size={20} aria-hidden="true" />
                      </span>
                      <span>{app.name}</span>
                    </Link>
                  </li>
                );
              })}
              <li>
                <Link to="/search" className="launcher-tile" onClick={() => setMoreOpen(false)}>
                  <span className="launcher-icon launcher-icon-neutral">
                    <SearchIcon size={20} aria-hidden="true" />
                  </span>
                  <span>Search</span>
                </Link>
              </li>
            </ul>
            <div className="more-sheet-actions">
              <button
                type="button"
                className="more-sheet-action"
                onClick={() => {
                  setMoreOpen(false);
                  overlays.openSettings();
                }}
              >
                <SettingsIcon size={16} aria-hidden="true" />
                Settings
              </button>
              <button
                type="button"
                className="more-sheet-action"
                onClick={() => {
                  setMoreOpen(false);
                  overlays.openAbout();
                }}
              >
                <InfoIcon size={16} aria-hidden="true" />
                About Helix
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </nav>
  );
}

function BottomNavLink({
  app,
  active,
  unread,
}: {
  readonly app: HelixApp;
  readonly active: boolean;
  readonly unread: number;
}) {
  const Icon = Icons[app.icon];
  const badgeId = `bottom-${app.id}-unread`;
  return (
    <Link
      to={app.route}
      className="bottom-nav-item"
      aria-label={app.name}
      aria-current={active ? "page" : undefined}
      data-active={active || undefined}
      aria-describedby={unread > 0 ? badgeId : undefined}
    >
      <span className="bottom-nav-pill" aria-hidden="true">
        <Icon size={18} />
      </span>
      <span className="bottom-nav-label">{app.name}</span>
      <UnreadBadge count={unread} id={badgeId} />
    </Link>
  );
}
