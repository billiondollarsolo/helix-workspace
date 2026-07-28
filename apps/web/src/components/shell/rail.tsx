/* Left icon Rail — 52px, always dark. Ported from the design handoff
   (shell.jsx → Rail). Helix logo opens the app launcher; app icons navigate;
   active app gets a 2px violet tick. Notifications and Profile live in the
   TopBar; only Help is pinned here at the bottom. */

import { Link, useLocation } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { APPS, appForRoute } from "@/components/apps";
import { HelixLogo } from "@/components/shell/helix-logo";
import { useEnabledApps } from "@/features/apps/use-enabled-apps";

export interface RailProps {
  /** Open the app launcher popover. */
  onOpenLauncher: () => void;
}

export function Rail({ onOpenLauncher }: RailProps) {
  const location = useLocation();
  const activeApp = appForRoute(location.pathname);
  const enabled = useEnabledApps();

  return (
    <div className="rail">
      <button
        type="button"
        className="rail-logo"
        onClick={onOpenLauncher}
        aria-label="Helix apps"
        title="Apps"
      >
        <HelixLogo size={22} />
      </button>
      <div className="rail-divider" />
      {APPS.filter((app) => enabled.isEnabled(app.id)).map((app) => {
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
            <Icon />
            <span className="rail-tip">{app.name}</span>
          </Link>
        );
      })}
      <div className="rail-spacer" />
      <button type="button" className="rail-item" aria-label="Help">
        <Icons.Help />
        <span className="rail-tip">Help</span>
      </button>
    </div>
  );
}
