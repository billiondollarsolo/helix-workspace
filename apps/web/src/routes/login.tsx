import { createFileRoute, redirect } from "@tanstack/react-router";
import { LocalLoginPanel } from "@/features/auth/login-panel";
import { getSessionUser, safeLoginReturnTo, resumeFederationSignIn } from "@/lib/auth";

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
    const user = await getSessionUser();
    if (search.reauthenticate !== true && user !== null && !user.passwordChangeRequired) {
      await resumeFederationSignIn();
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ href: safeLoginReturnTo(search.returnTo) });
    }
    return { initialPasswordRequired: user?.passwordChangeRequired === true };
  },
  component: LoginRoute,
});

function LoginRoute() {
  const search = Route.useSearch();
  const context = Route.useRouteContext();
  return (
    <LocalLoginPanel
      initialPasswordRequired={context.initialPasswordRequired}
      reauthenticate={search.reauthenticate === true}
      {...(search.token === undefined ? {} : { resetToken: search.token })}
      onSignedIn={async () => {
        await resumeFederationSignIn();
        window.location.replace(safeLoginReturnTo(search.returnTo));
      }}
    />
  );
}
