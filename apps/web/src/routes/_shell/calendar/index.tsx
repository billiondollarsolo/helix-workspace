import { createFileRoute } from "@tanstack/react-router";
import {
  calendarEventsInputFromRouteSearch,
  calendarEventsQueryOptions,
  calendarFindTimeQueryOptions,
  validateCalendarRouteSearch,
} from "@/features/calendar/queries";

export const Route = createFileRoute("/_shell/calendar/")({
  validateSearch: validateCalendarRouteSearch,
  loaderDeps: ({ search }) => ({
    date: search.date,
    event: search.event,
    q: search.q,
    view: search.view,
  }),
  loader: async ({ context, deps }) => {
    const eventsInput = calendarEventsInputFromRouteSearch(deps);

    await Promise.all([
      context.queryClient.ensureQueryData(calendarFindTimeQueryOptions()).catch(() => undefined),
      context.queryClient
        .ensureQueryData(calendarEventsQueryOptions(eventsInput))
        .catch(() => undefined),
    ]);
  },
});
