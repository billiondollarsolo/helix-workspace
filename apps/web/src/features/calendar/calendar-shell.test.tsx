// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarShell } from "./calendar-shell";

const suggestionSlotHarness = vi.hoisted(() => ({
  calls: [] as Array<{ readonly slotId: string; readonly context: unknown }>,
}));

vi.mock("@helix/sdk-web", () => ({
  SuggestionSlot: ({
    context,
    emptyFallback,
    slotId,
  }: {
    readonly context?: unknown;
    readonly emptyFallback?: React.ReactNode;
    readonly slotId: string;
  }) => {
    suggestionSlotHarness.calls.push({ slotId, context });
    return (
      <div data-testid={`suggestion-slot-${slotId}`}>
        {emptyFallback ?? null}
      </div>
    );
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const eventId = "33333333-3333-4333-8333-333333333333";
const deepLinkedEventId = "55555555-5555-4555-8555-555555555555";

describe("CalendarShell backend tool integration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 0,
        },
      },
    });
    suggestionSlotHarness.calls.length = 0;
    fetchMock = vi.fn<typeof fetch>((input) => {
      if (input === "/api/tools/calendar.find-time") {
        return Promise.resolve(
          Response.json({
            slots: [
              {
                startsAt: "2026-05-21T14:00:00.000Z",
                endsAt: "2026-05-21T14:30:00.000Z",
                busy: [],
              },
            ],
          }),
        );
      }
      if (input === "/api/tools/calendar.event.list") {
        return Promise.resolve(
          Response.json({
            events: [backendEvent("Backend planning")],
          }),
        );
      }
      if (input === "/api/tools/calendar.event.create") {
        return Promise.resolve(Response.json(backendEvent("Backend planning")));
      }
      if (input === "/api/tools/calendar.event.respond") {
        return Promise.resolve(
          Response.json({
            ...backendEvent("Backend planning"),
            attendees: [
              {
                id: "attendee-sam",
                email: "sam@helix.test",
                displayName: "Sam Patel",
                responseStatus: "accepted",
              },
            ],
          }),
        );
      }
      if (input === "/api/tools/calendar.event.delete") {
        return Promise.resolve(Response.json({ deleted: true, eventId, cancellationsQueued: 0 }));
      }
      return Promise.resolve(Response.json({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("loads backend find-time slots and creates events through calendar.event.create", async () => {
    renderCalendar();

    await waitForText("Backend planning");
    await waitForText("Thu 21");
    await waitForText("2:00 PM-2:30 PM");

    await clickButton("Create");
    await waitForText("Backend planning");

    const createCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/calendar.event.create",
    );
    expect(jsonBody(createCall)).toMatchObject({
      calendarId: null,
      title: "New event",
      startsAt: "2026-05-20T09:00:00.000Z",
      endsAt: "2026-05-20T10:00:00.000Z",
      sendInvitations: false,
    });
  });

  it("responds to backend events through calendar.event.respond", async () => {
    renderCalendar();
    await waitForText("Backend planning");
    await waitForText("From backend calendar tool");

    await clickRsvpButton("yes");

    const respondCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/calendar.event.respond",
    );
    expect(jsonBody(respondCall)).toMatchObject({
      eventId,
      attendeeEmail: "sam@helix.test",
      responseStatus: "accepted",
    });
  });

  it("renders Calendar AI suggestion slots with event and find-time context", async () => {
    renderCalendar();
    await waitForText("Backend planning");
    await waitForText("No time suggestions");
    await waitForText("No agenda draft");

    expect(
      container.querySelector('[data-testid="suggestion-slot-calendar.suggest-meeting-time"]'),
    ).toBeInstanceOf(HTMLElement);
    expect(
      container.querySelector('[data-testid="suggestion-slot-calendar.draft-agenda"]'),
    ).toBeInstanceOf(HTMLElement);
    expect(lastSuggestionContext("calendar.suggest-meeting-time")).toMatchObject({
      routePath: "/calendar",
      resource: {
        id: eventId,
        type: "calendar.event",
        label: "Backend planning",
      },
      classification: "standard",
      metadata: {
        title: "Backend planning",
        purpose: "From backend calendar tool",
        durationMinutes: 60,
        timezone: "UTC",
        attendees: [
          {
            name: "Sam Patel",
            email: "sam@helix.test",
            response: "pending",
          },
        ],
        slots: [
          {
            startsAt: "2026-05-21T14:00:00.000Z",
            endsAt: "2026-05-21T14:30:00.000Z",
            score: "Best fit",
          },
        ],
      },
    });
    expect(lastSuggestionContext("calendar.draft-agenda")).toMatchObject({
      routePath: "/calendar",
      resource: {
        id: eventId,
        type: "calendar.event",
        label: "Backend planning",
      },
      metadata: {
        title: "Backend planning",
        purpose: "From backend calendar tool",
        notes: "From backend calendar tool",
        startsAt: "2026-05-20T09:00:00.000Z",
        endsAt: "2026-05-20T10:00:00.000Z",
        location: "Room Backend",
      },
    });
  });

  it("hydrates the initial event id from route search state", async () => {
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/calendar.find-time") {
        return Promise.resolve(
          Response.json({
            slots: [
              {
                startsAt: "2026-05-21T14:00:00.000Z",
                endsAt: "2026-05-21T14:30:00.000Z",
                busy: [],
              },
            ],
          }),
        );
      }
      if (input === "/api/tools/calendar.event.list") {
        return Promise.resolve(
          Response.json({
            events: [
              backendEvent("Backend planning"),
              backendEvent("Deep linked calendar event", {
                id: deepLinkedEventId,
                startsAt: "2026-05-21T15:00:00.000Z",
                endsAt: "2026-05-21T15:30:00.000Z",
              }),
            ],
          }),
        );
      }
      return Promise.resolve(Response.json({ ok: true }));
    });

    renderCalendar({ initialEventId: deepLinkedEventId });

    await waitForText("Deep linked calendar event");
    await waitForText("3:00 PM");
  });

  it("uses route state for event input, filtering, and selected event deep links", async () => {
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/calendar.find-time") {
        return Promise.resolve(Response.json({ slots: [] }));
      }
      if (input === "/api/tools/calendar.event.list") {
        return Promise.resolve(
          Response.json({
            events: [
              backendEvent("Backend planning"),
              backendEvent("Deep linked calendar event", {
                id: deepLinkedEventId,
                startsAt: "2026-05-21T15:00:00.000Z",
                endsAt: "2026-05-21T15:30:00.000Z",
              }),
            ],
          }),
        );
      }
      return Promise.resolve(Response.json({ ok: true }));
    });

    renderCalendar({
      routeState: {
        eventId: deepLinkedEventId,
        date: "2026-05-21",
        view: "day",
        query: "deep",
      },
    });

    await waitForText("Deep linked calendar event");
    expect(container.textContent).not.toContain("Backend planning");
    expect(
      jsonBody(fetchMock.mock.calls.find((call) => call[0] === "/api/tools/calendar.event.list")),
    ).toMatchObject({
      startsAt: "2026-05-21T00:00:00.000Z",
      endsAt: "2026-05-21T23:59:59.999Z",
      limit: 100,
    });
  });

  it("emits route-state changes when calendar controls change", async () => {
    const onRouteStateChange = vi.fn();
    renderCalendar({
      onRouteStateChange,
      routeState: {
        eventId,
        date: "2026-05-20",
        view: "week",
        query: "",
      },
    });
    await waitForText("Backend planning");
    onRouteStateChange.mockClear();

    const searchInput = container.querySelector<HTMLInputElement>('input[type="search"]');
    if (searchInput === null) {
      throw new Error("Calendar search input not found.");
    }
    act(() => {
      setInputValue(searchInput, "backend");
      searchInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });

    expect(onRouteStateChange).toHaveBeenLastCalledWith({
      eventId,
      date: "2026-05-20",
      view: "week",
      query: "backend",
    });

    await clickButton("Month");
    expect(onRouteStateChange).toHaveBeenLastCalledWith({
      eventId,
      date: "2026-05-20",
      view: "month",
      query: "",
    });
  });

  it("renders a date-driven week grid and navigates with prev / next / Today", async () => {
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/calendar.find-time") {
        return Promise.resolve(Response.json({ slots: [] }));
      }
      return Promise.resolve(Response.json({ ok: true }));
    });

    const onRouteStateChange = vi.fn();
    renderCalendar({
      onRouteStateChange,
      routeState: { eventId: "", date: "2026-05-20", view: "week", query: "" },
    });

    // Default week window (Mon 18 - Sun 24) is computed from the active date.
    await waitForText("May 18-24, 2026");
    expectDayHeadings(["18", "19", "20", "21", "22", "23", "24"]);

    await clickIconButton("Next period");
    expectRouteDate(onRouteStateChange, "2026-05-27");
    renderCalendar({
      onRouteStateChange,
      routeState: { eventId: "", date: "2026-05-27", view: "week", query: "" },
    });
    // The grid re-renders against the new active date.
    await waitForText("May 25-31, 2026");
    expectDayHeadings(["25", "26", "27", "28", "29", "30", "31"]);

    onRouteStateChange.mockClear();
    await clickIconButton("Previous period");
    expectRouteDate(onRouteStateChange, "2026-05-20");

    renderCalendar({
      onRouteStateChange,
      routeState: { eventId: "", date: "2026-06-10", view: "week", query: "" },
    });
    await waitForText("June 8-14, 2026");
    onRouteStateChange.mockClear();
    await clickButton("Today");
    expectRouteDate(onRouteStateChange, "2026-05-20");
  });

  it("renders a date-driven month grid and steps months with prev / next", async () => {
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/calendar.find-time") {
        return Promise.resolve(Response.json({ slots: [] }));
      }
      return Promise.resolve(Response.json({ ok: true }));
    });

    const onRouteStateChange = vi.fn();
    renderCalendar({
      onRouteStateChange,
      routeState: { eventId: "", date: "2026-05-20", view: "month", query: "" },
    });
    await waitForText("May 2026");

    await clickIconButton("Next period");
    expectRouteDate(onRouteStateChange, "2026-06-20");

    renderCalendar({
      onRouteStateChange,
      routeState: { eventId: "", date: "2026-06-20", view: "month", query: "" },
    });
    await waitForText("June 2026");

    onRouteStateChange.mockClear();
    await clickIconButton("Previous period");
    expectRouteDate(onRouteStateChange, "2026-05-20");
  });

  it("places backend events against the computed week dates", async () => {
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/calendar.find-time") {
        return Promise.resolve(Response.json({ slots: [] }));
      }
      if (input === "/api/tools/calendar.event.list") {
        return Promise.resolve(
          Response.json({
            events: [
              backendEvent("Future week meeting", {
                startsAt: "2026-05-28T09:00:00.000Z",
                endsAt: "2026-05-28T10:00:00.000Z",
              }),
            ],
          }),
        );
      }
      return Promise.resolve(Response.json({ ok: true }));
    });

    renderCalendar({
      routeState: { eventId: "", date: "2026-05-28", view: "week", query: "" },
    });

    await waitForText("Future week meeting");
    const dayColumns = Array.from(container.querySelectorAll(".calendar-day-column"));
    const eventColumn = dayColumns.find((column) =>
      column.textContent?.includes("Future week meeting"),
    );
    expect(eventColumn).toBeInstanceOf(HTMLElement);
    // Thursday May 28 is the 4th column of the Mon-anchored week.
    expect(dayColumns.indexOf(eventColumn as Element)).toBe(3);
  });

  it("deletes selected backend events through calendar.event.delete", async () => {
    renderCalendar();
    await waitForText("Backend planning");

    await clickButton("Delete event");
    await waitForText("Drive layout review");

    const deleteCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/calendar.event.delete",
    );
    expect(jsonBody(deleteCall)).toMatchObject({
      eventId,
      sendCancellation: false,
    });
  });

  it("shows sample events when the backend calendar list fails", async () => {
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/calendar.event.list") {
        return Promise.reject(new Error("offline"));
      }
      if (input === "/api/tools/calendar.find-time") {
        return Promise.resolve(
          Response.json({
            slots: [
              {
                startsAt: "2026-05-21T14:00:00.000Z",
                endsAt: "2026-05-21T14:30:00.000Z",
                busy: [],
              },
            ],
          }),
        );
      }
      return Promise.resolve(Response.json({ ok: true }));
    });

    renderCalendar();
    await waitForText("Calendar backend offline");

    await waitForText("Drive layout review");
    await waitForText("Vendor renewal check-in");
  });

  it("labels locally-created events as Offline/local when backend create fails", async () => {
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/calendar.find-time") {
        return Promise.resolve(
          Response.json({
            slots: [
              {
                startsAt: "2026-05-21T14:00:00.000Z",
                endsAt: "2026-05-21T14:30:00.000Z",
                busy: [],
              },
            ],
          }),
        );
      }
      return Promise.reject(new Error("offline"));
    });

    renderCalendar();
    await waitForText("Calendar backend offline");
    await clickButton("Create");
    await waitForText("New event");
    await waitForText("Offline/local");

    expect(container.textContent).toContain("Offline/local draft. Calendar backend create failed");
    expect(container.textContent).not.toContain("Product sync");
  });

  function renderCalendar(props: Parameters<typeof CalendarShell>[0] = {}) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CalendarShell {...props} />
        </QueryClientProvider>,
      );
    });
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    const setter = Reflect.get(descriptor ?? {}, "set") as
      | ((this: HTMLInputElement, value: string) => void)
      | undefined;
    if (setter === undefined) {
      throw new Error("HTML input value setter not found.");
    }
    Reflect.apply(setter, input, [value]);
  }

  async function clickButton(text: string) {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(text),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${text}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function clickIconButton(label: string) {
    const button = container.querySelector(`button[aria-label="${label}"]`);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Icon button not found: ${label}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function expectRouteDate(onRouteStateChange: ReturnType<typeof vi.fn>, date: string) {
    const dates = onRouteStateChange.mock.calls.map(
      (call) => (call[0] as { readonly date: string }).date,
    );
    expect(dates).toContain(date);
  }

  function expectDayHeadings(dayNumbers: readonly string[]) {
    const headings = Array.from(container.querySelectorAll(".calendar-day-heading")).map(
      (heading) => heading.querySelector("strong")?.textContent,
    );
    expect(headings).toEqual([...dayNumbers]);
  }

  async function clickRsvpButton(text: string) {
    const button = Array.from(
      container.querySelectorAll(".calendar-event-details .calendar-rsvp-actions button"),
    ).find((candidate) => candidate.textContent === text);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`RSVP button not found: ${text}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function waitForText(text: string) {
    await waitFor(() => expect(container.textContent).toContain(text));
  }

  async function waitFor(assertion: () => void | Promise<void>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await act(async () => {
          await Promise.resolve();
        });
        await assertion();
        return;
      } catch (error) {
        lastError = error;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
    }
    throw lastError;
  }
});

function lastSuggestionContext(slotId: string): unknown {
  const call = suggestionSlotHarness.calls.findLast((candidate) => candidate.slotId === slotId);
  if (call === undefined) {
    throw new Error(`Suggestion slot not rendered: ${slotId}`);
  }
  return call.context;
}

function backendEvent(
  title: string,
  overrides: {
    readonly id?: string;
    readonly startsAt?: string;
    readonly endsAt?: string;
  } = {},
) {
  return {
    id: overrides.id ?? eventId,
    calendarId: "44444444-4444-4444-8444-444444444444",
    title,
    description: "From backend calendar tool",
    location: "Room Backend",
    startsAt: overrides.startsAt ?? "2026-05-20T09:00:00.000Z",
    endsAt: overrides.endsAt ?? "2026-05-20T10:00:00.000Z",
    allDay: false,
    status: "confirmed",
    metadata: {},
    attendees: [
      {
        id: "attendee-sam",
        email: "sam@helix.test",
        displayName: "Sam Patel",
        responseStatus: "needs_action",
      },
    ],
  };
}

function jsonBody(call: readonly [RequestInfo | URL, RequestInit?] | undefined): unknown {
  const body = call?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected JSON request body.");
  }
  return JSON.parse(body) as unknown;
}
