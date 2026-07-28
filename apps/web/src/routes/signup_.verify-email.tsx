import { createFileRoute } from "@tanstack/react-router";
import { VerifyEmailShell } from "@/features/signup/verify-email-shell";
import { stringSearchParam } from "@/lib/search-params";

export const Route = createFileRoute("/signup_/verify-email")({
  validateSearch: (search) => ({ token: stringSearchParam(search.token) }),
  component: VerifyEmailRoute,
});

function VerifyEmailRoute() {
  const search = Route.useSearch();
  return <VerifyEmailShell token={search.token} />;
}
