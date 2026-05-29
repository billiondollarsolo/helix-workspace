import { createFileRoute, redirect } from "@tanstack/react-router";
import { SignupShell } from "@/features/signup/signup-shell";
import { getSessionUser } from "@/lib/auth";

export const Route = createFileRoute("/signup")({
  beforeLoad: async () => {
    const user = await getSessionUser();
    if (user !== null) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: "/mail", search: {} });
    }
  },
  component: SignupRoute,
});

function SignupRoute() {
  return <SignupShell />;
}

