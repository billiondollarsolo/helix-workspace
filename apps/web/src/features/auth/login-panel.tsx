/* Sign in, one step at a time: email → Next → password (or the company
   identity provider when the email's domain is managed), then a second
   factor when the account has one. Errors never reveal whether an account
   exists. */

import { ArrowLeft, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  discoverSignInMethod,
  requestPasswordReset,
  resetPassword,
  SecondFactorRequiredError,
  signInWithEmail,
  signInWithOidc,
  signInWithPasskey,
  verifyRecoveryCode,
  verifyTotp,
  sendEmailMfaCode,
  verifyEmailMfaCode,
  type SessionUser,
  type SignInInput,
} from "@/lib/auth";
import { AuthCard } from "./auth-card";

type Step = "email" | "password" | "totp" | "recovery" | "email_code" | "forgot" | "reset";

const TITLES: Readonly<Record<Step, string>> = {
  email: "Sign in",
  password: "Welcome",
  totp: "2-step verification",
  recovery: "2-step verification",
  email_code: "2-step verification",
  forgot: "Reset your password",
  reset: "Choose a new password",
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export interface LocalLoginPanelProps {
  readonly reauthenticate?: boolean;
  /** From a password-reset link (`/login?token=`): opens "Choose a new password". */
  readonly resetToken?: string;
  readonly signIn?: (input: SignInInput) => Promise<SessionUser>;
  readonly discover?: (email: string) => Promise<"sso" | "password">;
  readonly onSignedIn?: (user: SessionUser) => Promise<void> | void;
}

export function LocalLoginPanel({
  reauthenticate = false,
  resetToken,
  signIn = signInWithEmail,
  discover = discoverSignInMethod,
  onSignedIn,
}: LocalLoginPanelProps = {}) {
  const [step, setStep] = useState<Step>(resetToken === undefined ? "email" : "reset");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState("");
  const [factorMethods, setFactorMethods] = useState<readonly string[]>(["totp"]);
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const errorId = useId();
  const busy = status === "submitting";
  useEffect(() => errorRef.current?.focus(), [error]);

  const goTo = (next: Step) => {
    setError(null);
    setStatus("idle");
    setStep(next);
  };

  async function run(operation: () => Promise<SessionUser | void>): Promise<void> {
    setStatus("submitting");
    setError(null);
    try {
      const user = await operation();
      if (user !== undefined) await onSignedIn?.(user);
      else setStatus("sent");
    } catch (caught) {
      setStatus("idle");
      if (caught instanceof SecondFactorRequiredError) {
        setCode("");
        setEmailCodeSent(false);
        setFactorMethods(caught.methods);
        if (caught.methods.includes("totp")) goTo("totp");
        else if (caught.methods.includes("otp")) goTo("email_code");
        else
          setError(
            "Your verification method is unavailable. Ask your administrator to restore it.",
          );
      } else setError(caught instanceof Error ? caught.message : "Sign-in failed. Try again.");
    }
  }

  const next = async () => {
    const trimmed = email.trim();
    if (!EMAIL_PATTERN.test(trimmed)) {
      setError("Enter a valid email address.");
      return;
    }
    setStatus("submitting");
    setError(null);
    if ((await discover(trimmed)) === "sso") {
      await run(() => signInWithOidc(trimmed));
      return;
    }
    goTo("password");
  };

  const errorProps = error === null ? {} : { invalid: true, describedBy: errorId };
  const message =
    error === null ? null : (
      <p ref={errorRef} id={errorId} className="auth-error" role="alert" tabIndex={-1}>
        {error}
      </p>
    );

  return (
    <AuthCard title={TITLES[step]} subtitle={subtitle(step)}>
      {reauthenticate ? (
        <p role="status" className="auth-notice">
          Your session must be verified again. Sign in again to continue.
        </p>
      ) : null}

      {step === "email" ? (
        <AuthForm legend="Sign in with your email" onSubmit={() => void next()}>
          <AuthInput
            label="Email"
            name="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={setEmail}
            autoFocus
            {...errorProps}
          />
          {message}
          <div className="auth-actions">
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => void run(signInWithPasskey)}
            >
              Use a passkey
            </button>
            <SubmitButton busy={busy}>Next</SubmitButton>
          </div>
        </AuthForm>
      ) : step === "password" ? (
        <AuthForm
          legend="Enter your password"
          onSubmit={() => void run(() => signIn({ email: email.trim(), password }))}
        >
          <AccountChip email={email.trim()} onChange={() => goTo("email")} />
          <AuthInput
            label="Password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            autoFocus
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
          {message}
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => goTo("forgot")}>
              Forgot password?
            </button>
            <SubmitButton busy={busy}>Sign in</SubmitButton>
          </div>
        </AuthForm>
      ) : step === "totp" || step === "recovery" || step === "email_code" ? (
        <AuthForm
          legend="Confirm it’s you"
          onSubmit={() =>
            void run(() =>
              step === "totp"
                ? verifyTotp(code)
                : step === "email_code"
                  ? verifyEmailMfaCode(code)
                  : verifyRecoveryCode(code),
            )
          }
        >
          <AuthInput
            label={
              step === "totp"
                ? "Authenticator code"
                : step === "email_code"
                  ? "Email code"
                  : "Recovery code"
            }
            name="code"
            autoComplete="one-time-code"
            inputMode={step === "recovery" ? "text" : "numeric"}
            value={code}
            onChange={setCode}
            autoFocus
            {...errorProps}
          />
          {message}
          {step === "email_code" && emailCodeSent ? (
            <p role="status" className="auth-notice">
              A code was sent to your verified external email. It expires in 5 minutes.
            </p>
          ) : null}
          <div className="auth-actions">
            {step === "email_code" ? (
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await sendEmailMfaCode();
                    setEmailCodeSent(true);
                  })
                }
              >
                {emailCodeSent ? "Resend email code" : "Send email code"}
              </button>
            ) : null}
            {factorMethods.includes("totp") ? (
              <button
                className="btn ghost"
                type="button"
                onClick={() => goTo(step === "totp" ? "recovery" : "totp")}
              >
                {step === "totp" ? "Use a recovery code" : "Use an authenticator code"}
              </button>
            ) : null}
            {factorMethods.includes("otp") && step !== "email_code" ? (
              <button type="button" className="btn ghost" onClick={() => goTo("email_code")}>
                Use an email code
              </button>
            ) : null}
            <SubmitButton busy={busy}>Verify</SubmitButton>
          </div>
        </AuthForm>
      ) : step === "forgot" ? (
        <AuthForm
          legend="Reset your password"
          onSubmit={() => void run(() => requestPasswordReset(email.trim()))}
        >
          <AuthInput
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            autoFocus
            {...errorProps}
          />
          {message}
          {status === "sent" ? (
            <p role="status" className="auth-notice">
              If an account uses this address, we’ve sent it a reset link.
            </p>
          ) : null}
          <div className="auth-actions">
            <button
              className="btn ghost"
              type="button"
              onClick={() => goTo(email.trim() === "" ? "email" : "password")}
            >
              <ArrowLeft aria-hidden="true" size={16} />
              Back to sign in
            </button>
            {status === "sent" ? null : <SubmitButton busy={busy}>Send reset link</SubmitButton>}
          </div>
        </AuthForm>
      ) : (
        <AuthForm
          legend="Choose a new password"
          onSubmit={() =>
            void run(async () => {
              if (resetToken === undefined) {
                throw new Error("This reset link is invalid. Request a new one.");
              }
              await resetPassword(resetToken, newPassword);
              setNewPassword("");
              goTo("email");
            })
          }
        >
          <AuthInput
            label="New password"
            name="new-password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={newPassword}
            onChange={setNewPassword}
            autoFocus
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
          {message}
          <div className="auth-actions">
            <SubmitButton busy={busy}>Reset password</SubmitButton>
          </div>
        </AuthForm>
      )}
    </AuthCard>
  );
}

