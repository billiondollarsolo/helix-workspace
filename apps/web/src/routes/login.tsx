import { createFileRoute, redirect } from "@tanstack/react-router";
import { LocalLoginPanel } from "@/features/auth/login-panel";
import { getSessionUser, safeLoginReturnTo } from "@/lib/auth";

export const Route = createFileRoute("/login")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { returnTo?: string; reauthenticate?: boolean; token?: string } => ({
    ...(typeof search.returnTo === "string"
      ? { returnTo: safeLoginReturnTo(search.returnTo) }
      : {}),
    ...(search.reauthenticate === true || search.reauthenticate === "true"
      ? { reauthenticate: true }
      : {}),
    ...(typeof search.token === "string" && search.token.length > 0 ? { token: search.token } : {}),
  }),
  beforeLoad: async ({ search }) => {
    if (search.reauthenticate !== true && (await getSessionUser()) !== null) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ href: safeLoginReturnTo(search.returnTo) });
    }
  },
  component: LoginRoute,
});

function LoginRoute() {
  const search = Route.useSearch();
  return (
    <LocalLoginPanel
      reauthenticate={search.reauthenticate === true}
      {...(search.token === undefined ? {} : { resetToken: search.token })}
      onSignedIn={() => {
        window.location.replace(safeLoginReturnTo(search.returnTo));
      }}
    />
  );
}
