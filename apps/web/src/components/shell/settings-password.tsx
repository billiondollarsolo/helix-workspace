/* Change password: current, new and confirm, a strength hint, and an
   option to sign out everywhere else. */

import { useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { changeAccountPassword } from "@/features/account/api";
import { accountSessionsQueryOptions } from "@/features/account/security-queries";
import { SettingsCard } from "./settings-controls";

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

export type PasswordStrength = "too-short" | "weak" | "fair" | "strong";

/** A quick, local estimate: length plus the mix of character kinds. */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length < MIN_LENGTH) return "too-short";
  const kinds = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z0-9]/u].filter((kind) =>
    kind.test(password),
  ).length;
  if (password.length >= 16 || (password.length >= 12 && kinds >= 3)) return "strong";
  return kinds >= 3 || password.length >= 12 ? "fair" : "weak";
}

const STRENGTH_TEXT: Readonly<Record<PasswordStrength, string>> = {
  "too-short": `Use at least ${String(MIN_LENGTH)} characters.`,
  weak: "Weak. Make it longer or mix letters, numbers and symbols.",
  fair: "Fair. A longer passphrase is stronger.",
  strong: "Strong password.",
};

export function ChangePasswordCard() {
  const queryClient = useQueryClient();
  const ids = {
    current: useId(),
    next: useId(),
    confirm: useId(),
    strength: useId(),
    error: useId(),
    confirmError: useId(),
    signOutHint: useId(),
  };
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [show, setShow] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const strength = passwordStrength(next);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus(null);
    setError(null);
    if (next !== confirm) {
      setMismatch(true);
      return;
    }
    if (strength === "too-short") {
      setError(STRENGTH_TEXT["too-short"]);
      return;
    }
    setPending(true);
    try {
      await changeAccountPassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: signOutOthers,
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      setStatus(
        signOutOthers
          ? "Password changed. Your other devices were signed out."
          : "Password changed.",
      );
      void queryClient.invalidateQueries({ queryKey: accountSessionsQueryOptions().queryKey });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your password could not be changed.");
    } finally {
      setPending(false);
    }
  }

  const inputType = show ? "text" : "password";
  return (
    <SettingsCard
      title="Password"
      description="Choose a strong password you don’t use anywhere else"
    >
      <form onSubmit={(event) => void submit(event)} className="grid max-w-105 gap-4" noValidate>
        <fieldset disabled={pending} className="m-0 grid gap-4 border-0 p-0">
          <legend className="sr-only">Change password</legend>
          <div className="grid gap-1">
            <label htmlFor={ids.current} className="type-body-sm font-medium">
              Current password
            </label>
            <input
              id={ids.current}
              name="currentPassword"
              type={inputType}
              className="input"
              autoComplete="current-password"
              required
              value={current}
              aria-invalid={error === null ? undefined : true}
              aria-describedby={error === null ? undefined : ids.error}
              onChange={(event) => setCurrent(event.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor={ids.next} className="type-body-sm font-medium">
              New password
            </label>
            <input
              id={ids.next}
              name="newPassword"
              type={inputType}
              className="input"
              autoComplete="new-password"
              required
              minLength={MIN_LENGTH}
              maxLength={MAX_LENGTH}
              value={next}
              aria-describedby={ids.strength}
              onChange={(event) => setNext(event.target.value)}
            />
            <p
              id={ids.strength}
              aria-live="polite"
              data-strength={next === "" ? undefined : strength}
              className="m-0 type-caption text-muted-foreground data-[strength=strong]:text-[var(--success)] data-[strength=weak]:text-destructive"
            >
              {next === "" ? STRENGTH_TEXT["too-short"] : STRENGTH_TEXT[strength]}
            </p>
          </div>
          <div className="grid gap-1">
            <label htmlFor={ids.confirm} className="type-body-sm font-medium">
              Confirm new password
            </label>
            <input
              id={ids.confirm}
              name="confirmPassword"
              type={inputType}
              className="input"
              autoComplete="new-password"
              required
              value={confirm}
              aria-invalid={mismatch ? true : undefined}
              aria-describedby={mismatch ? ids.confirmError : undefined}
              onChange={(event) => {
                setConfirm(event.target.value);
                setMismatch(false);
              }}
            />
            {mismatch ? (
              <p id={ids.confirmError} role="alert" className="m-0 type-caption text-destructive">
                Passwords don’t match.
              </p>
            ) : null}
          </div>
          <label className="flex items-center gap-2 type-body-sm">
            <input
              type="checkbox"
              checked={show}
              onChange={(event) => setShow(event.target.checked)}
              className="focus-ring accent-[var(--accent)]"
            />
            Show passwords
          </label>
          <div>
            <label className="flex items-center gap-2 type-body-sm">
              <input
                type="checkbox"
                checked={signOutOthers}
                aria-describedby={ids.signOutHint}
                onChange={(event) => setSignOutOthers(event.target.checked)}
                className="focus-ring accent-[var(--accent)]"
              />
              Sign out of other devices
            </label>
            <p id={ids.signOutHint} className="m-0 ml-6 type-caption text-muted-foreground">
              Recommended if you think someone else knows your password.
            </p>
          </div>
        </fieldset>
        {error === null ? null : (
          <p id={ids.error} role="alert" className="m-0 type-body-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="btn primary sm"
            disabled={pending || current === "" || next === "" || confirm === ""}
          >
            {pending ? "Changing…" : "Change password"}
          </button>
          <p role="status" className="m-0 type-body-sm text-muted-foreground">
            {status}
          </p>
        </div>
      </form>
    </SettingsCard>
  );
}