function subtitle(step: Step): string {
  switch (step) {
    case "email":
      return "Use your Helix account";
    case "password":
      return "Enter your password to continue";
    case "totp":
      return "Enter the 6-digit code from your authenticator app";
    case "recovery":
      return "Enter one of your saved recovery codes";
    case "email_code":
      return "Send a 6-digit code to your verified external inbox";
    case "forgot":
      return "We’ll email you a link to choose a new password";
    case "reset":
      return "Reset links work once and expire after 15 minutes";
  }
}

function AccountChip({
  email,
  onChange,
}: {
  readonly email: string;
  readonly onChange: () => void;
}) {
  return (
    <div className="auth-account">
      <span className="auth-account-email">{email}</span>
      <button
        type="button"
        className="btn ghost sm"
        onClick={onChange}
        aria-label={`Use another account instead of ${email}`}
      >
        Change
      </button>
    </div>
  );
}

export function AuthForm({
  legend,
  onSubmit,
  children,
}: {
  readonly legend: string;
  readonly onSubmit: () => void;
  readonly children: ReactNode;
}) {
  return (
    <form
      className="auth-form"
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <fieldset className="auth-fieldset">
        <legend className="sr-only">{legend}</legend>
        {children}
      </fieldset>
    </form>
  );
}

export function AuthInput(props: {
  readonly label: string;
  readonly name: string;
  readonly type?: string;
  readonly autoComplete: string;
  readonly inputMode?: "numeric" | "text";
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoFocus?: boolean;
  readonly invalid?: boolean;
  readonly describedBy?: string;
}) {
  return (
    <label className="auth-field">
      <span className="auth-label">{props.label}</span>
      <input
        className="input"
        name={props.name}
        type={props.type ?? "text"}
        autoComplete={props.autoComplete}
        inputMode={props.inputMode}
        spellCheck={false}
        // Each sign-in step has one field to fill; focus moves to it.
        autoFocus={props.autoFocus}
        value={props.value}
        aria-invalid={props.invalid === true ? true : undefined}
        aria-describedby={props.describedBy}
        onChange={(event) => props.onChange(event.target.value)}
        required
      />
    </label>
  );
}

export function SubmitButton({
  busy,
  children,
}: {
  readonly busy: boolean;
  readonly children: ReactNode;
}) {
  return (
    <button className="btn primary auth-submit" type="submit" disabled={busy} aria-busy={busy}>
      {busy ? <Loader2 className="auth-spinner" aria-hidden="true" size={16} /> : null}
      {children}
    </button>
  );
}
