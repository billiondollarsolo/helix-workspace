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
  /** Whether the app launcher popover is expanded. */
  launcherOpen: boolean;
  /** Open workspace help. */
  onOpenHelp: () => void;
}

export function Rail({ onOpenLauncher, launcherOpen, onOpenHelp }: RailProps) {
  const location = useLocation();
  const activeApp = appForRoute(location.pathname);
  const enabled = useEnabledApps();

  return (
    /* `nav`, not `div`: these are the product's primary destinations, and as a
       bare div their links sat outside every landmark — axe's `region` rule,
       and in practice a screen-reader user with no way to jump to app
       navigation. The label distinguishes it from the in-app navigation each
       surface renders. */
    <nav className="rail" aria-label="Apps">
      <button
        type="button"
        className="rail-logo"
        onClick={onOpenLauncher}
        aria-label="Helix apps"
        aria-expanded={launcherOpen}
        aria-controls="app-launcher"
        aria-haspopup="menu"
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
      <button type="button" className="rail-item" aria-label="Help" onClick={onOpenHelp}>
        <Icons.Help />
        <span className="rail-tip">Help</span>
      </button>
    </nav>
  );
}
