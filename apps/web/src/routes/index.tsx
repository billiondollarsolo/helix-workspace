import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ArrowRight, Dna, LogIn } from "lucide-react";
import { getSessionUser, type SessionUser } from "@/lib/auth";

export const Route = createFileRoute("/")({
  beforeLoad: () => redirectSignedInRoot(),
  component: LandingPage,
});

export async function redirectSignedInRoot(
  getUser: () => Promise<SessionUser | null> = getSessionUser,
): Promise<void> {
  const user = await getUser();
  if (user !== null) {
    // TanStack Router signals navigation by throwing a redirect.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: "/mail", search: {} });
  }
}

export function LandingPage() {
  return (
    <main className="auth-screen landing-screen">
      <section className="landing-panel">
        <div className="auth-brand landing-brand">
          <div className="auth-logo" aria-hidden="true">
            <Dna />
          </div>
          <h1 className="auth-title landing-title">Helix</h1>
          <p className="auth-subtitle landing-subtitle">
            One workspace for mail, docs, drive, meetings, and governed AI.
          </p>
        </div>

        <div className="landing-actions">
          <Link className="btn primary lg" to="/signup">
            Get started free
            <ArrowRight aria-hidden="true" />
          </Link>
          <Link className="btn lg" to="/login">
            <LogIn aria-hidden="true" />
            Sign in
          </Link>
        </div>
      </section>
    </main>
  );
}
