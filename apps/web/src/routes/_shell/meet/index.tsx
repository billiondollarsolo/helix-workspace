import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { parseMeetCode } from "@/features/meet/meet-code";
import { MeetShell } from "@/features/meet/meet-shell";

export interface ShellMeetRouteSearch {
  /** Meeting code to open the pre-join screen for (Calendar's Join link). */
  readonly code?: string;
}

export const Route = createFileRoute("/_shell/meet/")({
  validateSearch: (search): ShellMeetRouteSearch => {
    const code = typeof search.code === "string" ? parseMeetCode(search.code) : null;
    return code === null ? {} : { code };
  },
  component: MeetRoute,
});

function MeetRoute() {
  const { code } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <MeetShell
      code={code}
      onCodeChange={(next) => {
        void navigate({ search: next === undefined ? {} : { code: next } });
      }}
      onScheduleInCalendar={() => {
        void navigate({ to: "/calendar", search: { create: "event", conference: "meet" } });
      }}
    />
  );
}
