import { iconMap as Icons } from "@/components/icon-map";
/* Desktop navigation rail — always dark. The logo opens the app launcher, the
   pinned apps navigate, and Help sits at the bottom. Phones use `BottomNav`
   instead; the two swap at the shell breakpoint in CSS. */

import { APPS, appForRoute } from "@/components/apps";
import { HelixLogo } from "@/components/shell/helix-logo";
import { HelpMenu } from "@/components/shell/help-menu";
import { useEnabledApps } from "@/features/apps/use-enabled-apps";
import { Link, useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";

export interface RailProps {
  /** Open the app launcher popover. */
  onOpenLauncher: () => void;
  /** Whether the app launcher popover is expanded. */
  launcherOpen: boolean;
  /** The app launcher, rendered inside the navigation landmark. */
  children?: ReactNode;
}

export function Rail({ onOpenLauncher, launcherOpen, children }: RailProps) {
  const location = useLocation();
  const activeApp = appForRoute(location.pathname);
  const enabled = useEnabledApps();

  return (
    <nav className="rail" aria-label="Apps">
      <button
        type="button"
        className="rail-logo"
        onClick={(event) => {
          event.stopPropagation();
          onOpenLauncher();
        }}
        aria-label="Helix apps"
        aria-expanded={launcherOpen}
        aria-controls="app-launcher"
        aria-haspopup="menu"
        title="Helix apps"
      >
        <HelixLogo size={22} />
      </button>
      {children}
      <div className="rail-divider" />
      {APPS.filter((app) => app.pinned && enabled.isEnabled(app.id)).map((app) => {
        const Icon = Icons[app.icon];
        const active = activeApp?.id === app.id;
        return (
          <Link
            key={app.id}
            to={app.route}
            className={active ? "rail-item active" : "rail-item"}
            aria-label={app.name}
            aria-current={active ? "page" : undefined}
          >
            <Icon size={16} aria-hidden="true" />
            <span className="rail-tip" aria-hidden="true">
              {app.name}
            </span>
          </Link>
        );
      })}
      <div className="rail-spacer" />
      <HelpMenu />
    </nav>
  );
}
