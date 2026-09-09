/* AppShell — the `_shell` route layout.
   Renders the always-dark left Rail, the surface `<Outlet/>`, and the
   cross-app overlays (notifications, ⌘K command palette, settings).

   Each surface renders its own `<SurfaceFrame>` (TopBar + body + side panel)
   inside the Outlet — mirroring the prototype where every app owns a
   `.workspace` element. Ported from the design handoff (app.jsx + shell.jsx). */

import { Outlet, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rail } from "@/components/shell/rail";
import { AppLauncher } from "@/components/shell/app-launcher";
import { NotificationsPanel } from "@/components/shell/notifications-panel";
import { CommandPalette } from "@/components/shell/command-palette";
import { SettingsPage } from "@/components/shell/settings-page";
import { NetworkStatus } from "@/components/shell/network-status";
import {
  ShellOverlayContext,
  isSettingsSectionId,
  type SettingsSectionId,
  type ShellOverlayApi,
} from "@/components/shell/overlay-context";

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const shellSearch: Partial<{ settings: SettingsSectionId }> = useSearch({ strict: false });
  const settingsSection = isSettingsSectionId(shellSearch.settings) ? shellSearch.settings : null;
  const previousPathRef = useRef(location.pathname);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  /* The settings overlay lives in `?settings=<section>` so it survives reload
     and back/forward. Every open/switch/close is the same navigation with a
     different section value. */
  const setSettingsSection = useCallback(
    (section: SettingsSectionId | undefined, replace: boolean) => {
      void navigate({
        to: location.pathname,
        replace,
        search: (previous: Record<string, unknown>) => ({
          ...previous,
          settings: section,
        }),
      } as never);
    },
    [location.pathname, navigate],
  );

  const overlays = useMemo<ShellOverlayApi>(
    () => ({
      openNotifications: () => setNotifOpen(true),
      openPalette: () => setPaletteOpen(true),
      openSettings: (section = "profile") => {
        setPaletteOpen(false);
        setSettingsSection(section, false);
      },
    }),
    [setSettingsSection],
  );

  const closeSettings = useCallback(() => {
    setSettingsSection(undefined, true);
  }, [setSettingsSection]);

  // ⌘K global shortcut.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (previousPathRef.current === location.pathname) {
      return;
    }
    previousPathRef.current = location.pathname;
    queueMicrotask(() => {
      document.getElementById("main-content")?.focus({ preventScroll: true });
    });
  }, [location.pathname]);

  const closeLauncher = useCallback(() => setLauncherOpen(false), []);

  return (
    <ShellOverlayContext.Provider value={overlays}>
      <div
        className="app"
        onClick={() => {
          if (launcherOpen) {
            setLauncherOpen(false);
          }
        }}
      >
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <NetworkStatus />
        <Rail
          launcherOpen={launcherOpen}
          onOpenLauncher={() => setLauncherOpen((open) => !open)}
          onOpenHelp={() => overlays.openSettings("shortcuts")}
        />
        <AppLauncher open={launcherOpen} onClose={closeLauncher} />

        <Outlet />

        <NotificationsPanel open={notifOpen} onClose={() => setNotifOpen(false)} />
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          openSettings={overlays.openSettings}
        />
        <SettingsPage
          open={settingsSection !== null}
          section={settingsSection ?? "profile"}
          onSectionChange={(section) => {
            setSettingsSection(section, true);
          }}
          onClose={closeSettings}
        />
      </div>
    </ShellOverlayContext.Provider>
  );
}
