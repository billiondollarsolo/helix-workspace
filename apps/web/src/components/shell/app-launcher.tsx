/* AppLauncher — 3-column grid of app tiles. Ported from the design handoff
   (shell.jsx → AppLauncher). Anchored below the Rail logo. */

import { useNavigate } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { APPS } from "@/components/apps";
import { useEnabledApps } from "@/features/apps/use-enabled-apps";

export interface AppLauncherProps {
  open: boolean;
  onClose: () => void;
}

export function AppLauncher({ open, onClose }: AppLauncherProps) {
  const navigate = useNavigate();
  const enabled = useEnabledApps();
  if (!open) {
    return null;
  }
  const visible = APPS.filter((app) => enabled.isEnabled(app.id));
  return (
    <div className="launcher" onClick={(event) => event.stopPropagation()}>
      <div
        style={{
          fontSize: "var(--text-caption)",
          color: "var(--text-3)",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: ".06em",
          padding: "4px 6px 8px",
        }}
      >
        Helix apps
      </div>
      <div className="launcher-grid">
        {visible.map((app) => {
          const Icon = Icons[app.icon];
          return (
            <button
              key={app.id}
              type="button"
              className="launcher-tile"
              onClick={() => {
                void navigate({ to: app.route });
                onClose();
              }}
            >
              <span className="launcher-icon" style={{ background: app.color }}>
                <Icon />
              </span>
              <span>{app.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
