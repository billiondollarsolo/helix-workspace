/* Mail view preferences: the reading pane layout and sender avatars.

   The reading pane is saved to the account (`account.preferences.mail.readingPane`)
   through the shared account preferences cache, so Mail, Settings and quick
   settings agree; local storage is the fallback while the preferences cannot
   be loaded. Avatars are a per-device choice. */

import type { AccountPreferences, AccountWorkingHours } from "@helix/contracts";
import { MAIL_READING_PANES } from "@helix/contracts";
import { useQuery } from "@tanstack/react-query";
import { Store } from "@tanstack/store";
import { useCallback, useSyncExternalStore } from "react";
import {
  accountPreferencesQueryOptions,
  useSetAccountPreferences,
} from "@/features/account/queries";

export type MailReadingPane = (typeof MAIL_READING_PANES)[number];

export const READING_PANE_OPTIONS: readonly { value: MailReadingPane; label: string }[] = [
  { value: "none", label: "No split" },
  { value: "right", label: "Right of inbox" },
  { value: "below", label: "Below inbox" },
];

interface MailViewSettings {
  readonly readingPane: MailReadingPane;
  readonly showAvatars: boolean;
}

const STORAGE_KEY = "helix-mail-view";
const DEFAULTS: MailViewSettings = { readingPane: "none", showAvatars: true };

function isReadingPane(value: unknown): value is MailReadingPane {
  return typeof value === "string" && (MAIL_READING_PANES as readonly string[]).includes(value);
}

function readStorage(): MailViewSettings {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "{}",
    ) as Partial<MailViewSettings>;
    return {
      readingPane: isReadingPane(parsed.readingPane) ? parsed.readingPane : DEFAULTS.readingPane,
      showAvatars:
        typeof parsed.showAvatars === "boolean" ? parsed.showAvatars : DEFAULTS.showAvatars,
    };
  } catch {
    return DEFAULTS;
  }
}

const mailViewStore = new Store<MailViewSettings>(
  typeof window === "undefined" ? DEFAULTS : readStorage(),
);

function updateMailView(patch: Partial<MailViewSettings>): void {
  mailViewStore.setState((previous) => ({ ...previous, ...patch }));
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(mailViewStore.state));
  } catch {
    /* storage may be unavailable (private mode); the in-memory value still applies */
  }
}

function useMailView<T>(select: (settings: MailViewSettings) => T): T {
  return useSyncExternalStore(
    (onChange) => {
      const subscription = mailViewStore.subscribe(onChange);
      return () => subscription.unsubscribe();
    },
    () => select(mailViewStore.state),
    () => select(mailViewStore.state),
  );
}

function useAccountPreferences(): Partial<AccountPreferences> | undefined {
  return useQuery(accountPreferencesQueryOptions()).data;
}

/** The reading pane layout: the account's saved choice (shared with Settings), else this device's. */
export function useMailReadingPane(): MailReadingPane {
  const saved = useAccountPreferences()?.mail?.readingPane;
  const local = useMailView((settings) => settings.readingPane);
  return isReadingPane(saved) ? saved : local;
}

/** Setter for the reading pane, for Mail's own menu and the shell's quick settings. */
export function useSetMailReadingPane(): (pane: MailReadingPane) => void {
  const { mutate } = useSetAccountPreferences();
  return useCallback(
    (pane: MailReadingPane) => {
      updateMailView({ readingPane: pane });
      mutate({ mail: { readingPane: pane } });
    },
    [mutate],
  );
}

export function useMailShowAvatars(): boolean {
  return useMailView((settings) => settings.showAvatars);
}

export function setMailShowAvatars(showAvatars: boolean): void {
  updateMailView({ showAvatars });
}

/** Working hours from account preferences, used for snooze times. */
export function useAccountWorkingHours(): AccountWorkingHours | null {
  return useAccountPreferences()?.workingHours ?? null;
}
