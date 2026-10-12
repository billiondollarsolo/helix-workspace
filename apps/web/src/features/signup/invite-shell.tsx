import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AuthCard } from "@/features/auth/auth-card";
import { AuthForm, AuthInput, LocalLoginPanel, SubmitButton } from "@/features/auth/login-panel";
import {
  discoverSignInMethod,
  getSessionUser,
  sessionOptionalFetch,
  signInWithEmail,
  type AuthFetch,
  type SessionUser,
} from "@/lib/auth";
import {
  acceptAdminInvite,
  acceptSignupOnboardingInvite,
  inspectAdminInvite,
  type AdminInvitePreview,
  type SignupOnboardingInviteAcceptResponse,
} from "./api";

interface SignupInviteShellProps {
  readonly token: string;
  readonly fetchImpl?: AuthFetch;
  readonly getSession?: (fetchImpl?: AuthFetch) => Promise<SessionUser | null>;
  readonly signIn?: typeof signInWithEmail;
  /** Where a newly joined person lands; replaced in tests. */
  readonly onJoined?: () => void;
}

type InviteState =
  | { readonly status: "checking" }
  | { readonly status: "set_password"; readonly invite: AdminInvitePreview }
  | { readonly status: "sign_in" }
  | { readonly status: "accepting" }
  | { readonly status: "accepted"; readonly result: SignupOnboardingInviteAcceptResponse }
  | { readonly status: "error"; readonly message: string };

export function SignupInviteShell({
  token,
  fetchImpl = sessionOptionalFetch,
  getSession = getSessionUser,
  signIn = signInWithEmail,
  onJoined = () => window.location.assign("/mail"),
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
    const continueWithSession = () =>
      getSession(fetchImpl)
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
    // An administrator's invitation is accepted by choosing a password; any
    // other invitation link is accepted by the signed-in person.
    void (token.trim().length === 0 ? Promise.resolve(null) : inspectAdminInvite(token, fetchImpl))
      .catch(() => null)
      .then((invite) => {
        if (!active) return;
        if (invite === null) return continueWithSession();
        setState({ status: "set_password", invite });
      });
    return () => {
      active = false;
      activeInviteRequestRef.current?.abort();
    };
  }, [acceptInvite, fetchImpl, getSession, token]);

  if (state.status === "set_password") {
    return (
      <SetPasswordPanel
        invite={state.invite}
        onSubmit={async (password) => {
          const accepted = await acceptAdminInvite({ token, password }, fetchImpl);
          await signIn({ email: accepted.email, password }, fetchImpl);
          onJoined();
        }}
      />
    );
  }

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

function SetPasswordPanel({
  invite,
  onSubmit,
}: {
  readonly invite: AdminInvitePreview;
  readonly onSubmit: (password: string) => Promise<void>;
}) {
  const errorId = useId();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorProps = error === null ? {} : { invalid: true, describedBy: errorId };

  const submit = () => {
    if (password.length < invite.passwordMinLength) {
      setError(`Use at least ${String(invite.passwordMinLength)} characters.`);
      return;
    }
    if (password !== confirmation) {
      setError("The passwords don’t match.");
      return;
    }
    setError(null);
    setBusy(true);
    onSubmit(password).catch((caught: unknown) => {
      setBusy(false);
      setError(caught instanceof Error ? caught.message : "Your account couldn’t be set up.");
    });
  };

  return (
    <AuthCard
      title={`Join ${invite.workspaceName}`}
      subtitle={`Choose a password for ${invite.email}.`}
    >
      <AuthForm legend="Choose your password" onSubmit={submit}>
        <AuthInput
          label="Password"
          name="new-password"
          type={showPassword ? "text" : "password"}
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          autoFocus
          {...errorProps}
        />
        <AuthInput
          label="Confirm password"
          name="confirm-password"
          type={showPassword ? "text" : "password"}
          autoComplete="new-password"
          value={confirmation}
          onChange={setConfirmation}
          {...errorProps}
        />
        <label className="auth-check">
          <input
            type="checkbox"
            checked={showPassword}
            onChange={(event) => setShowPassword(event.target.checked)}
          />
          <span>Show password</span>
        </label>
        {error === null ? null : (
          <p id={errorId} className="auth-error" role="alert">
            {error}
          </p>
        )}
        <div className="auth-actions">
          <SubmitButton busy={busy}>Join workspace</SubmitButton>
        </div>
      </AuthForm>
    </AuthCard>
  );
}
