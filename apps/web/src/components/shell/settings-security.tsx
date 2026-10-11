/* Security: password, signed-in devices, and 2-step verification
   (passkeys, an authenticator app and recovery codes). */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import {
  addPasskey,
  deletePasskey,
  disableTotp,
  enableTotp,
  listPasskeys,
  regenerateRecoveryCodes,
  sessionUserQueryOptions,
  verifyTotp,
  type PasskeyRecord,
} from "@/lib/auth";
import { SettingsCard, SettingsField, SettingsHeader, SettingsStatus } from "./settings-controls";
import { DevicesCard } from "./settings-devices";
import { ChangePasswordCard } from "./settings-password";

export function SecuritySection() {
  return (
    <>
      <SettingsHeader
        title="Security"
        description="Keep your account safe: your password, your devices and 2-step verification"
      />
      <ChangePasswordCard />
      <DevicesCard />
      <TwoStepCard />
    </>
  );
}

function TwoStepCard() {
  const { data: user, refetch: refetchSession } = useQuery(sessionUserQueryOptions());
  const ids = { password: useId(), code: useId(), error: useId() };
  const [passkeys, setPasskeys] = useState<readonly PasskeyRecord[]>([]);
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passkeyLoadError, setPasskeyLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const totpOn = user?.twoFactorEnabled === true;

  async function run(operation: () => Promise<void>): Promise<void> {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await operation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Security update failed.");
    } finally {
      setBusy(false);
    }
  }

  /* A failed list must not read as "no passkeys": that hides credentials the
     user may want to remove. */
  const loadPasskeys = useCallback((): void => {
    setPasskeyLoadError(null);
    void listPasskeys()
      .then(setPasskeys)
      .catch((caught: unknown) => {
        setPasskeyLoadError(
          `Could not load your passkeys. ${caught instanceof Error ? caught.message : "Try again."}`,
        );
      });
  }, []);

  useEffect(loadPasskeys, [loadPasskeys]);

  const submitPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.length === 0) return;
    void run(async () => {
      if (totpOn) {
        await disableTotp(password);
        setPassword("");
        await refetchSession();
        setRecoveryCodes([]);
        setMessage("Authenticator app turned off.");
        return;
      }
      const setup = await enableTotp(password);
      setTotpUri(setup.totpURI);
      setRecoveryCodes(setup.backupCodes);
    });
  };

  const errorProps = error === null ? {} : { "aria-invalid": true, "aria-describedby": ids.error };

  return (
    <SettingsCard
      title="2-step verification"
      description="A second step at sign-in keeps your account safe even if your password leaks"
    >
      <SettingsField label="Passkeys" hint="Sign in with your fingerprint, face or screen lock">
        <button
          className="btn sm"
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await addPasskey("Helix passkey");
              setPasskeys(await listPasskeys());
              setPasskeyLoadError(null);
              setMessage("Passkey added.");
            })
          }
        >
          Add passkey
        </button>
        {passkeyLoadError === null ? null : (
          <div role="alert" className="mt-2 type-body-sm">
            {passkeyLoadError}
            <button className="btn sm ml-2" type="button" onClick={loadPasskeys}>
              Retry loading passkeys
            </button>
          </div>
        )}
        {passkeys.length === 0 ? null : (
          <ul className="m-0 mt-2 list-none p-0">
            {passkeys.map((passkey) => (
              <li key={passkey.id} className="flex items-center gap-2 py-1 type-body-sm">
                <span className="min-w-0 flex-1">{passkey.name ?? "Passkey"}</span>
                <button
                  className="btn sm ghost"
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${passkey.name ?? "passkey"}`}
                  onClick={() =>
                    void run(async () => {
                      await deletePasskey(passkey.id);
                      setPasskeys(await listPasskeys());
                      setMessage("Passkey removed.");
                    })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingsField>
      <SettingsField
        label="Authenticator app"
        hint={totpOn ? "On. Codes come from your authenticator app." : "Off"}
      >
        <form onSubmit={submitPassword} className="grid max-w-80 gap-2">
          <label htmlFor={ids.password} className="type-body-sm">
            Confirm with your current password
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={ids.password}
              name="currentPassword"
              className="input min-w-0 flex-1"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              {...errorProps}
            />
            <button className="btn sm" type="submit" disabled={busy || password.length === 0}>
              {totpOn ? "Turn off" : "Set up"}
            </button>
          </div>
        </form>
        {totpUri === null ? null : (
          <form
            className="mt-3 grid max-w-80 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await verifyTotp(totpCode);
                setTotpUri(null);
                setTotpCode("");
                setPassword("");
                await refetchSession();
                setMessage("Authenticator app turned on.");
              });
            }}
          >
            <p className="m-0 type-body-sm">Add this key to your authenticator app:</p>
            <code className="block rounded bg-muted p-2 type-caption [overflow-wrap:anywhere]">
              {totpUri}
            </code>
            <label htmlFor={ids.code} className="type-body-sm">
              6-digit code from your authenticator app
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id={ids.code}
                name="totpCode"
                className="input min-w-0 flex-1"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value)}
              />
              <button
                className="btn sm primary"
                type="submit"
                disabled={busy || totpCode.length < 6}
              >
                Verify
              </button>
            </div>
          </form>
        )}
      </SettingsField>
      <SettingsField label="Recovery codes" hint="Each code works once. Keep them somewhere safe.">
        {totpOn ? (
          <button
            className="btn sm"
            type="button"
            disabled={busy || password.length === 0}
            onClick={() =>
              void run(async () => {
                setRecoveryCodes(await regenerateRecoveryCodes(password));
                setPassword("");
              })
            }
          >
            Replace recovery codes
          </button>
        ) : (
          <p className="m-0 type-body-sm text-muted-foreground">
            Set up an authenticator app to get recovery codes.
          </p>
        )}
        {totpOn ? (
          <p className="m-0 mt-1 type-caption text-muted-foreground">
            Enter your current password above first.
          </p>
        ) : null}
        {recoveryCodes.length === 0 ? null : (
          <pre className="mt-2 rounded bg-muted p-2 type-body-sm">{recoveryCodes.join("\n")}</pre>
        )}
      </SettingsField>
      {error === null ? null : (
        <p id={ids.error} role="alert" className="m-0 mt-2 type-body-sm text-destructive">
          {error}
        </p>
      )}
      <SettingsStatus message={message} />
    </SettingsCard>
  );
}
