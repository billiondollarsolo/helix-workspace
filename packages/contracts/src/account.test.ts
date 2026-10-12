import { describe, expect, it } from "vitest";
import { accountPreferencesSetInputSchema, accountWorkingHoursSchema } from "./account.js";

describe("account preferences trust boundary", () => {
  it("canonicalizes supported zones and rejects unknown zones and fields", () => {
    expect(accountPreferencesSetInputSchema.parse({ timeZone: "US/Eastern" })).toEqual({
      timeZone: "America/New_York",
    });
    expect(accountPreferencesSetInputSchema.safeParse({ timeZone: "Mars/Olympus" }).success).toBe(
      false,
    );
    expect(
      accountPreferencesSetInputSchema.safeParse({ detectedTimeZone: "Mars/Olympus" }).success,
    ).toBe(false);
    expect(accountPreferencesSetInputSchema.safeParse({ language: "en_US" }).success).toBe(false);
    expect(accountPreferencesSetInputSchema.safeParse({ mail: { unknown: true } }).success).toBe(
      false,
    );
    expect(accountPreferencesSetInputSchema.parse({ timeZone: null, language: "pt-BR" })).toEqual({
      timeZone: null,
      language: "pt-BR",
    });
  });

  it("rejects duplicate weekdays and reversed or malformed working hours", () => {
    const monday = { day: 1, start: "09:00", end: "17:00" };
    expect(accountWorkingHoursSchema.parse({ enabled: true, days: [monday] }).days).toEqual([
      monday,
    ]);
    for (const days of [
      [monday, monday],
      [{ ...monday, end: "08:59" }],
      [{ ...monday, end: "09:00" }],
      [{ ...monday, start: "24:00" }],
      [{ ...monday, day: 7 }],
    ]) {
      expect(accountWorkingHoursSchema.safeParse({ enabled: true, days }).success).toBe(false);
    }
  });
});
