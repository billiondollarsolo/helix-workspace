/* Language & region: language, time zone, date and time formats, start of
   week and working hours, saved to `account.preferences`. "Automatic"
   (null) follows this device. */

import type { AccountPreferences, AccountPreferencesSetInput } from "@helix/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import {
  accountPreferencesQueryOptions,
  useSetAccountPreferences,
} from "@/features/account/queries";
import { browserTimeZone, createDateTimeFormat } from "@/lib/datetime-format";
import { SettingsCard, SettingsField, SettingsHeader, SettingsStatus } from "./settings-controls";
import { TimeZonePicker } from "./time-zone-picker";
import { WorkingHoursEditor } from "./settings-working-hours";

/** Helix ships in English only; other languages appear here once translated. */
const SUPPORTED_LANGUAGES = [{ value: "en", label: "English" }] as const;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Examples show 9 October 2026 at 3:05 in the afternoon, whatever the zone. */
const SAMPLE = new Date(Date.UTC(2026, 9, 9, 15, 5));

export function LanguageRegionSection() {
  const queryClient = useQueryClient();
  const query = useQuery(accountPreferencesQueryOptions());
  const preferences = query.data;
  return (
    <>
      <SettingsHeader
        title="Language & region"
        description="How Helix shows dates, times and your working week"
      />
      {preferences === undefined ? (
        query.isError ? (
          <InlineError
            title="Your preferences didn’t load"
            message={query.error.message}
            retrying={query.isFetching}
            onRetry={() => {
              void queryClient.invalidateQueries({
                queryKey: accountPreferencesQueryOptions().queryKey,
              });
            }}
          />
        ) : (
          <Skeleton variant="card" count={2} label="Loading preferences" />
        )
      ) : (
        <PreferencesForm preferences={preferences} />
      )}
    </>
  );
}

function PreferencesForm({ preferences }: { readonly preferences: AccountPreferences }) {
  const mutation = useSetAccountPreferences();
  const [status, setStatus] = useState<string | null>(null);
  const ids = { language: useId(), zone: useId(), zoneHint: useId(), week: useId() };
  const device = createDateTimeFormat({ timeZone: "UTC" });
  const zone = preferences.timeZone ?? browserTimeZone();

  const save = (input: AccountPreferencesSetInput, what: string) => {
    setStatus(null);
    mutation.mutate(input, { onSuccess: () => setStatus(`${what} saved.`) });
  };

  return (
    <>
      <SettingsCard title="Language">
        <SettingsField
          label="Language"
          controlId={ids.language}
          hint="Helix is available in English."
        >
          <select id={ids.language} className="select" defaultValue="en">
            {SUPPORTED_LANGUAGES.map((language) => (
              <option key={language.value} value={language.value}>
                {language.label}
              </option>
            ))}
          </select>
        </SettingsField>
      </SettingsCard>

      <SettingsCard
        title="Region"
        description="Used for times and dates across Mail, Calendar and Chat"
      >
        <SettingsField label="Time zone" controlId={ids.zone}>
          <TimeZonePicker
            id={ids.zone}
            value={zone}
            describedBy={ids.zoneHint}
            onChange={(next) => save({ timeZone: next }, "Time zone")}
          />
          <p id={ids.zoneHint} className="m-0 mt-1 type-caption text-muted-foreground">
            {preferences.timeZone === null
              ? "Following this device’s time zone."
              : preferences.timeZone === browserTimeZone()
                ? "Matches this device."
                : `This device is set to ${browserTimeZone().replaceAll("_", " ")}.`}
          </p>
          {preferences.timeZone !== null && preferences.timeZone !== browserTimeZone() ? (
            <button
              type="button"
              className="btn sm mt-2"
              onClick={() => save({ timeZone: browserTimeZone() }, "Time zone")}
            >
              Use this device’s time zone
            </button>
          ) : null}
        </SettingsField>
        <ChoiceField
          legend="Date format"
          name="dateFormat"
          value={preferences.dateFormat}
          automatic={device.numericDate(SAMPLE)}
          options={[
            { value: "mdy", label: "Month first", sample: "10/09/2026" },
            { value: "dmy", label: "Day first", sample: "09/10/2026" },
            { value: "ymd", label: "Year first", sample: "2026-10-09" },
          ]}
          onChange={(dateFormat) => save({ dateFormat }, "Date format")}
        />
        <ChoiceField
          legend="Time format"
          name="timeFormat"
          value={preferences.timeFormat}
          automatic={device.time(SAMPLE)}
          options={[
            { value: "12h", label: "12-hour", sample: "3:05 PM" },
            { value: "24h", label: "24-hour", sample: "15:05" },
          ]}
          onChange={(timeFormat) => save({ timeFormat }, "Time format")}
        />
        <SettingsField label="Start of week" controlId={ids.week}>
          <select
            id={ids.week}
            className="select"
            value={preferences.weekStart === null ? "auto" : String(preferences.weekStart)}
            onChange={(event) =>
              save(
                { weekStart: event.target.value === "auto" ? null : Number(event.target.value) },
                "Start of week",
              )
            }
          >
            <option value="auto">Automatic ({WEEKDAYS[device.weekStart]})</option>
            {[0, 1, 6].map((day) => (
              <option key={day} value={String(day)}>
                {WEEKDAYS[day]}
              </option>
            ))}
          </select>
        </SettingsField>
      </SettingsCard>

      <SettingsCard
        title="Working hours"
        description="Let people know when you’re usually available for meetings"
      >
        <WorkingHoursEditor
          value={preferences.workingHours}
          pending={mutation.isPending}
          onSave={(workingHours) => save({ workingHours }, "Working hours")}
        />
      </SettingsCard>

      {mutation.isError ? (
        <InlineError variant="compact" title="Not saved" message={mutation.error.message} />
      ) : null}
      <SettingsStatus message={mutation.isPending ? "Saving…" : status} />
    </>
  );
}

function ChoiceField<TValue extends string>({
  legend,
  name,
  value,
  automatic,
  options,
  onChange,
}: {
  readonly legend: string;
  readonly name: string;
  readonly value: TValue | null;
  /** Today's example in the device format. */
  readonly automatic: string;
  readonly options: readonly {
    readonly value: TValue;
    readonly label: string;
    readonly sample: string;
  }[];
  readonly onChange: (value: TValue | null) => void;
}) {
  const choices: readonly { value: TValue | null; label: ReactNode }[] = [
    {
      value: null,
      label: (
        <>
          Automatic <Sample>{automatic}</Sample>
        </>
      ),
    },
    ...options.map((option) => ({
      value: option.value,
      label: (
        <>
          {option.label} <Sample>{option.sample}</Sample>
        </>
      ),
    })),
  ];
  return (
    <fieldset className="m-0 grid gap-1.5 border-0 border-t border-border p-0 py-3.5 @xl:grid-cols-[200px_minmax(0,1fr)] @xl:gap-6">
      <legend className="float-left p-0 type-body-sm font-medium">{legend}</legend>
      <div className="grid gap-2">
        {choices.map((choice) => (
          <label key={choice.value ?? "auto"} className="flex items-center gap-2 type-body-sm">
            <input
              type="radio"
              name={name}
              checked={value === choice.value}
              onChange={() => onChange(choice.value)}
              className="focus-ring accent-[var(--accent)]"
            />
            <span>{choice.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Sample({ children }: { readonly children: ReactNode }) {
  return <span className="text-muted-foreground">({children})</span>;
}
