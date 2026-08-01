import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, Dna, Loader2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LocalLoginPanel } from "@/routes/login";
import { getSessionUser, signInWithEmail, type AuthFetch, type SessionUser } from "@/lib/auth";
import { acceptSignupOnboardingInvite, type SignupOnboardingInviteAcceptResponse } from "./api";

interface SignupInviteShellProps {
  readonly token: string;
  readonly fetchImpl?: AuthFetch;
  readonly getSession?: (fetchImpl?: AuthFetch) => Promise<SessionUser | null>;
  readonly signIn?: typeof signInWithEmail;
}

type InviteState =
  | { readonly status: "checking" }
  | { readonly status: "sign_in" }
  | { readonly status: "accepting" }
  | { readonly status: "accepted"; readonly result: SignupOnboardingInviteAcceptResponse }
  | { readonly status: "error"; readonly message: string };

export function SignupInviteShell({
  token,
  fetchImpl = fetch,
  getSession = getSessionUser,
  signIn = signInWithEmail,
}: SignupInviteShellProps) {
  const [state, setState] = useState<InviteState>({ status: "checking" });
  const acceptedTokenRef = useRef<string | null>(null);
  const activeInviteRequestRef = useRef<AbortController | null>(null);

  const acceptInvite = useCallback(
    (nextToken: string) => {
      if (nextToken.trim().length === 0) {
        setState({ status: "error", message: "This invitation link is missing its token." });
        return;
      }
      if (acceptedTokenRef.current === nextToken) {
        return;
      }
      acceptedTokenRef.current = nextToken;
      activeInviteRequestRef.current?.abort();
      const controller = new AbortController();
      activeInviteRequestRef.current = controller;
      setState({ status: "accepting" });
      void acceptSignupOnboardingInvite(nextToken, fetchImpl, { signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return;
          setState({ status: "accepted", result });
        })
        .catch((caught) => {
          if (controller.signal.aborted) return;
          acceptedTokenRef.current = null;
          setState({
            status: "error",
            message: caught instanceof Error ? caught.message : "Invitation could not be accepted.",
          });
        });
    },
    [fetchImpl],
  );

  useEffect(() => {
    let active = true;
    void getSession(fetchImpl)
      .then((user) => {
        if (!active) return;
        if (user === null) {
          setState({ status: "sign_in" });
          return;
        }
        acceptInvite(token);
      })
      .catch(() => {
        if (active) setState({ status: "sign_in" });
      });
    return () => {
      active = false;
      activeInviteRequestRef.current?.abort();
    };
  }, [acceptInvite, fetchImpl, getSession, token]);

  if (state.status === "sign_in") {
    return (
      <LocalLoginPanel
        signIn={(input) => signIn(input, fetchImpl)}
        onSignedIn={() => acceptInvite(token)}
      />
    );
  }

  return (
    <main className="auth-screen">
      <section className="panel auth-panel signup-panel">
        <div className="auth-brand">
          <div
            className={state.status === "error" ? "auth-logo danger" : "auth-logo"}
            aria-hidden="true"
          >
            {state.status === "error" ? (
              <TriangleAlert />
            ) : state.status === "accepted" ? (
              <CheckCircle2 />
            ) : (
              <Dna />
            )}
          </div>
          <h1 className="auth-title">{titleForState(state)}</h1>
          <p className="auth-subtitle">{subtitleForState(state)}</p>
        </div>

        {state.status === "checking" || state.status === "accepting" ? (
          <div className="auth-success" role="status" aria-live="polite" aria-atomic="true">
            <Loader2 className="auth-spinner" aria-hidden="true" />
            <span>{state.status === "checking" ? "Checking session…" : "Joining workspace…"}</span>
          </div>
        ) : null}

        {state.status === "error" ? (
          <>
            <p className="auth-error" role="alert">
              {state.message}
            </p>
            {token.trim().length > 0 ? (
              <button
                className="btn primary lg auth-submit"
                type="button"
                onClick={() => acceptInvite(token)}
              >
                Try joining again
                <ArrowRight aria-hidden="true" />
              </button>
            ) : null}
          </>
        ) : null}

        {state.status === "accepted" ? (
          <div className="auth-success" role="status" aria-live="polite" aria-atomic="true">
            <CheckCircle2 aria-hidden="true" />
            <span>
              Workspace <strong>{state.result.org.slug}</strong> is ready.
            </span>
          </div>
        ) : null}

        <Link className="btn primary lg auth-submit" to={continuePathForState(state)}>
          {continueLabelForState(state)}
          <ArrowRight aria-hidden="true" />
        </Link>
      </section>
    </main>
  );
}

function titleForState(state: InviteState): string {
  if (state.status === "accepted") {
    return "Invitation accepted";
  }
  if (state.status === "error") {
    return "Invitation failed";
  }
  return "Joining workspace";
}

function subtitleForState(state: InviteState): string {
  if (state.status === "accepted") {
    return `${state.result.org.displayName} is ready. Local email/password login remains available.`;
  }
  if (state.status === "error") {
    return "Use the latest invitation link from your inbox.";
  }
  return "This usually finishes in a few seconds.";
}

function continuePathForState(state: InviteState): string {
  return state.status === "accepted" ? state.result.workspace.welcomeUrl : "/login";
}

function continueLabelForState(state: InviteState): string {
  return state.status === "accepted" ? "Continue" : "Sign in with email/password";
}
