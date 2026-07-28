import { createFileRoute } from "@tanstack/react-router";
import { SignupInviteShell } from "@/features/signup/invite-shell";
import { stringSearchParam } from "@/lib/search-params";

export const Route = createFileRoute("/signup_/invite")({
  validateSearch: (search) => ({ token: stringSearchParam(search.token) }),
  component: SignupInviteRoute,
});

function SignupInviteRoute() {
  const search = Route.useSearch();
  return <SignupInviteShell token={search.token} />;
}
