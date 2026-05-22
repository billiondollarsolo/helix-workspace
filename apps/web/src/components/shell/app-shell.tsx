/* AppShell — the `_shell` route layout.
   Renders the always-dark left Rail, the surface `<Outlet/>`, and the
   cross-app overlays (notifications, ⌘K command palette, settings).

   Each surface renders its own `<SurfaceFrame>` (TopBar + body + side panel)
   inside the Outlet — mirroring the prototype where every app owns a
   `.workspace` element. Ported from the design handoff (app.jsx + shell.jsx). */

import { Outlet } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Rail } from "@/components/shell/rail";
import { AppLauncher } from "@/components/shell/app-launcher";
import {
  NotificationsPanel,
  UNREAD_NOTIFICATION_COUNT,
} from "@/components/shell/notifications-panel";
import { CommandPalette } from "@/components/shell/command-palette";
import { SettingsPage } from "@/components/shell/settings-page";
import {
  ShellOverlayContext,
  type ShellOverlayApi,
} from "@/components/shell/overlay-context";

export function AppShell() {
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const overlays = useMemo<ShellOverlayApi>(
    () => ({
      openNotifications: () => setNotifOpen(true),
      openPalette: () => setPaletteOpen(true),
      openSettings: () => {
        setPaletteOpen(false);
        setSettingsOpen(true);
      },
    }),
    [],
  );

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
        <Rail
          onOpenLauncher={() => setLauncherOpen((open) => !open)}
          notifUnread={UNREAD_NOTIFICATION_COUNT}
        />
        <AppLauncher open={launcherOpen} onClose={closeLauncher} />

        <Outlet />

        <NotificationsPanel open={notifOpen} onClose={() => setNotifOpen(false)} />
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          openSettings={overlays.openSettings}
        />
        <SettingsPage open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </div>
    </ShellOverlayContext.Provider>
  );
}
