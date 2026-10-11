import { SurfaceFrame } from "@/components/shell";
import { CalendarShell, type CalendarCreateIntent } from "@/features/calendar/calendar-shell";
import {
  calendarCreateHandoffFromSearch,
  type CalendarCreateHandoff,
} from "@/features/people/handoff";
import {
  calendarRouteSearchFromState,
  calendarRouteStateFromSearch,
  validateCalendarRouteSearch,
  type CalendarRouteSearch,
} from "@/features/calendar/route-state";
import { QueryClientProvider } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Calendar as CalendarIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

export const Route = createFileRoute("/_shell/calendar/")({
  validateSearch: (search): CalendarRouteSearch & CalendarCreateHandoff => ({
    ...validateCalendarRouteSearch(search),
    ...calendarCreateHandoffFromSearch(search),
  }),
  component: CalendarRoute,
});

function CalendarRoute() {
  const search = Route.useSearch();
  const { queryClient } = Route.useRouteContext();
  const navigate = useNavigate({ from: Route.fullPath });
  const routeState = calendarRouteStateFromSearch(search);
  const createIntent = useMemo<CalendarCreateIntent | null>(
    () =>
      search.create === "event"
        ? { attendees: search.attendees === undefined ? [] : search.attendees.split(",") }
        : null,
    [search.create, search.attendees],
  );
  const clearCreateIntent = useCallback(() => {
    void navigate({
      search: (previous) => ({ ...previous, create: undefined, attendees: undefined }),
      replace: true,
    });
  }, [navigate]);

  return (
    <SurfaceFrame
      title="Calendar"
      icon={<CalendarIcon size={16} />}
      searchPlaceholder="Search events"
      searchValue={routeState.query}
      onSearchChange={(query) => {
        void navigate({
          search: () => calendarRouteSearchFromState({ ...routeState, query }),
          replace: true,
        });
      }}
    >
      {/* The router always carries a QueryClient in context; re-providing it
          here keeps the surface self-contained and rendering in isolation. */}
      <QueryClientProvider client={queryClient}>
        <CalendarShell
          routeState={routeState}
          onRouteStateChange={(nextState) => {
            void navigate({ search: () => calendarRouteSearchFromState(nextState) });
          }}
          createIntent={createIntent}
          onCreateIntentHandled={clearCreateIntent}
          onEmailGuests={(emails) => {
            void navigate({ to: "/mail", search: { compose: "new", to: emails.join(",") } });
          }}
          onOpenLink={(url, event) => {
            if (!url.startsWith("/")) return;
            event.preventDefault();
            void navigate({ href: url });
          }}
        />
      </QueryClientProvider>
    </SurfaceFrame>
  );
}
