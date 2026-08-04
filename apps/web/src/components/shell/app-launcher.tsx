/* AppLauncher — 3-column grid of app tiles. Ported from the design handoff
   (shell.jsx → AppLauncher). Anchored below the Rail logo. */

import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Icons } from "@/components/icons";
import { APPS } from "@/components/apps";
import { useEnabledApps } from "@/features/apps/use-enabled-apps";

export interface AppLauncherProps {
  open: boolean;
  onClose: () => void;
}

export function AppLauncher({ open, onClose }: AppLauncherProps) {
  const enabled = useEnabledApps();
  const launcherRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        launcherItems(launcherRef.current)[0]?.focus();
      }
    });
    return () => {
      cancelled = true;
      if (previousFocus?.isConnected === true) {
        previousFocus.focus();
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }
  const visible = APPS.filter((app) => enabled.isEnabled(app.id));
  return (
    <div
      ref={launcherRef}
      id="app-launcher"
      className="launcher"
      role="menu"
      aria-labelledby="app-launcher-title"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        const items = launcherItems(launcherRef.current);
        const current = items.indexOf(document.activeElement as HTMLElement);
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        const nextIndex = launcherNextIndex(event.key, current, items.length);
        if (nextIndex !== null) {
          event.preventDefault();
          items[nextIndex]?.focus();
        }
      }}
    >
      <div
        id="app-launcher-title"
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
            <Link
              key={app.id}
              to={app.route}
              preload="intent"
              role="menuitem"
              className="launcher-tile"
              onClick={onClose}
            >
              <span className="launcher-icon" style={{ background: app.color }}>
                <Icon />
              </span>
              <span>{app.name}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function launcherItems(root: HTMLElement | null): HTMLElement[] {
  return root === null ? [] : Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

/* Arrow-key step through the tile grid. Up/down move a whole row, which is
   the launcher's column count. */
const LAUNCHER_COLUMNS = 3;
const LAUNCHER_ARROW_STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowLeft: -1,
  ArrowDown: LAUNCHER_COLUMNS,
  ArrowUp: -LAUNCHER_COLUMNS,
};

function launcherNextIndex(key: string, current: number, length: number): number | null {
  if (length === 0) {
    return null;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return length - 1;
  }
  const step = LAUNCHER_ARROW_STEPS[key];
  if (step === undefined) {
    return null;
  }
  const start = current < 0 ? 0 : current;
  return (start + step + length) % length;
}
