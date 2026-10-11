/* Viewer preferences the calendar honours: week start, working hours, time
   zone, and whether weekends show in Week view.

   There is no account preferences API yet, so week start, working hours and
   time zone come from the browser locale through `browserCalendarPreferences`.
   When an account preferences source exists, give `useCalendarPreferences` a
   different `CalendarPreferencesSource`; nothing else changes. "Show weekends"
   is a per-browser view toggle, remembered in local storage. */

import { useCallback, useMemo, useState } from "react";
import type { WeekStartDay } from "./date-math";

export interface WorkingHours {
  /** Decimal hours, e.g. 9 and 17. */
  readonly start: number;
  readonly end: number;
  /** Weekdays, 0 = Sunday. */
  readonly days: readonly number[];
}

export interface CalendarPreferences {
  readonly weekStartsOn: WeekStartDay;
  readonly workingHours: WorkingHours;
  readonly timeZone: string;
  readonly showWeekends: boolean;
}

/** Where account-level preferences come from. */
export interface CalendarPreferencesSource {
  read(): Omit<CalendarPreferences, "showWeekends">;
}

const DEFAULT_WORKING_HOURS: WorkingHours = { start: 9, end: 17, days: [1, 2, 3, 4, 5] };

function localeWeekStart(): WeekStartDay {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      readonly weekInfo?: { readonly firstDay: number };
      getWeekInfo?: () => { readonly firstDay: number };
    };
    const firstDay = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay;
    if (firstDay === 1) return 1;
    if (firstDay === 6) return 6;
    return 0;
  } catch {
    return 0;
  }
}

export const browserCalendarPreferences: CalendarPreferencesSource = {
  read: () => ({
    weekStartsOn: localeWeekStart(),
    workingHours: DEFAULT_WORKING_HOURS,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  }),
};

const SHOW_WEEKENDS_KEY = "helix.calendar.showWeekends";

function readShowWeekends(): boolean {
  try {
    return window.localStorage.getItem(SHOW_WEEKENDS_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeShowWeekends(value: boolean): void {
  try {
    window.localStorage.setItem(SHOW_WEEKENDS_KEY, String(value));
  } catch {
    // Storage can be unavailable (private windows); the toggle still works for this visit.
  }
}

export function useCalendarPreferences(
  source: CalendarPreferencesSource = browserCalendarPreferences,
): {
  readonly preferences: CalendarPreferences;
  readonly setShowWeekends: (value: boolean) => void;
} {
  const base = useMemo(() => source.read(), [source]);
  const [showWeekends, setShowWeekendsState] = useState(readShowWeekends);
  const setShowWeekends = useCallback((value: boolean) => {
    setShowWeekendsState(value);
    writeShowWeekends(value);
  }, []);
  const preferences = useMemo(() => ({ ...base, showWeekends }), [base, showWeekends]);
  return { preferences, setShowWeekends };
}
