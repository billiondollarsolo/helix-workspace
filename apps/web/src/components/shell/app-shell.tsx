import { useWorkspacePresence } from "@/features/presence/presence";
/* AppShell — the `_shell` route layout.
   Renders the offline banner, the desktop Rail or phone BottomNav, the surface
   `<Outlet/>`, and the cross-app overlays (launcher, notifications, ⌘K
   palette, quick settings, About, settings).

   Each surface renders its own `<SurfaceFrame>` (TopBar + body + side panel)
   inside the Outlet. */

import { useQuery } from "@tanstack/react-query";
import { redirectToLogin, sessionUserQueryOptions } from "@/lib/auth";
import { Outlet, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rail } from "@/components/shell/rail";
import { BottomNav } from "@/components/shell/bottom-nav";
import { AppLauncher } from "@/components/shell/app-launcher";
import { AboutDialog } from "@/components/shell/help-menu";
import { useNavCollapsed } from "@/components/shell/nav-collapse";
import { QuickSettings } from "@/components/shell/quick-settings";
import { NotificationsPanel } from "@/components/shell/notifications-panel";
import { CommandPalette } from "@/components/shell/command-palette";
import { SecondFactorPrompt } from "@/components/shell/second-factor-prompt";
import { SettingsPage } from "@/components/shell/settings-page";
import { NetworkStatus } from "@/components/shell/network-status";
import { GlobalShortcuts, openShortcutsHelp } from "@/lib/shortcuts/global-shortcuts";
import { MailDialogsHost } from "@/features/mail/settings";
import { useEnabledApps } from "@/features/apps/use-enabled-apps";
import { chatUnreadQueryOptions } from "@/features/chat/queries";
import { mailFoldersQueryOptions } from "@/features/mail/queries";
import { useWorkspaceRealtime } from "@/features/presence/workspace-realtime";
import { ActionQueue } from "@/features/approvals/action-queue";
import { pendingActionsQueryOptions } from "@/features/approvals/api";
import {
  ShellOverlayContext,
  isSettingsSectionId,
  type SettingsSectionId,
  type ShellOverlayApi,
} from "@/components/shell/overlay-context";

export function AppShell() {
  const location = useLocation();
  const session = useQuery(sessionUserQueryOptions());
  const enabled = useEnabledApps();
  const signedIn = session.data != null;
  const actions = useQuery({ ...pendingActionsQueryOptions(), enabled: signedIn });
  const [actionsOpen, setActionsOpen] = useState(false);
  const closeActions = useCallback(() => setActionsOpen(false), []);
  const actionTrigger = { total: actions.data?.total, onOpen: () => setActionsOpen(true) };
  useWorkspacePresence(signedIn);
  const mail = useQuery({
    ...mailFoldersQueryOptions(),
    enabled: signedIn && enabled.isEnabled("mail"),
    refetchInterval: 30_000,
  });
  const chat = useQuery({
    ...chatUnreadQueryOptions(),
    enabled: signedIn && enabled.isEnabled("chat"),
  });
  useWorkspaceRealtime(signedIn);
  const unread = {
    mail: mail.data?.find((folder) => folder.id === "inbox")?.unread ?? 0,
    chat: chat.data?.totalUnread ?? 0,
  };
  useEffect(() => {
    if (session.data === null) redirectToLogin();
  }, [session.data]);
  const navigate = useNavigate();
  const shellSearch: Partial<{ settings: SettingsSectionId }> = useSearch({ strict: false });
  const settingsSection = isSettingsSectionId(shellSearch.settings) ? shellSearch.settings : null;
  const previousPathRef = useRef(location.pathname);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickSettingsOpen, setQuickSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const navCollapsed = useNavCollapsed();

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

  const overlays = useMemo<ShellOverlayApi>(() => {
    const openSettings = (section: SettingsSectionId = "profile") => {
      setPaletteOpen(false);
      setSettingsSection(section, false);
    };
    return {
      openNotifications: () => setNotifOpen(true),
      openPalette: () => setPaletteOpen(true),
      openSettings,
      openQuickSettings: () => setQuickSettingsOpen(true),
      openShortcuts: openShortcutsHelp,
      openAbout: () => setAboutOpen(true),
    };
  }, [setSettingsSection]);

  const closeSettings = useCallback(() => {
    setSettingsSection(undefined, true);
  }, [setSettingsSection]);

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

  if (session.data === null) return null;

  return (
    <ShellOverlayContext.Provider value={overlays}>
      <div className="app" data-nav-collapsed={navCollapsed || undefined}>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <NetworkStatus />
        <GlobalShortcuts
          onTogglePalette={() => setPaletteOpen((open) => !open)}
          onOpenShortcutSettings={() => overlays.openSettings("shortcuts")}
        />
        <Rail
          launcherOpen={launcherOpen}
          onOpenLauncher={() => setLauncherOpen((open) => !open)}
          unread={unread}
          actions={actionTrigger}
        >
          <AppLauncher open={launcherOpen} onClose={closeLauncher} />
        </Rail>

        <Outlet />

        <BottomNav unread={unread} actions={actionTrigger} />
        {actionsOpen ? <ActionQueue onClose={closeActions} /> : null}

        <NotificationsPanel open={notifOpen} onClose={() => setNotifOpen(false)} />
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          openSettings={overlays.openSettings}
        />
        <QuickSettings
          open={quickSettingsOpen}
          onOpenChange={setQuickSettingsOpen}
          onSeeAllSettings={() => overlays.openSettings()}
        />
        <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
        <SettingsPage
          open={settingsSection !== null}
          section={settingsSection ?? "profile"}
          onSectionChange={(section) => {
            setSettingsSection(section, true);
          }}
          onClose={closeSettings}
        />
        <MailDialogsHost />
        <SecondFactorPrompt onOpenSecuritySettings={() => overlays.openSettings("security")} />
      </div>
    </ShellOverlayContext.Provider>
  );
}
