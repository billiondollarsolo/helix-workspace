/* Helix shell — public surface for route layouts and surface agents. */

export { AppShell } from "@/components/shell/app-shell";
export { SurfaceFrame, type SurfaceFrameProps } from "@/components/shell/surface-frame";
export { TopBar, type TopBarProps } from "@/components/shell/top-bar";
export { Rail } from "@/components/shell/rail";
export { AppLauncher } from "@/components/shell/app-launcher";
export { HelixLogo } from "@/components/shell/helix-logo";
export { ProfileMenu } from "@/components/shell/profile-menu";
export {
  SidePanel,
  SidePanelRail,
  type SideTool,
} from "@/components/shell/side-panel";
export {
  NotificationsPanel,
  UNREAD_NOTIFICATION_COUNT,
} from "@/components/shell/notifications-panel";
export { CommandPalette } from "@/components/shell/command-palette";
export { SettingsPage } from "@/components/shell/settings-page";
export {
  ShellOverlayContext,
  useShellOverlays,
  type ShellOverlayApi,
} from "@/components/shell/overlay-context";
