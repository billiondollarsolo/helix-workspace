import { iconMap as Icons } from "@/components/icon-map";
/* AppLauncher — the full app grid, three tiles per row. The rail carries only
   the pinned apps; this lists every enabled app plus search. Anchored beside
   the rail logo and closed by Escape or any click outside it. */

import { APPS } from "@/components/apps";
import { useEnabledApps } from "@/features/apps/use-enabled-apps";
import { Link } from "@tanstack/react-router";
import { Search as SearchIcon } from "lucide-react";
import { useEffect, useRef } from "react";

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
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !launcherRef.current?.contains(target) &&
        target.closest('[aria-controls="app-launcher"]') === null
      ) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelled = true;
      document.removeEventListener("pointerdown", onPointerDown);
      if (previousFocus?.isConnected === true) {
        previousFocus.focus();
      }
    };
  }, [open, onClose]);

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
      <div id="app-launcher-title" className="launcher-title">
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
                <Icon size={20} aria-hidden="true" />
              </span>
              <span>{app.name}</span>
            </Link>
          );
        })}
        <Link
          to="/search"
          preload="intent"
          role="menuitem"
          className="launcher-tile"
          onClick={onClose}
        >
          <span className="launcher-icon launcher-icon-neutral">
            <SearchIcon size={20} aria-hidden="true" />
          </span>
          <span>Search</span>
        </Link>
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
  return (((start + step) % length) + length) % length;
}
