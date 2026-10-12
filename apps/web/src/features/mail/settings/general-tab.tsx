/* General: account preferences that shape Mail (saved as you change them),
   then the signature and vacation responder forms (saved with their own
   buttons, like the rest of the page's long-form fields). */

import type { AccountPreferences } from "@helix/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/toast";
import { useShellOverlays } from "@/components/shell/overlay-context";
import {
  accountPreferencesQueryOptions,
  useSetAccountPreferences,
} from "@/features/account/queries";
import { ChoiceRow, SettingRow, SettingsGroupHeading } from "./setting-row";
import { errorText, useRetry } from "./mutations";
import { SignatureForm } from "./signature-form";
import { VacationForm } from "./vacation-form";

/** Mail sends wait this long before leaving, so Undo can stop them. */
const UNDO_SEND_SECONDS = 30;

type MailPreferences = AccountPreferences["mail"];

const READING_PANE_OPTIONS = [
  { value: "none", label: "No split" },
  { value: "right", label: "Right of inbox" },
  { value: "below", label: "Below inbox" },
] as const satisfies readonly { value: MailPreferences["readingPane"]; label: string }[];

const DENSITY_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
] as const satisfies readonly { value: MailPreferences["density"]; label: string }[];

const CONVERSATION_OPTIONS = [
  { value: "on", label: "Conversation view on" },
  { value: "off", label: "Conversation view off" },
] as const;

export function GeneralTab() {
  return (
    <>
      <PreferenceRows />
      <SettingsGroupHeading>Signature</SettingsGroupHeading>
      <SignatureForm />
      <SettingsGroupHeading>Vacation responder</SettingsGroupHeading>
      <VacationForm />
    </>
  );
}

/** "Deutsch" for `de`; POSIX suffixes such as `@posix` are dropped. */
function languageName(locale: string): string {
  const tag = locale.split("@")[0] ?? locale;
  try {
    return new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

function PreferenceRows() {
  const preferences = useQuery(accountPreferencesQueryOptions());
  const retry = useRetry(accountPreferencesQueryOptions().queryKey);
  const save = useSetAccountPreferences();
  const { openSettings } = useShellOverlays();
  /* Shown at once: the cache's optimistic update lands a tick after the click,
     so a controlled radio would snap back to the old value in between. */
  const [pending, setPending] = useState<Partial<MailPreferences>>({});

  if (preferences.data === undefined) {
    return preferences.error === null ? (
      <Skeleton variant="text" count={6} label="Loading mail preferences" className="py-4" />
    ) : (
      <InlineError
        title="Couldn't load your mail preferences"
        message={errorText(preferences.error, "Check your connection and try again.")}
        onRetry={retry}
        retrying={preferences.isFetching}
      />
    );
  }

  const { language, timeZone } = preferences.data;
  const mail = { ...preferences.data.mail, ...pending };
  const setMail = (patch: Partial<MailPreferences>) => {
    setPending((current) => ({ ...current, ...patch }));
    save.mutate(
      { mail: patch },
      {
        // Clear only what this save set; a newer click on the same row stays.
        onSettled: () =>
          setPending((current) =>
            Object.fromEntries(
              Object.entries(current).filter(
                ([key, value]) => patch[key as keyof MailPreferences] !== value,
              ),
            ),
          ),
        onError: (error) =>
          notify({
            tone: "error",
            message: "Couldn't save that setting",
            description: errorText(error, "Check your connection and try again."),
          }),
      },
    );
  };
  const browserLanguage = typeof navigator === "undefined" ? "en" : navigator.language;
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <>
      <SettingRow title="Language and time zone" hint="Set for your whole account">
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 type-body-sm">
          <dt className="text-muted-foreground">Language</dt>
          <dd className="m-0">
            {language === null
              ? `${languageName(browserLanguage)} (from your browser)`
              : languageName(language)}
          </dd>
          <dt className="text-muted-foreground">Time zone</dt>
          <dd className="m-0">{timeZone ?? `${deviceZone} (from your device)`}</dd>
        </dl>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mt-1 h-auto px-0"
          onClick={() => openSettings("language")}
        >
          Change in Language &amp; region
        </Button>
      </SettingRow>
      <ChoiceRow
        title="Conversation view"
        hint="Group replies to the same message together"
        name="mail-conversation-view"
        options={CONVERSATION_OPTIONS}
        value={mail.conversationView ? "on" : "off"}
        onChange={(value) => setMail({ conversationView: value === "on" })}
      />
      <ChoiceRow
        title="Reading pane"
        hint="Where an opened conversation shows"
        name="mail-reading-pane"
        options={READING_PANE_OPTIONS}
        value={mail.readingPane}
        onChange={(readingPane) => setMail({ readingPane })}
      />
      <ChoiceRow
        title="Density"
        hint="Spacing of the conversation list"
        name="mail-density"
        options={DENSITY_OPTIONS}
        value={mail.density}
        onChange={(density) => setMail({ density })}
      />
      <SettingRow title="Undo send" hint="Set for your workspace">
        <p className="m-0 type-body-sm">
          You can undo a send for {UNDO_SEND_SECONDS} seconds after you click Send.
        </p>
      </SettingRow>
    </>
  );
}
