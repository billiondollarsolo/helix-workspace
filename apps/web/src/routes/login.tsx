import { createFileRoute, redirect } from "@tanstack/react-router";
import { Dna, Loader2, LogIn } from "lucide-react";
import { useState } from "react";
import { getSessionUser, signInWithEmail, type SessionUser, type SignInInput } from "@/lib/auth";

export const Route = createFileRoute("/login")({
  // If a session is already active, skip the login page.
  beforeLoad: async () => {
    const user = await getSessionUser();
    if (user !== null) {
      // TanStack Router signals navigation by throwing a redirect.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: "/mail", search: {} });
    }
  },
  component: LoginRoute,
});

const DEMO_ACCOUNTS = [
  {
    label: "Local Admin",
    email: "local-admin@helix.local",
    password: "helix-local-dev-password",
  },
] as const;

function LoginRoute() {
  const navigate = Route.useNavigate();
  return (
    <LocalLoginPanel
      onSignedIn={() => navigate({ to: "/mail", search: {} })}
      signIn={signInWithEmail}
    />
  );
}

export interface LocalLoginPanelProps {
  readonly signIn?: (input: SignInInput) => Promise<SessionUser>;
  readonly onSignedIn?: (user: SessionUser) => Promise<void> | void;
}

export function LocalLoginPanel({
  signIn = signInWithEmail,
  onSignedIn,
}: LocalLoginPanelProps = {}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(nextEmail: string, nextPassword: string): Promise<void> {
    setStatus("submitting");
    setError(null);
    try {
      const user = await signIn({ email: nextEmail.trim(), password: nextPassword });
      await onSignedIn?.(user);
    } catch (caught) {
      setStatus("idle");
      setError(caught instanceof Error ? caught.message : "Sign in failed.");
    }
  }

  return (
    <main className="auth-screen">
      <section className="panel auth-panel">
        <div className="auth-brand">
          <div className="auth-logo" aria-hidden="true">
            <Dna />
          </div>
          <h1 className="auth-title">Sign in to Helix</h1>
          <p className="auth-subtitle">
            Local email/password is always available. Workspace SSO can be added separately.
          </p>
        </div>

        <div className="auth-method-header">
          <span>Local email/password login</span>
          <span>Email + password</span>
        </div>

        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(email, password);
          }}
        >
          <label className="auth-field">
            <span className="auth-label">Email</span>
            <input
              className="input"
              type="email"
              autoComplete="username"
              placeholder="you@helix.local"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              required
            />
          </label>
          <label className="auth-field">
            <span className="auth-label">Password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              required
            />
          </label>

          {error === null ? null : (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}

          <button
            className="btn primary lg auth-submit"
            type="submit"
            disabled={status === "submitting"}
          >
            {status === "submitting" ? (
              <Loader2 className="auth-spinner" aria-hidden="true" />
            ) : (
              <LogIn aria-hidden="true" />
            )}
            {status === "submitting" ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="auth-demo">
          <span className="auth-demo-label">Local demo accounts</span>
          <div className="auth-demo-row">
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                className="btn sm"
                disabled={status === "submitting"}
                onClick={() => {
                  setEmail(account.email);
                  setPassword(account.password);
                  void submit(account.email, account.password);
                }}
              >
                {account.label}
              </button>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
