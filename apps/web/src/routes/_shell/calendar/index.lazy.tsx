import { createLazyFileRoute, useNavigate } from "@tanstack/react-router";
import { CoreAppGate } from "@/components/core-app-gate";
import { CalendarShell } from "@/features/calendar/calendar-shell";
import {
  calendarRouteSearchFromState,
  calendarRouteStateFromSearch,
} from "@/features/calendar/queries";

export const Route = createLazyFileRoute("/_shell/calendar/")({
  component: CalendarRoute,
});

function CalendarRoute() {
  const navigate = useNavigate();
  const search = Route.useSearch();

  return (
    <CoreAppGate app="calendar">
      <CalendarShell
        onRouteStateChange={(state) => {
          void navigate({
            to: "/calendar",
            search: calendarRouteSearchFromState(state),
          });
        }}
        routeState={calendarRouteStateFromSearch(search)}
      />
    </CoreAppGate>
  );
}
