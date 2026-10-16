import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { sessionUserQueryOptions } from "@/lib/auth";
import {
  confirmExternalEmail,
  requestExternalEmailVerification,
  setEmailFactorEnabled,
} from "@/features/account/email-factor";
import { accountEmailFactorQueryOptions } from "@/features/account/queries";
import { SettingsField, SettingsStatus } from "./settings-controls";

export function EmailFactorSettings() {
  const queryClient = useQueryClient();
  const factors = useQuery(accountEmailFactorQueryOptions());
  const id = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const status = factors.data;

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await operation();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: accountEmailFactorQueryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: sessionUserQueryOptions().queryKey }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Email verification failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsField
      label="Email codes"
      hint="Optional. A second step after your password, sent to a verified external inbox."
    >
      {factors.isPending ? (
        <p role="status" className="type-body-sm">
          Checking email delivery…
        </p>
      ) : factors.isError ? (
        <p role="alert" className="type-body-sm">
          Could not check email verification.{" "}
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              void queryClient.invalidateQueries({
                queryKey: accountEmailFactorQueryOptions().queryKey,
              })
            }
          >
            Retry
          </button>
        </p>
      ) : (
        <>
          {status?.outboundReady === false ? (
            <p role="status" className="type-body-sm">
              Outbound email must be configured and working before you can enable email codes.
            </p>
          ) : null}
          {status?.verified ? (
            <p className="type-body-sm [overflow-wrap:anywhere]">
              Verified external email: {status.email}. Email codes are{" "}
              {status.enabled ? "on" : "off"}.
            </p>
          ) : null}
          <form
            className="grid max-w-80 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await requestExternalEmailVerification(email, password);
                setPassword("");
                setMessage(
                  "A verification code was sent to your external inbox. It expires in 10 minutes.",
                );
              });
            }}
          >
            <label htmlFor={`${id}-email`} className="type-body-sm">
              External email address
            </label>
            <input
              id={`${id}-email`}
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <label htmlFor={`${id}-password`} className="type-body-sm">
              Confirm email settings with your password
            </label>
            <input
              id={`${id}-password`}
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                className="btn sm"
                disabled={
                  busy || !status?.outboundReady || email.length === 0 || password.length === 0
                }
              >
                Send verification code
              </button>
              {status?.verified ? (
                <button
                  type="button"
                  className="btn sm"
                  disabled={
                    busy || password.length === 0 || (!status.enabled && !status.outboundReady)
                  }
                  onClick={() =>
                    void run(async () => {
                      await setEmailFactorEnabled(!status.enabled, password);
                      setPassword("");
                      setMessage(
                        status.enabled ? "Email codes turned off." : "Email codes turned on.",
                      );
                    })
                  }
                >
                  {status.enabled ? "Turn off email codes" : "Turn on email codes"}
                </button>
              ) : null}
            </div>
          </form>
          {status?.pendingEmail ? (
            <form
              className="mt-3 grid max-w-80 gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await confirmExternalEmail(code);
                  setCode("");
                  setMessage("External email verified. You can now turn on email codes.");
                });
              }}
            >
              <p className="type-body-sm [overflow-wrap:anywhere]">
                Check {status.pendingEmail} for your verification code.
              </p>
              <label htmlFor={`${id}-code`} className="type-body-sm">
                External email verification code
              </label>
              <input
                id={`${id}-code`}
                className="input"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <button type="submit" className="btn sm" disabled={busy || !/^\d{6}$/u.test(code)}>
                Verify external email
              </button>
            </form>
          ) : null}
        </>
      )}
      {error === null ? null : (
        <p role="alert" className="type-body-sm text-destructive">
          {error}
        </p>
      )}
      <SettingsStatus message={message} />
    </SettingsField>
  );
}
