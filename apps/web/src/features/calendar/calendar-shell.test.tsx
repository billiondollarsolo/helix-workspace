// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarShell } from "./calendar-shell";
import { defaultCalendarRouteState, type CalendarRouteState } from "./queries";
import type { CalendarApiEvent } from "./api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** A backend event placed on Wednesday (day index 2) at 12:00–13:00 UTC. */
function backendEvent(
  title: string,
  id = "11111111-1111-4111-8111-111111111111",
): CalendarApiEvent {
  return {
    id,
    calendarId: "team",
    title,
    location: "Helix Meet",
    startsAt: "2026-05-20T12:00:00.000Z",
    endsAt: "2026-05-20T13:00:00.000Z",
    allDay: false,
    status: "confirmed",
    attendees: [
      {
        id: "att-1",
        email: "sam@helix.test",
        displayName: "Sam Patel",
        responseStatus: "accepted",
        isOrganizer: false,
      },
    ],
  };
}

describe("CalendarShell", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  const mockEvents = (events: readonly CalendarApiEvent[]) => {
    fetchMock = vi.fn<typeof fetch>((input) => {
      if (input === "/api/tools/calendar.event.list") {
        return Promise.resolve(Response.json({ events }));
      }
      return Promise.resolve(Response.json({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
  };

  /** Simulate the calendar backend being unreachable — drives the error banner. */
  const mockOffline = () => {
    fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new Error("network down")));
    vi.stubGlobal("fetch", fetchMock);
  };

  const render = (routeState?: CalendarRouteState, onChange?: (s: CalendarRouteState) => void) => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CalendarShell routeState={routeState} onRouteStateChange={onChange} />
        </QueryClientProvider>,
      );
    });
  };

  const flush = async () => {
    for (let tick = 0; tick < 10; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };

  it("renders an empty week when the backend returns no events", async () => {
    mockEvents([]);
    render({ ...defaultCalendarRouteState, date: "2026-05-20" });
    await flush();

    expect(container.textContent).not.toContain("Eng standup");
    expect(container.textContent).toContain("No events this week.");
    expect(container.textContent).toContain("May 18 – 24, 2026");
  });

  it("surfaces an unavailable banner when the backend is offline", async () => {
    mockOffline();
    render();
    await flush();

    expect(container.textContent).toContain("Calendar events unavailable");
    // No fabricated rows leak through.
    expect(container.textContent).not.toContain("Eng standup");
  });

  it("renders the sidebar mini-month and surfaces an unavailable banner offline", async () => {
    mockOffline();
    render();
    await flush();

    expect(container.textContent).toContain("Calendars unavailable");
    // No fake calendar checklist rows render when the API is unreachable.
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(0);
  });

  it("maps a backend event onto the week grid", async () => {
    mockEvents([backendEvent("Backend planning")]);
    render();
    await flush();

    expect(container.textContent).toContain("Backend planning");
  });

  it("filters events by the search query", async () => {
    const events = [
      backendEvent("Eng standup", "11111111-1111-4111-8111-111111111111"),
      backendEvent("Helix all-hands", "22222222-2222-4222-8222-222222222222"),
    ];
    mockEvents(events);
    render({ ...defaultCalendarRouteState, query: "standup" });
    await flush();

    expect(container.textContent).toContain("Eng standup");
    expect(container.textContent).not.toContain("Helix all-hands");
  });

  it("opens the event popover when an event card is clicked", async () => {
    const event = backendEvent("Eng standup");
    mockEvents([event]);
    let state: CalendarRouteState = defaultCalendarRouteState;
    render(state, (next) => {
      state = next;
    });
    await flush();

    const card = [...container.querySelectorAll("button[data-calendar-event]")].find((node) =>
      node.textContent?.includes("Eng standup"),
    );
    expect(card).toBeDefined();
    // Backend events select on mousedown+mouseup (no drag), not plain click.
    act(() => {
      (card as HTMLButtonElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, clientX: 0, clientY: 0 }),
      );
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 0, clientY: 0 }));
    });
    expect(state.eventId).toBe(event.id);

    // Re-render with the selected event so the popover mounts.
    render(state, (next) => {
      state = next;
    });
    await flush();
    const popover = document.querySelector("[data-calendar-popover]");
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain("attendees");
  });

  it("closes the popover when Escape is pressed", async () => {
    const event = backendEvent("Eng standup");
    mockEvents([event]);
    let state: CalendarRouteState = { ...defaultCalendarRouteState, eventId: event.id };
    render(state, (next) => {
      state = next;
    });
    await flush();

    expect(document.querySelector("[data-calendar-popover]")).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(state.eventId).toBe("");
  });

  it("changes the active view when a view toggle is clicked", async () => {
    mockEvents([]);
    let state: CalendarRouteState = defaultCalendarRouteState;
    render(state, (next) => {
      state = next;
    });
    await flush();

    const monthButton = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Month",
    );
    expect(monthButton).toBeDefined();
    act(() => {
      (monthButton as HTMLButtonElement).click();
    });
    expect(state.view).toBe("month");
  });
});
