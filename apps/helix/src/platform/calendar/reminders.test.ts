import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMINDER_MINUTES_BEFORE,
  InMemoryReminderDispatchLedger,
  parseEventReminders,
  reminderDispatchKey,
} from "./reminders.js";

describe("parseEventReminders (CAL.9)", () => {
  it("defaults to 10 minutes when metadata omits reminders", () => {
    expect(parseEventReminders(undefined)).toEqual([
      { minutesBefore: DEFAULT_REMINDER_MINUTES_BEFORE },
    ]);
  });

  it("parses list and single forms and allows explicit opt-out", () => {
    expect(
      parseEventReminders({
        reminders: [{ minutesBefore: 30 }, { minutesBefore: 5 }],
      }),
    ).toEqual([{ minutesBefore: 30 }, { minutesBefore: 5 }]);
    expect(parseEventReminders({ reminderMinutesBefore: 15 })).toEqual([
      { minutesBefore: 15 },
    ]);
    expect(parseEventReminders({ reminders: [] })).toEqual([]);
  });

  it("drops invalid entries (negative)", () => {
    expect(
      parseEventReminders({
        reminders: [{ minutesBefore: -1 }, "bad", { minutesBefore: 10 }],
      }),
    ).toEqual([{ minutesBefore: 10 }]);
  });
});

describe("reminderDispatchKey", () => {
  it("is stable for idempotent dispatch", () => {
    const key = reminderDispatchKey({
      orgId: "org",
      eventId: "evt",
      minutesBefore: 10,
      occurrenceStartsAt: new Date("2026-08-02T15:00:00.000Z"),
    });
    expect(key).toContain("org");
    expect(key).toContain("evt");
    expect(key).toContain("10");
    const ledger = new InMemoryReminderDispatchLedger();
    expect(ledger.has(key)).toBe(false);
    ledger.mark(key);
    expect(ledger.has(key)).toBe(true);
  });
});
