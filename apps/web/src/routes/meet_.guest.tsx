import { createFileRoute, useLocation } from "@tanstack/react-router";
import { MeetGuestPage } from "@/features/meet/meet-guest";
import { guestTokenFromHash } from "@/features/meet/meet-guest-api";

/* Public: outside `_shell`, so no sign-in is required. The invitation token
   is in the URL fragment, which browsers never send to the server. */
export const Route = createFileRoute("/meet_/guest")({
  component: MeetGuestRoute,
});

function MeetGuestRoute() {
  const hash = useLocation({ select: (location) => location.hash });
  return <MeetGuestPage key={hash} token={guestTokenFromHash(hash)} />;
}
