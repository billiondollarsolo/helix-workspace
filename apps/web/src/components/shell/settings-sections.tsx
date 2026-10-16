import { BotWorkspaces } from "@/features/bots/workspaces";
/* The settings sections in nav order, with the words people search for.
   Section ids are the `?settings=<section>[/<tab>]` values (overlay-context). */

import {
  Bot,
  CircleUserRound,
  Database,
  Globe,
  IdCard,
  Keyboard,
  KeyRound,
  Mail,
  Palette,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { MailSettingsSection } from "@/features/mail/settings";
import type { SettingsSectionBaseId, SettingsSectionId } from "./overlay-context";
import { AppPasswordsSection } from "./settings-app-passwords";
import { AppearanceSection } from "./settings-appearance";
import { LanguageRegionSection } from "./settings-language";
import { PersonalInfoSection, ProfileHomeSection } from "./settings-profile";
import { S3KeysSection } from "./settings-s3-keys";
import { SecuritySection } from "./settings-security";
import { ShortcutsSection } from "./settings-shortcuts";

/** Tabbed sections get the tab from `?settings=<section>/<tab>` and switch it here. */
export interface SettingsSectionProps {
  readonly tab: string | undefined;
  readonly onTabChange: (tab: string) => void;
  /** Open another section (or `<section>/<tab>`) inside settings. */
  readonly onNavigate: (section: SettingsSectionId) => void;
}

export interface SettingsSectionEntry {
  readonly id: SettingsSectionBaseId;
  readonly label: string;
  readonly group: "Account" | "Preferences" | "Apps";
  readonly icon: LucideIcon;
  /** Individual settings, shown as search results. */
  readonly settings: readonly string[];
  /** Extra words that should find the section. */
  readonly keywords: readonly string[];
  readonly Component: (props: SettingsSectionProps) => ReactNode;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionEntry[] = [
  {
    id: "bots",
    label: "Bot workspaces",
    group: "Apps",
    icon: Bot,
    settings: ["Bot mail", "Bot files", "Bot chats", "Bot activity"],
    keywords: ["agents", "oversight", "bot"],
    Component: BotWorkspaces,
  },
  {
    id: "profile",
    label: "Profile",
    group: "Account",
    icon: CircleUserRound,
    settings: ["Profile photo", "Account overview"],
    keywords: ["home", "avatar", "picture", "account"],
    Component: ProfileHomeSection,
  },
  {
    id: "personal-info",
    label: "Personal info",
    group: "Account",
    icon: IdCard,
    settings: ["Display name", "Pronouns", "Job title", "About", "Email address"],
    keywords: ["name", "bio", "title", "email"],
    Component: PersonalInfoSection,
  },
  {
    id: "security",
    label: "Security",
    group: "Account",
    icon: ShieldCheck,
    settings: [
      "Change password",
      "Your devices",
      "Sign out of other devices",
      "Passkeys",
      "Authenticator app",
      "Recovery codes",
    ],
    keywords: ["password", "sessions", "two-step", "2fa", "totp", "mfa", "sign out", "login"],
    Component: SecuritySection,
  },
  {
    id: "app-passwords",
    label: "App passwords",
    group: "Account",
    icon: KeyRound,
    settings: ["Create app password", "Revoke app password"],
    keywords: ["smtp", "caldav", "carddav", "webdav", "calendar app", "mail app", "sync"],
    Component: AppPasswordsSection,
  },
  {
    id: "s3-keys",
    label: "S3 access keys",
    group: "Account",
    icon: Database,
    settings: ["Create access key", "Revoke access key"],
    keywords: ["drive", "storage", "bucket", "rclone", "backup"],
    Component: S3KeysSection,
  },
  {
    id: "language",
    label: "Language & region",
    group: "Preferences",
    icon: Globe,
    settings: [
      "Language",
      "Time zone",
      "Date format",
      "Time format",
      "Start of week",
      "Working hours",
    ],
    keywords: ["locale", "clock", "12-hour", "24-hour", "calendar", "region"],
    Component: LanguageRegionSection,
  },
  {
    id: "appearance",
    label: "Appearance",
    group: "Preferences",
    icon: Palette,
    settings: ["Theme", "Density", "Text size", "Accent color"],
    keywords: ["dark mode", "light mode", "compact", "comfortable", "font", "color"],
    Component: AppearanceSection,
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    group: "Preferences",
    icon: Keyboard,
    settings: ["Keyboard shortcuts on or off", "Shortcut list"],
    keywords: ["keys", "hotkeys"],
    Component: ShortcutsSection,
  },
  {
    id: "mail",
    label: "Mail",
    group: "Apps",
    icon: Mail,
    settings: [
      "Reading pane",
      "Conversation view",
      "Signature",
      "Vacation responder",
      "Labels",
      "Filters",
      "Blocked addresses",
    ],
    keywords: ["email", "inbox", "out of office", "auto-reply"],
    Component: MailSettingsSection as SettingsSectionEntry["Component"],
  },
];

export interface SettingsSearchResult {
  readonly section: SettingsSectionEntry;
  /** The settings in the section that match, or none when the section itself does. */
  readonly matches: readonly string[];
}

/** Sections whose name, settings or keywords contain every word of the query. */
export function searchSettings(query: string): readonly SettingsSearchResult[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];
  const hit = (text: string) => words.every((word) => text.toLowerCase().includes(word));
  return SETTINGS_SECTIONS.flatMap((section) => {
    const matches = section.settings.filter(hit);
    const sectionHit = hit([section.label, ...section.keywords].join(" "));
    return matches.length > 0 || sectionHit ? [{ section, matches }] : [];
  });
}
