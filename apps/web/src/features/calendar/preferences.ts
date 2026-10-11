/* Viewer preferences the calendar honours: week start, working hours, time
   zone and 12/24-hour clock from `account.preferences`, falling back to the
   browser locale for anything the person has not chosen. "Show weekends" is a
   per-browser view toggle, remembered in local storage. */

import type { AccountPreferences } from "@helix/contracts";
import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { accountPreferencesQueryOptions } from "@/features/account/queries";
import { clockToHour, type TimeFormat, type WeekStartDay } from "./date-math";

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
  readonly timeFormat: TimeFormat;
  readonly showWeekends: boolean;
}

const DEFAULT_WORKING_HOURS: WorkingHours = { start: 9, end: 17, days: [1, 2, 3, 4, 5] };

function localeWeekStart(): WeekStartDay {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      readonly weekInfo?: { readonly firstDay: number };
      getWeekInfo?: () => { readonly firstDay: number };
    };
    // Intl numbers days 1 (Monday) to 7 (Sunday).
    const firstDay = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay;
    return firstDay === undefined ? 0 : ((firstDay % 7) as WeekStartDay);
  } catch {
    return 0;
  }
}

function localeTimeFormat(): TimeFormat {
  const cycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h23" || cycle === "h24" ? "24h" : "12h";
}

function workingHoursFrom(value: AccountPreferences["workingHours"]): WorkingHours {
  if (value === null || !value.enabled || value.days.length === 0) return DEFAULT_WORKING_HOURS;
  return {
    start: Math.min(...value.days.map((day) => clockToHour(day.start))),
    end: Math.max(...value.days.map((day) => clockToHour(day.end))),
    days: value.days.map((day) => day.day).sort((left, right) => left - right),
  };
}

/** Account preferences with browser-locale fallbacks for unset fields. */
export function calendarPreferencesFrom(
  account: AccountPreferences | undefined,
): Omit<CalendarPreferences, "showWeekends"> {
  return {
    weekStartsOn: (account?.weekStart ?? localeWeekStart()) as WeekStartDay,
    workingHours: workingHoursFrom(account?.workingHours ?? null),
    timeZone: account?.timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
    timeFormat: account?.timeFormat ?? localeTimeFormat(),
  };
}

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

export function useCalendarPreferences(): {
  readonly preferences: CalendarPreferences;
  readonly setShowWeekends: (value: boolean) => void;
} {
  const account = useQuery(accountPreferencesQueryOptions()).data;
  const base = useMemo(() => calendarPreferencesFrom(account), [account]);
  const [showWeekends, setShowWeekendsState] = useState(readShowWeekends);
  const setShowWeekends = useCallback((value: boolean) => {
    setShowWeekendsState(value);
    writeShowWeekends(value);
  }, []);
  const preferences = useMemo(() => ({ ...base, showWeekends }), [base, showWeekends]);
  return { preferences, setShowWeekends };
}

const TimeFormatContext = createContext<TimeFormat>("12h");

/** Provides the viewer's clock to every calendar component below the shell. */
export const TimeFormatProvider = TimeFormatContext.Provider;

export function useTimeFormat(): TimeFormat {
  return useContext(TimeFormatContext);
}
