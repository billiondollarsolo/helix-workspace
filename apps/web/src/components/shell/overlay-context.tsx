/* Shell overlay triggers — notifications, command palette, quick settings,
   settings page, keyboard shortcuts and About. Provided once by the `_shell`
   layout so any surface or shell control can open them. */

import { createContext, useContext } from "react";

const SETTINGS_SECTION_IDS = [
  "profile",
  "personal-info",
  "security",
  "app-passwords",
  "s3-keys",
  "language",
  "appearance",
  "shortcuts",
  "mail",
  "bots",
] as const;

export type SettingsSectionBaseId = (typeof SETTINGS_SECTION_IDS)[number];

/** A section, or `<section>/<tab>` to open one tab of a tabbed section (`mail/filters`). */
export type SettingsSectionId = SettingsSectionBaseId | `${SettingsSectionBaseId}/${string}`;

/** The section part of an id: `mail/filters` → `mail`. */
export function settingsSectionBase(id: SettingsSectionId): SettingsSectionBaseId {
  return id.split("/")[0] as SettingsSectionBaseId;
}

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  if (typeof value !== "string") return false;
  const [section, tab, ...rest] = value.split("/");
  return (
    (SETTINGS_SECTION_IDS as readonly string[]).includes(section ?? "") &&
    rest.length === 0 &&
    (tab === undefined || /^[a-z-]+$/u.test(tab))
  );
}

export interface ShellOverlayApi {
  /** Open the notifications panel. */
  openNotifications: () => void;
  /** Open the ⌘K command palette. */
  openPalette: () => void;
  /** Open the full-screen settings page. */
  openSettings: (section?: SettingsSectionId) => void;
  /** Open the quick settings drawer. */
  openQuickSettings: () => void;
  /** Open the keyboard-shortcuts help dialog. */
  openShortcuts: () => void;
  /** Open the About dialog. */
  openAbout: () => void;
}

export const ShellOverlayContext = createContext<ShellOverlayApi | null>(null);

/**
 * Access the shell overlay triggers. Must be used within the `_shell` layout.
 */
export function useShellOverlays(): ShellOverlayApi {
  const context = useContext(ShellOverlayContext);
  if (!context) {
    throw new Error("useShellOverlays must be used within the _shell layout");
  }
  return context;
}
