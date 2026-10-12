import type { CalendarRecord } from "../platform/calendar/types.js";

/** Calendar-store methods a fake store inherits when its suite does not exercise them. */
export class UnusedCalendarStoreMethods {
  createCalendar(): Promise<CalendarRecord> {
    return Promise.reject(new Error("createCalendar is not used in this suite"));
  }

  updateCalendar(): Promise<CalendarRecord | null> {
    return Promise.reject(new Error("updateCalendar is not used in this suite"));
  }

  deleteCalendar(): Promise<boolean> {
    return Promise.reject(new Error("deleteCalendar is not used in this suite"));
  }

  removeCalendarMembership(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
