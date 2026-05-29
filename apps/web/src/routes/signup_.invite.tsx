import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SignupInviteShell } from "@/features/signup/invite-shell";

const inviteSearchSchema = z.object({
  token: z.string().optional().default(""),
});

export const Route = createFileRoute("/signup_/invite")({
  validateSearch: (search) => inviteSearchSchema.parse(search),
  component: SignupInviteRoute,
});

function SignupInviteRoute() {
  const search = Route.useSearch();
  return <SignupInviteShell token={search.token} />;
}
