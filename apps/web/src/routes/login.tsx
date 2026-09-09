import { createFileRoute, redirect } from "@tanstack/react-router";
import { Dna, Loader2, LogIn } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import {
  getSessionUser,
  requestPasswordReset,
  resetPassword,
  SecondFactorRequiredError,
  signInWithEmail,
  signInWithOidc,
  signInWithPasskey,
  verifyRecoveryCode,
  verifyTotp,
  type SessionUser,
  type SignInInput,
} from "@/lib/auth";

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    if ((await getSessionUser()) !== null) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: "/mail", search: {} });
    }
  },
  component: LoginRoute,
});

const DEMO_ACCOUNTS = [
  { label: "Admin", email: "admin@helix.local", password: "helix-admin-password" },
  { label: "Member", email: "user@helix.local", password: "helix-user-password" },
] as const;

function LoginRoute() {
  const navigate = Route.useNavigate();
  return <LocalLoginPanel onSignedIn={() => navigate({ to: "/mail", search: {} })} />;
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
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [mode, setMode] = useState<"password" | "totp" | "recovery" | "forgot" | "reset">(
    resetToken() === null ? "password" : "reset",
  );
  const [status, setStatus] = useState<"idle" | "submitting" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => errorRef.current?.focus(), [error]);

  async function run(operation: () => Promise<SessionUser | void>): Promise<void> {
    setStatus("submitting");
    setError(null);
    try {
      const user = await operation();
      if (user !== undefined) await onSignedIn?.(user);
      else setStatus("sent");
    } catch (caught) {
      setStatus("idle");
      if (caught instanceof SecondFactorRequiredError) setMode("totp");
      else setError(caught instanceof Error ? caught.message : "Authentication failed.");
    }
  }

  const submit = (nextEmail: string, nextPassword: string) =>
    run(() => signIn({ email: nextEmail.trim(), password: nextPassword }));
  const busy = status === "submitting";

  return (
    <main className="auth-screen">
      <section className="panel auth-panel">
        <div className="auth-brand">
          <div className="auth-logo" aria-hidden="true">
            <Dna />
          </div>
          <h1 className="auth-title">
            {mode === "forgot"
              ? "Reset your password"
              : mode === "reset"
                ? "Choose a new password"
                : "Sign in to Helix"}
          </h1>
          <p className="auth-subtitle">
            {mode === "password"
              ? "Local email/password is always available. You can also use a passkey."
              : mode === "forgot"
                ? "We’ll send a short-lived link if this account exists."
                : mode === "reset"
                  ? "Reset links work once and expire after 15 minutes."
                  : "Complete your secure sign-in."}
          </p>
        </div>

        {mode === "password" ? (
          <>
            <button
              className="btn lg auth-submit"
              type="button"
              disabled={busy}
              onClick={() => void run(signInWithPasskey)}
            >
              Use a passkey
            </button>
            <button
              className="btn lg auth-submit"
              type="button"
              disabled={busy || email.trim().length === 0}
              onClick={() => void run(() => signInWithOidc(email))}
            >
              Continue with company SSO
            </button>
            <div className="auth-method-header">
              <span>Local email/password login</span>
              <span>Email + password</span>
            </div>
            <AuthForm onSubmit={() => void submit(email, password)}>
              <AuthInput
                label="Email"
                name="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={setEmail}
                invalid={error !== null}
              />
              <AuthInput
                label="Password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={setPassword}
                invalid={error !== null}
              />
              <ErrorMessage error={error} errorRef={errorRef} />
              <SubmitButton busy={busy}>Sign in</SubmitButton>
              <button className="btn sm" type="button" onClick={() => setMode("forgot")}>
                Forgot password?
              </button>
            </AuthForm>
            <div className="auth-demo">
              <span className="auth-demo-label">Local demo accounts</span>
              <div className="auth-demo-row">
                {DEMO_ACCOUNTS.map((account) => (
                  <button
                    key={account.email}
                    type="button"
                    className="btn sm"
                    disabled={busy}
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
          </>
        ) : mode === "totp" || mode === "recovery" ? (
          <AuthForm
            onSubmit={() =>
              void run(() => (mode === "totp" ? verifyTotp(code) : verifyRecoveryCode(code)))
            }
          >
            <AuthInput
              label={mode === "totp" ? "Authenticator code" : "Recovery code"}
              name="code"
              autoComplete="one-time-code"
              value={code}
              onChange={setCode}
            />
            <ErrorMessage error={error} errorRef={errorRef} />
            <SubmitButton busy={busy}>Verify</SubmitButton>
            <button
              className="btn sm"
              type="button"
              onClick={() => setMode(mode === "totp" ? "recovery" : "totp")}
            >
              {mode === "totp" ? "Use a recovery code" : "Use an authenticator code"}
            </button>
          </AuthForm>
        ) : mode === "forgot" ? (
          <AuthForm onSubmit={() => void run(() => requestPasswordReset(email))}>
            <AuthInput
              label="Email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={setEmail}
            />
            <ErrorMessage error={error} errorRef={errorRef} />
            {status === "sent" ? (
              <p>Check your email if the account exists.</p>
            ) : (
              <SubmitButton busy={busy}>Send reset link</SubmitButton>
            )}
            <button className="btn sm" type="button" onClick={() => setMode("password")}>
              Back to sign in
            </button>
          </AuthForm>
        ) : (
          <AuthForm
            onSubmit={() =>
              void run(async () => {
                const token = resetToken();
                if (token === null) throw new Error("Reset link is invalid.");
                await resetPassword(token, newPassword);
                setMode("password");
                setNewPassword("");
              })
            }
          >
            <AuthInput
              label="New password"
              name="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={setNewPassword}
            />
            <ErrorMessage error={error} errorRef={errorRef} />
            <SubmitButton busy={busy}>Reset password</SubmitButton>
          </AuthForm>
        )}
      </section>
    </main>
  );
}

function AuthForm({
  onSubmit,
  children,
}: {
  readonly onSubmit: () => void;
  readonly children: ReactNode;
}) {
  return (
    <form
      className="auth-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

function AuthInput(props: {
  readonly label: string;
  readonly name: string;
  readonly type?: string;
  readonly autoComplete: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly invalid?: boolean;
}) {
  return (
    <label className="auth-field">
      <span className="auth-label">{props.label}</span>
      <input
        className="input"
        name={props.name}
        type={props.type ?? "text"}
        autoComplete={props.autoComplete}
        spellCheck={false}
        value={props.value}
        aria-invalid={props.invalid || undefined}
        aria-describedby={props.invalid ? "login-error" : undefined}
        onChange={(event) => props.onChange(event.target.value)}
        required
      />
    </label>
  );
}

function ErrorMessage({
  error,
  errorRef,
}: {
  readonly error: string | null;
  readonly errorRef: RefObject<HTMLParagraphElement | null>;
}) {
  return error === null ? null : (
    <p ref={errorRef} id="login-error" className="auth-error" role="alert" tabIndex={-1}>
      {error}
    </p>
  );
}

function SubmitButton({
  busy,
  children,
}: {
  readonly busy: boolean;
  readonly children: ReactNode;
}) {
  return (
    <button className="btn primary lg auth-submit" type="submit" disabled={busy} aria-busy={busy}>
      {busy ? (
        <Loader2 className="auth-spinner" aria-hidden="true" />
      ) : (
        <LogIn aria-hidden="true" />
      )}
      {busy ? "Please wait…" : children}
    </button>
  );
}

function resetToken(): string | null {
  return typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("token");
}
