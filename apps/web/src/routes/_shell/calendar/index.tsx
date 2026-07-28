import { QueryClientProvider } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { CalendarShell } from "@/features/calendar/calendar-shell";
import {
  calendarRouteSearchFromState,
  calendarRouteStateFromSearch,
  validateCalendarRouteSearch,
  type CalendarRouteSearch,
} from "@/features/calendar/route-state";

export const Route = createFileRoute("/_shell/calendar/")({
  validateSearch: (search): CalendarRouteSearch => validateCalendarRouteSearch(search),
  component: CalendarRoute,
});

function CalendarRoute() {
  const search = Route.useSearch();
  const { queryClient } = Route.useRouteContext();
  const navigate = useNavigate({ from: Route.fullPath });
  const routeState = calendarRouteStateFromSearch(search);

  return (
    <SurfaceFrame title="Calendar" icon={<Icons.Calendar />} searchPlaceholder="Search events">
      {/* The router always carries a QueryClient in context; re-providing it
          here keeps the surface self-contained and rendering in isolation. */}
      <QueryClientProvider client={queryClient}>
        <CalendarShell
          routeState={routeState}
          onRouteStateChange={(nextState) => {
            void navigate({ search: () => calendarRouteSearchFromState(nextState) });
          }}
        />
      </QueryClientProvider>
    </SurfaceFrame>
  );
}
