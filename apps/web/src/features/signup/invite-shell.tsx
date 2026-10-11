import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthCard } from "@/features/auth/auth-card";
import { LocalLoginPanel } from "@/features/auth/login-panel";
import {
  discoverSignInMethod,
  getSessionUser,
  signInWithEmail,
  type AuthFetch,
  type SessionUser,
} from "@/lib/auth";
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
        discover={(email) => discoverSignInMethod(email, fetchImpl)}
        onSignedIn={() => acceptInvite(token)}
      />
    );
  }

  return (
    <AuthCard
      wide
      title={titleForState(state)}
      subtitle={subtitleForState(state)}
      {...(state.status === "error"
        ? { status: { tone: "danger" as const, icon: <TriangleAlert /> } }
        : state.status === "accepted"
          ? { status: { tone: "success" as const, icon: <CheckCircle2 /> } }
          : {})}
    >
      {state.status === "checking" || state.status === "accepting" ? (
        <div className="auth-success" role="status" aria-live="polite" aria-atomic="true">
          <Loader2 className="auth-spinner" aria-hidden="true" />
          <span>
            {state.status === "checking" ? "Checking your session…" : "Joining the workspace…"}
          </span>
        </div>
      ) : null}

      {state.status === "error" ? (
        <p className="auth-error" role="alert">
          {state.message}
        </p>
      ) : null}

      {state.status === "accepted" ? (
        <div className="auth-success" role="status" aria-live="polite" aria-atomic="true">
          <CheckCircle2 aria-hidden="true" />
          <span>
            You’re now a member of <strong>{state.result.org.displayName}</strong>.
          </span>
        </div>
      ) : null}

      <div className="auth-actions">
        {state.status === "error" && token.trim().length > 0 ? (
          <button className="btn ghost" type="button" onClick={() => acceptInvite(token)}>
            Try again
          </button>
        ) : null}
        <Link className="btn primary auth-submit" to={continuePathForState(state)}>
          {continueLabelForState(state)}
          <ArrowRight aria-hidden="true" size={16} />
        </Link>
      </div>
    </AuthCard>
  );
}

function titleForState(state: InviteState): string {
  if (state.status === "accepted") {
    return "You’re in";
  }
  if (state.status === "error") {
    return "We couldn’t accept this invitation";
  }
  return "Joining your team";
}

function subtitleForState(state: InviteState): string {
  if (state.status === "accepted") {
    return `Welcome to ${state.result.org.displayName}.`;
  }
  if (state.status === "error") {
    return "Open the most recent invitation email and use its link.";
  }
  return "This usually finishes in a few seconds.";
}

function continuePathForState(state: InviteState): string {
  return state.status === "accepted" ? state.result.workspace.workspaceUrl : "/login";
}

function continueLabelForState(state: InviteState): string {
  return state.status === "accepted" ? "Go to Helix" : "Sign in";
}
