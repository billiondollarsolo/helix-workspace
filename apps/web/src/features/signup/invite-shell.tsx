import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, Dna, Loader2, TriangleAlert } from "lucide-react";
import { useCallback, useState } from "react";
import type { AuthFetch } from "@/lib/auth";
import { acceptWorkspaceInvite, type WorkspaceInviteAcceptResponse } from "./api";

interface SignupInviteShellProps {
  readonly token: string;
  readonly fetchImpl?: AuthFetch;
}

type InviteState =
  | { readonly status: "join" }
  | { readonly status: "accepting" }
  | { readonly status: "accepted"; readonly result: WorkspaceInviteAcceptResponse }
  | { readonly status: "error"; readonly message: string };

export function SignupInviteShell({ token, fetchImpl = fetch }: SignupInviteShellProps) {
  const [state, setState] = useState<InviteState>({ status: "join" });
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");

  const acceptInvite = useCallback(
    (nextToken: string, nextPassword: string, nextDisplayName: string) => {
      if (nextToken.trim().length === 0) {
        setState({ status: "error", message: "This invitation link is missing its token." });
        return;
      }
      if (nextPassword.length < 12) {
        setState({ status: "error", message: "Choose a password of at least 12 characters." });
        return;
      }
      const controller = new AbortController();
      setState({ status: "accepting" });
      void acceptWorkspaceInvite(
        {
          token: nextToken,
          password: nextPassword,
          ...(nextDisplayName.trim().length === 0 ? {} : { displayName: nextDisplayName.trim() }),
        },
        fetchImpl,
        { signal: controller.signal },
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setState({ status: "accepted", result });
        })
        .catch((caught) => {
          if (controller.signal.aborted) return;
          setState({
            status: "error",
            message: caught instanceof Error ? caught.message : "Invitation could not be accepted.",
          });
        });
    },
    [fetchImpl],
  );

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

        {state.status === "accepting" ? (
          <div className="auth-success" role="status" aria-live="polite" aria-atomic="true">
            <Loader2 className="auth-spinner" aria-hidden="true" />
            <span>Joining workspace…</span>
          </div>
        ) : null}

        {state.status === "join" || state.status === "error" ? (
          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              acceptInvite(token, password, displayName);
            }}
          >
            {state.status === "error" ? (
              <p className="auth-error" role="alert">
                {state.message}
              </p>
            ) : null}
            <label className="auth-field">
              <span>Display name</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
                maxLength={120}
              />
            </label>
            <label className="auth-field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                minLength={12}
                required
              />
            </label>
            <button className="btn primary lg auth-submit" type="submit">
              Join workspace
              <ArrowRight aria-hidden="true" />
            </button>
          </form>
        ) : null}

        {state.status === "accepted" ? (
          <div className="auth-success" role="status" aria-live="polite" aria-atomic="true">
            <CheckCircle2 aria-hidden="true" />
            <span>
              Workspace{state.result.org === null ? "" : ` ${state.result.org.slug}`} is ready. Sign
              in with the password you just set.
            </span>
          </div>
        ) : null}

        {state.status === "accepted" ? (
          <Link className="btn primary lg auth-submit" to="/login">
            Sign in
            <ArrowRight aria-hidden="true" />
          </Link>
        ) : null}
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
  return "Join this workspace";
}

function subtitleForState(state: InviteState): string {
  if (state.status === "accepted") {
    return "Your account is ready. Sign in with email and the password you just chose.";
  }
  if (state.status === "error") {
    return "Use the latest invitation link from your inbox.";
  }
  return "Set a password to join the organization you were invited to.";
}
