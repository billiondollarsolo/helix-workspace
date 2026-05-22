/* Left icon Rail — 52px, always dark. Ported from the design handoff
   (shell.jsx → Rail). Helix logo opens the app launcher; app icons navigate;
   active app gets a 2px violet tick. Notifications / Help / user avatar pinned
   to the bottom. */

import { Link, useLocation } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { APPS, appForRoute } from "@/components/apps";
import { Avatar } from "@/components/ui/avatar";
import { CURRENT_USER } from "@/components/people";
import { useShellOverlays } from "@/components/shell/overlay-context";
import { HelixLogo } from "@/components/shell/helix-logo";

export interface RailProps {
  /** Open the app launcher popover. */
  onOpenLauncher: () => void;
  /** Unread notification count — drives the bell dot. */
  notifUnread: number;
}

export function Rail({ onOpenLauncher, notifUnread }: RailProps) {
  const location = useLocation();
  const overlays = useShellOverlays();
  const activeApp = appForRoute(location.pathname);

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
      {APPS.map((app) => {
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
      <button
        type="button"
        className="rail-item"
        aria-label="Notifications"
        onClick={overlays.openNotifications}
      >
        <Icons.Bell />
        {notifUnread > 0 ? (
          <span
            style={{
              position: "absolute",
              top: 7,
              right: 7,
              width: 6,
              height: 6,
              borderRadius: 999,
              background: "var(--accent)",
            }}
          />
        ) : null}
        <span className="rail-tip">Notifications</span>
      </button>
      <button type="button" className="rail-item" aria-label="Help">
        <Icons.Help />
        <span className="rail-tip">Help</span>
      </button>
      <div style={{ marginTop: 8 }}>
        <Avatar name={CURRENT_USER.name} size={28} />
      </div>
    </div>
  );
}
