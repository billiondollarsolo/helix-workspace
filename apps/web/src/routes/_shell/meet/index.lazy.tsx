import { createLazyFileRoute } from "@tanstack/react-router";
import { CoreAppGate } from "@/components/core-app-gate";
import { MeetShell } from "@/features/meet/meet-shell";
import { meetRoomsQueryInputFromRouteSearch } from "./index";

export const Route = createLazyFileRoute("/_shell/meet/")({
  component: MeetRoute,
});

function MeetRoute() {
  const search = Route.useSearch();

  return (
    <CoreAppGate app="meet">
      <MeetShell
        initialRoomId={search.room}
        roomsQueryInput={meetRoomsQueryInputFromRouteSearch(search)}
      />
    </CoreAppGate>
  );
}
