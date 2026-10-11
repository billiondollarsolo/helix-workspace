// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notify, type NotifyOptions } from "@/components/ui/toast";
import { sessionQueryKeys } from "@/lib/auth";
import { shortcutRegistry } from "@/lib/shortcuts/registry";
import type { CalendarApiEvent } from "./api";
import { CalendarShell, type CalendarShellProps } from "./calendar-shell";
import type { CalendarPreferencesSource } from "./preferences";
import { defaultCalendarRouteState, type CalendarRouteState } from "./route-state";

vi.mock("@/components/ui/toast", () => ({ notify: vi.fn(), dismissNotification: vi.fn() }));

const SESSION_USER = {
  id: "user-1",
  actorId: "actor-me",
  name: "Rae Gomez",
  email: "rae@helix.test",
};
const CALENDAR = {
  id: "cal-1",
  name: "Rae's calendar",
  color: "#0f766e",
  role: "owner",
  visible: true,
  group: "mine",
  writable: true,
  timezone: "UTC",
};
const utcPreferences: CalendarPreferencesSource = {
  read: () => ({
    weekStartsOn: 0,
    workingHours: { start: 9, end: 17, days: [1, 2, 3, 4, 5] },
    timeZone: "UTC",
  }),
};

function apiEvent(overrides: Partial<CalendarApiEvent> = {}): CalendarApiEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    calendarId: "cal-1",
    title: "Planning",
    startsAt: "2026-05-20T09:00:00.000Z",
    endsAt: "2026-05-20T10:00:00.000Z",
    timezone: "UTC",
    timeSemantics: "zoned",
    allDay: false,
    status: "confirmed",
    attendees: [],
    ...overrides,
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

interface ToolCall {
  readonly tool: string;
  readonly body: Record<string, unknown>;
}

