import { useDebouncedCallback } from "@tanstack/react-pacer/debouncer";
import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, Dna, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  resendSignupVerification,
  SignupApiError,
  verifySignupEmail,
  type SignupVerifyEmailResponse,
} from "./api";

interface VerifyEmailShellProps {
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

type VerifyState =
  | { readonly status: "verifying"; readonly message: string }
  | { readonly status: "verified"; readonly result: SignupVerifyEmailResponse }
  | {
      readonly status: "error";
      readonly message: string;
      readonly canResend: boolean;
      readonly resendStatus?: "idle" | "sending" | "sent";
    };

export function VerifyEmailShell({ token, fetchImpl = fetch }: VerifyEmailShellProps) {
  const [state, setState] = useState<VerifyState>({
    status: "verifying",
    message: "Verifying your email...",
  });
  const submittedTokenRef = useRef<string | null>(null);
  const retryVerification = useDebouncedCallback(
    (attempt: number, verify: (attempt: number) => void) => verify(attempt),
    { wait: 2_000 },
  );

  useEffect(() => {
    if (submittedTokenRef.current === token) {
      return;
    }
    submittedTokenRef.current = token;

    if (token.trim().length === 0) {
      setState({
        status: "error",
        message: "This verification link is missing its token.",
        canResend: false,
      });
      return;
    }

    const verify = (attempt: number) => {
      void verifySignupEmail(token, fetchImpl)
        .then((result) => {
          setState({ status: "verified", result });
        })
        .catch((caught) => {
          if (isTenantNotReady(caught) && attempt < 6) {
            setState({
              status: "verifying",
              message: "Finishing workspace setup...",
            });
            retryVerification(attempt + 1, verify);
            return;
          }
          setState({
            status: "error",
            message:
              caught instanceof Error
                ? caught.message
                : "Email verification could not be completed.",
            canResend: canResendVerification(caught),
            resendStatus: "idle",
          });
        });
    };

    verify(1);
  }, [fetchImpl, retryVerification, token]);

  function resend(): void {
    if (token.trim().length === 0 || state.status !== "error" || !state.canResend) {
      return;
    }
    setState({ ...state, resendStatus: "sending" });
    void resendSignupVerification(token, fetchImpl)
      .then(() => {
        setState({
          status: "error",
          message: "If this link can be refreshed, we will send a new verification email.",
          canResend: false,
          resendStatus: "sent",
        });
      })
      .catch((caught) => {
        setState({
          status: "error",
          message:
            caught instanceof Error ? caught.message : "Verification email could not be resent.",
          canResend: true,
          resendStatus: "idle",
        });
      });
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
            ) : state.status === "verified" ? (
              <CheckCircle2 />
            ) : (
              <Dna />
            )}
          </div>
          <h1 className="auth-title">{titleForState(state)}</h1>
          <p className="auth-subtitle">{subtitleForState(state)}</p>
        </div>

        {state.status === "verifying" ? (
          <div className="auth-success" role="status">
            <Loader2 className="auth-spinner" aria-hidden="true" />
            <span>{state.message}</span>
          </div>
        ) : null}

        {state.status === "error" ? (
          <p className="auth-error" role="alert">
            {state.message}
          </p>
        ) : null}

        {state.status === "error" && state.canResend ? (
          <button
            className="btn secondary lg auth-submit"
            type="button"
            onClick={resend}
            disabled={state.resendStatus === "sending"}
          >
            {state.resendStatus === "sending" ? "Sending..." : "Send a new link"}
            <ArrowRight aria-hidden="true" />
          </button>
        ) : null}

        {state.status === "verified" ? (
          <div className="auth-success" role="status">
            <CheckCircle2 aria-hidden="true" />
            <span>
              Workspace <strong>{state.result.org.slug}</strong> is active.
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

function titleForState(state: VerifyState): string {
  if (state.status === "verified") {
    return "Email verified";
  }
  if (state.status === "error") {
    return "Verification failed";
  }
  return "Verifying email";
}

function subtitleForState(state: VerifyState): string {
  if (state.status === "verified") {
    return state.result.session.created
      ? `${state.result.org.displayName} is ready.`
      : `${state.result.org.displayName} is ready for local email/password sign in.`;
  }
  if (state.status === "error") {
    return "Use the latest verification link from your inbox.";
  }
  return "This usually finishes in a few seconds.";
}

function isTenantNotReady(error: unknown): boolean {
  return error instanceof SignupApiError && error.code === "tenant_not_ready";
}

function canResendVerification(error: unknown): boolean {
  return error instanceof SignupApiError && error.code === "signup_verification_invalid";
}

function continuePathForState(state: VerifyState): string {
  return state.status === "verified" && state.result.session.created
    ? state.result.workspace.onboardingUrl
    : "/login";
}

function continueLabelForState(state: VerifyState): string {
  return state.status === "verified" && state.result.session.created
    ? "Continue"
    : "Sign in with email/password";
}
