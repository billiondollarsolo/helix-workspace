/* Asks for a fresh 2-step verification when an administrator request was
   refused for lack of a recent one, then lets that request go ahead (see
   lib/second-factor-step-up). Someone without a second step is sent to their
   security settings when the action needs one, or back to sign-in when the
   whole session has to be verified again. */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState, useSyncExternalStore, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/helix-dialog";
import { accountPasskeysQueryOptions } from "@/features/account/security-queries";
import {
  sessionUserQueryOptions,
  signInWithPasskey,
  verifyRecoveryCode,
  verifyTotp,
  sendEmailMfaCode,
  verifyEmailMfaCode,
} from "@/lib/auth";
import {
  secondFactorStepUpReason,
  settleSecondFactorStepUp,
  subscribeSecondFactorStepUp,
  type StepUpReason,
} from "@/lib/second-factor-step-up";

interface SecondFactorPromptProps {
  readonly onOpenSecuritySettings: () => void;
}

export function SecondFactorPrompt(props: SecondFactorPromptProps) {
  const reason = useSyncExternalStore(
    subscribeSecondFactorStepUp,
    secondFactorStepUpReason,
    () => null,
  );
  return reason === null ? null : <SecondFactorDialog reason={reason} {...props} />;
}

function SecondFactorDialog({
  reason,
  onOpenSecuritySettings,
}: SecondFactorPromptProps & { readonly reason: StepUpReason }) {
  const formId = useId();
  const errorId = useId();
  const { data: user } = useQuery(sessionUserQueryOptions());
  const passkeys = useQuery(accountPasskeysQueryOptions());
  const [mode, setMode] = useState<"totp" | "recovery" | "email">("totp");
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasAuthenticator = user?.twoFactorEnabled === true && user.totpEnabled !== false;
  const hasEmail = user?.emailOtpEnabled === true;
  const currentMode = !hasAuthenticator && hasEmail ? "email" : mode;
  const hasPasskey = (passkeys.data?.length ?? 0) > 0;
  const noSecondStep = !hasAuthenticator && !hasEmail && !hasPasskey && !passkeys.isPending;
  const mustSignIn = reason === "reauthentication" && noSecondStep;
  const cancel = () => settleSecondFactorStepUp(false);
  // Only a password can verify this session again, and that is the sign-in page.
  useEffect(() => {
    if (mustSignIn) settleSecondFactorStepUp(false);
  }, [mustSignIn]);

  const verify = (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    operation()
      .then(() => settleSecondFactorStepUp(true))
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "That code did not work. Try again.");
        setBusy(false);
      });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = code.trim();
    if (value.length === 0) {
      setError(currentMode === "recovery" ? "Enter a recovery code." : "Enter the 6-digit code.");
      return;
    }
    verify(() =>
      currentMode === "totp"
        ? verifyTotp(value)
        : currentMode === "email"
          ? verifyEmailMfaCode(value)
          : verifyRecoveryCode(value),
    );
  };

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      await sendEmailMfaCode();
      setEmailCodeSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your code could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  // Passkeys decide between verifying and setting up; wait rather than guess.
  if ((!hasAuthenticator && !hasEmail && passkeys.isPending) || mustSignIn) return null;
  if (noSecondStep) {
    return (
      <Dialog
        title="Set up 2-step verification"
        onClose={cancel}
        footer={
          <>
            <Button type="button" variant="outline" onClick={cancel}>
              Not now
            </Button>
            <Button
              type="button"
              onClick={() => {
                cancel();
                onOpenSecuritySettings();
              }}
            >
              Open security settings
            </Button>
          </>
        }
      >
        <p className="type-body-sm text-[var(--text-2)]">
          Administrator actions need 2-step verification on your account. Add an authenticator app
          or a passkey, or verify an external email in your security settings, then try again.
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Confirm it’s you"
      onClose={cancel}
      footer={
        <>
          <Button type="button" variant="outline" onClick={cancel}>
            {reason === "reauthentication" ? "Sign in instead" : "Cancel"}
          </Button>
          {hasAuthenticator || hasEmail ? (
            <Button
              type="submit"
              form={formId}
              disabled={busy || (currentMode === "email" && !emailCodeSent)}
              aria-busy={busy}
            >
              {busy ? "Verifying…" : "Verify"}
            </Button>
          ) : (
            <Button type="button" disabled={busy} onClick={() => verify(signInWithPasskey)}>
              Use a passkey
            </Button>
          )}
        </>
      }
    >
      <form id={formId} className="grid gap-3" noValidate onSubmit={submit}>
        <p className="type-body-sm text-[var(--text-2)]">
          {reason === "reauthentication"
            ? "It has been a while since you last verified. "
            : "Administrator actions need a recent 2-step verification. "}
          What you were doing continues as soon as you verify.
        </p>
        {hasAuthenticator || hasEmail ? (
          <>
            <label className="grid gap-1 type-body-sm">
              <span className="font-medium">
                {currentMode === "totp"
                  ? "Authenticator code"
                  : currentMode === "email"
                    ? "Email code"
                    : "Recovery code"}
              </span>
              <input
                className="input"
                name="code"
                autoComplete="one-time-code"
                inputMode={currentMode === "recovery" ? "text" : "numeric"}
                spellCheck={false}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                aria-invalid={error === null ? undefined : true}
                aria-describedby={error === null ? undefined : errorId}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {currentMode === "email" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void sendCode()}
                >
                  {emailCodeSent ? "Resend email code" : "Send email code"}
                </Button>
              ) : null}
              {hasEmail && currentMode !== "email" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setMode("email");
                    setCode("");
                    setError(null);
                  }}
                >
                  Use an email code
                </Button>
              ) : null}
              {hasAuthenticator ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setMode(currentMode === "totp" ? "recovery" : "totp");
                    setCode("");
                    setError(null);
                  }}
                >
                  {currentMode === "totp" ? "Use a recovery code" : "Use an authenticator code"}
                </Button>
              ) : null}
              {hasPasskey ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => verify(signInWithPasskey)}
                >
                  Use a passkey
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
        {currentMode === "email" && emailCodeSent ? (
          <p role="status" className="type-body-sm">
            A code was sent to your verified external email. It expires in 5 minutes.
          </p>
        ) : null}
        {error === null ? null : (
          <p id={errorId} className="type-body-sm text-[var(--danger)]" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