describe("CalendarShell", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let calls: ToolCall[];
  let state: CalendarRouteState;

  const mockBackend = (
    events: readonly CalendarApiEvent[],
    options: { offline?: boolean } = {},
  ) => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (options.offline) return Promise.reject(new Error("network down"));
        const url = requestUrl(input);
        if (url.endsWith("/auth/csrf-token")) {
          return Promise.resolve(Response.json({ csrfToken: "csrf" }));
        }
        const tool = url.split("/tools/")[1] ?? url;
        calls.push({
          tool,
          body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
            string,
            unknown
          >,
        });
        if (tool === "calendar.event.list") return Promise.resolve(Response.json({ events }));
        if (tool === "calendar.calendars.list") {
          return Promise.resolve(Response.json({ calendars: [CALENDAR] }));
        }
        if (tool === "meet.create-room") {
          return Promise.resolve(Response.json({ id: "room-1", joinCode: "abc-defg-hij" }));
        }
        if (tool === "calendar.event.create" || tool === "calendar.event.update") {
          return Promise.resolve(Response.json(apiEvent({ title: "Saved" })));
        }
        return Promise.resolve(Response.json({ ok: true }));
      }),
    );
  };

  const render = (overrides: Partial<CalendarRouteState> = {}, props: CalendarShellProps = {}) => {
    state = { ...defaultCalendarRouteState, date: "2026-05-20", ...overrides };
    const draw = () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <CalendarShell
            routeState={state}
            onRouteStateChange={(next) => {
              state = next;
              draw();
            }}
            preferencesSource={utcPreferences}
            {...props}
          />
        </QueryClientProvider>,
      );
    act(draw);
  };

  const flush = async () => {
    for (let tick = 0; tick < 12; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };

  const chip = (title: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button[data-calendar-event]")].find((node) =>
      node.getAttribute("aria-label")?.startsWith(title),
    );
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.getAttribute("aria-label") === name || node.textContent?.trim() === name,
    );
  const press = (key: string) =>
    act(() => {
      shortcutRegistry.handleKeyDown(new KeyboardEvent("keydown", { key, bubbles: true }), {
        enabled: true,
        overlayOpen: false,
        isMac: false,
      });
    });
  const typeInto = (input: HTMLInputElement, value: string) =>
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  /** Click an empty slot at `hour` on `day` (the column is given a 24px-per-hour box). */
  const clickSlot = (day: string, hour: number) => {
    const column = document.querySelector<HTMLElement>(`[data-day="${day}"]`);
    if (column === null) throw new Error(`no column ${day}`);
    vi.spyOn(column, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 24 * 24 }),
    );
    const at = { bubbles: true, button: 0, clientX: 10, clientY: hour * 24 + 6 };
    act(() => {
      column.dispatchEvent(new MouseEvent("pointerdown", at));
      window.dispatchEvent(new MouseEvent("pointerup", at));
    });
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-20T12:00:00.000Z"));
    vi.mocked(notify).mockClear();
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    queryClient.setQueryData(sessionQueryKeys.current, SESSION_USER);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("draws a 24-hour week and marks only the real today", async () => {
    mockBackend([
      apiEvent({
        title: "Late review",
        startsAt: "2026-05-20T21:00:00.000Z",
        endsAt: "2026-05-20T22:30:00.000Z",
      }),
    ]);
    render();
    await flush();

    expect(document.querySelectorAll("[data-day]")).toHaveLength(7);
    expect(document.querySelectorAll(".cal-hour-label")).toHaveLength(24);
    const todays = document.querySelectorAll('[aria-current="date"]');
    expect(todays).toHaveLength(2); // grid header + sidebar mini-month
    expect(document.querySelector('[data-day="2026-05-20"] .cal-now-line')).not.toBeNull();
    expect(document.querySelectorAll(".cal-now-line")).toHaveLength(1);
    expect(chip("Late review")?.getAttribute("aria-label")).toContain("9 – 10:30pm");

    render({ date: "2026-05-27" });
    await flush();
    expect(document.querySelectorAll(".cal-grid [aria-current='date']")).toHaveLength(0);
    expect(document.querySelectorAll(".cal-now-line")).toHaveLength(0);
  });

  it("switches between Day, 3-day, Week, Month and Schedule with the keyboard", async () => {
    mockBackend([apiEvent()]);
    render();
    await flush();

    press("d");
    expect(state.view).toBe("day");
    expect(document.querySelectorAll("[data-day]")).toHaveLength(1);
    press("x");
    expect(document.querySelectorAll("[data-day]")).toHaveLength(3);
    press("m");
    await flush();
    expect(document.querySelector('[role="region"][aria-label="Month"]')).not.toBeNull();
    expect(document.querySelectorAll(".cal-month-cell")).toHaveLength(42);
    press("a");
    await flush();
    expect(document.querySelector('[role="region"][aria-label="Schedule"]')?.textContent).toContain(
      "Planning",
    );
    press("w");
    press("j");
    expect(state).toMatchObject({ view: "week", date: "2026-05-27" });
    press("t");
    expect(state.date).toBe("2026-05-20");
  });

  it("creates an event from an empty slot with quick create", async () => {
    mockBackend([]);
    render();
    await flush();

    clickSlot("2026-05-21", 14);
    const dialog = document.querySelector('[role="dialog"][aria-label="Create event"]');
    expect(dialog?.textContent).toContain("Thursday, May 21 · 2 – 3pm");
    const title = dialog?.querySelector<HTMLInputElement>('input[aria-label="Title"]');
    expect(title).not.toBeNull();
    typeInto(title as HTMLInputElement, "Standup");
    act(() => button("Save")?.click());
    await flush();

    const create = calls.find((call) => call.tool === "calendar.event.create");
    expect(create?.body).toMatchObject({
      calendarId: "cal-1",
      title: "Standup",
      startsAt: "2026-05-21T14:00:00.000Z",
      endsAt: "2026-05-21T15:00:00.000Z",
      recurrenceRule: null,
      metadata: { alarms: [{ minutesBefore: 10 }], transparency: "opaque" },
    });
    expect(document.querySelector('[aria-label="Create event"][role="dialog"]')).toBeNull();
  });

  it("opens the full editor from quick create and saves a weekly repeat", async () => {
    mockBackend([]);
    render();
    await flush();

    clickSlot("2026-05-20", 9);
    act(() => button("More options")?.click());
    const editor = document.querySelector("[data-calendar-editor]");
    expect(editor).not.toBeNull();
    expect(editor?.querySelector('input[placeholder^="FREQ"]')).toBeNull();
    const repeat = [...(editor?.querySelectorAll("select") ?? [])].find((select) =>
      [...select.options].some((option) => option.value === "weekly"),
    );
    expect([...(repeat?.options ?? [])].map((option) => option.text)).toContain(
      "Weekly on Wednesday",
    );
    act(() => {
      if (repeat) {
        repeat.value = "weekly";
        repeat.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    act(() => button("Save")?.click());
    await flush();

    expect(calls.find((call) => call.tool === "calendar.event.create")?.body).toMatchObject({
      startsAt: "2026-05-20T09:00:00.000Z",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=WE",
    });
  });

  it("adds video conferencing by creating a Meet room on save", async () => {
    mockBackend([]);
    render();
    await flush();

    press("c");
    act(() => button("Add video conferencing")?.click());
    expect(document.querySelector("[data-calendar-editor]")?.textContent).toContain(
      "A video call link will be added when you save",
    );
    act(() => button("Save")?.click());
    await flush();

    const room = calls.findIndex((call) => call.tool === "meet.create-room");
    const create = calls.findIndex((call) => call.tool === "calendar.event.create");
    expect(room).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(room);
    expect(calls[room]?.body).toMatchObject({
      scheduledStartAt: "2026-05-20T13:00:00.000Z",
      scheduledEndAt: "2026-05-20T14:00:00.000Z",
    });
    expect(calls[create]?.body).toMatchObject({
      metadata: {
        conference: {
          provider: "helix-meet",
          roomId: "room-1",
          joinCode: "abc-defg-hij",
          url: "/meet?code=abc-defg-hij",
        },
      },
    });
  });

  it("shows event details with Join, recurrence, guests and Going? Yes / No / Maybe", async () => {
    mockBackend([
      apiEvent({
        recurrenceRule: "FREQ=WEEKLY;BYDAY=WE",
        metadata: {
          conference: {
            provider: "helix-meet",
            roomId: "r1",
            joinCode: "abc",
            url: "/meet?code=abc",
          },
        },
        attendees: [
          {
            email: "boss@helix.test",
            displayName: "Avery Park",
            isOrganizer: true,
            responseStatus: "accepted",
          },
          {
            actorId: "actor-me",
            email: "rae@helix.test",
            displayName: "Old name",
            responseStatus: "needs_action",
          },
        ],
      }),
    ]);
    const onEmailGuests = vi.fn();
    render({}, { onEmailGuests });
    await flush();

    act(() => chip("Planning")?.click());
    expect(state.eventId).toBe("11111111-1111-4111-8111-111111111111");
    const popover = document.querySelector("[data-calendar-popover]");
    expect(popover?.querySelector("h2")?.textContent).toBe("Planning");
    expect(popover?.textContent).toContain("Wednesday, May 20 · 9 – 10am");
    expect(popover?.textContent).toContain("Weekly on Wednesday");
    expect(popover?.textContent).toContain("Organizer");
    expect(popover?.textContent).toContain("Rae Gomez");
    expect(popover?.textContent).toContain("1 yes, 1 awaiting");
    const join = popover?.querySelector<HTMLAnchorElement>("a[href='/meet?code=abc']");
    expect(join?.textContent).toContain("Join");
    for (const name of ["Edit event", "Delete event", "Email guests", "Close"]) {
      expect(button(name)).toBeDefined();
    }
    act(() => button("Email guests")?.click());
    expect(onEmailGuests).toHaveBeenCalledWith(["boss@helix.test", "rae@helix.test"]);
    const going = popover?.querySelector('[role="group"]');
    expect(going?.textContent).toContain("Going?");
    act(() => button("Yes")?.click());
    await flush();
    expect(calls.find((call) => call.tool === "calendar.event.respond")?.body).toEqual({
      eventId: "11111111-1111-4111-8111-111111111111",
      responseStatus: "accepted",
    });
  });

  it("deletes with Undo and only commits when the snackbar closes", async () => {
    mockBackend([apiEvent()]);
    render();
    await flush();

    act(() => chip("Planning")?.click());
    press("Delete");
    expect(chip("Planning")).toBeUndefined();
    const first = vi.mocked(notify).mock.calls.at(-1)?.[0] as NotifyOptions;
    expect(first.message).toBe("Event deleted");
    act(() => first.action?.onAction());
    expect(chip("Planning")).toBeDefined();
    expect(calls.some((call) => call.tool === "calendar.event.delete")).toBe(false);

    act(() => chip("Planning")?.click());
    act(() => button("Delete event")?.click());
    const second = vi.mocked(notify).mock.calls.at(-1)?.[0] as NotifyOptions;
    act(() => second.onClose?.("timeout"));
    await flush();
    expect(calls.find((call) => call.tool === "calendar.event.delete")?.body).toMatchObject({
      eventId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("moves an event with Alt+arrow keys and offers Undo", async () => {
    mockBackend([apiEvent()]);
    render();
    await flush();

    act(() => {
      chip("Planning")?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }),
      );
    });
    await flush();
    expect(calls.find((call) => call.tool === "calendar.event.update")?.body).toMatchObject({
      patch: { startsAt: "2026-05-20T09:15:00.000Z", endsAt: "2026-05-20T10:15:00.000Z" },
    });
    expect((vi.mocked(notify).mock.calls.at(-1)?.[0] as NotifyOptions).action?.label).toBe("Undo");
  });

  it("opens the editor prefilled from a person's Schedule a meeting handoff", async () => {
    mockBackend([]);
    const onCreateIntentHandled = vi.fn();
    render({}, { createIntent: { attendees: ["sam@helix.test"] }, onCreateIntentHandled });
    await flush();

    const editor = document.querySelector("[data-calendar-editor]");
    expect(editor?.textContent).toContain("sam@helix.test");
    expect(onCreateIntentHandled).toHaveBeenCalledTimes(1);
  });

  it("shows actionable errors when the calendar service is unreachable", async () => {
    mockBackend([], { offline: true });
    render();
    await flush();

    const alerts = [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
    expect(alerts.some((text) => text?.includes("Couldn't load events"))).toBe(true);
    expect(alerts.some((text) => text?.includes("Couldn't load your calendars"))).toBe(true);
    expect(button("Retry")).toBeDefined();
  });
});
