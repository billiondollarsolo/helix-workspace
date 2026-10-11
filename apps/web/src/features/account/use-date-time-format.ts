import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { createDateTimeFormat, type DateTimeFormat } from "@/lib/datetime-format";
import { accountPreferencesQueryOptions } from "./queries";

/**
 * Formatting that follows Settings → Language & region. Renders with browser
 * defaults until the preferences load, then re-renders with the saved ones.
 * See `@/lib/datetime-format` for the returned API.
 */
export function useDateTimeFormat(): DateTimeFormat {
  const { data } = useQuery(accountPreferencesQueryOptions());
  const language = data?.language ?? null;
  const timeZone = data?.timeZone ?? null;
  const dateFormat = data?.dateFormat ?? null;
  const timeFormat = data?.timeFormat ?? null;
  const weekStart = data?.weekStart ?? null;
  return useMemo(
    () => createDateTimeFormat({ language, timeZone, dateFormat, timeFormat, weekStart }),
    [language, timeZone, dateFormat, timeFormat, weekStart],
  );
}
