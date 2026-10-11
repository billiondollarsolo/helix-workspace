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
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { SettingsField } from "./settings-controls";

/* ---------- Security ---------- */

export function SecuritySection() {
  const { data: user, refetch: refetchSession } = useQuery(sessionUserQueryOptions());
  const [passkeys, setPasskeys] = useState<readonly PasskeyRecord[]>([]);
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passkeyLoadError, setPasskeyLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <>
      <h1 className="[font-size:var(--text-h2)] font-semibold [margin:0_0_4px]">Security</h1>
      <div className="[font-size:var(--text-body-sm)] text-muted-foreground mb-2">
        Passkeys, authenticator apps, and one-time recovery codes
      </div>
      <SettingsField label="Passkeys" hint="Preferred: phishing-resistant WebAuthn credentials">
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
          <div role="alert" className="mt-2">
            {passkeyLoadError}
            <button className="btn sm ml-2" type="button" onClick={loadPasskeys}>
              Retry loading passkeys
            </button>
          </div>
        )}
        {passkeys.map((passkey) => (
          <div key={passkey.id} className="mt-2">
            {passkey.name ?? "Passkey"}
            <button
              className="btn sm ml-2"
              type="button"
              disabled={busy}

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
          </div>
        ))}
      </SettingsField>
      <SettingsField label="Authenticator app" hint="TOTP fallback requires your current password">
        <label htmlFor="settings-current-password" className="block mb-1">
          Current password
        </label>
        <input
          id="settings-current-password"
          name="currentPassword"
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {user?.twoFactorEnabled ? (
          <button
            className="btn sm ml-2"
            type="button"
            disabled={busy || password.length === 0}

            onClick={() =>
              void run(async () => {
                await disableTotp(password);
                setPassword("");
                await refetchSession();
                setRecoveryCodes([]);
                setMessage("Authenticator app turned off.");
              })
            }
          >
            Disable TOTP
          </button>
        ) : (
          <button
            className="btn sm ml-2"
            type="button"
            disabled={busy || password.length === 0}

            onClick={() =>
              void run(async () => {
                const setup = await enableTotp(password);
                setTotpUri(setup.totpURI);
                setRecoveryCodes(setup.backupCodes);
              })
            }
          >
            Set up TOTP
          </button>
        )}
        {totpUri === null ? null : (
          <div className="mt-2">
            <div className="[overflow-wrap:anywhere]">{totpUri}</div>
            <label htmlFor="settings-totp-code" className="block mt-2 mb-1">
              6-digit code from your authenticator app
            </label>
            <input
              id="settings-totp-code"
              name="totpCode"
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totpCode}
              onChange={(event) => setTotpCode(event.target.value)}
            />
            <button
              className="btn sm ml-2"
              type="button"
              disabled={busy || totpCode.length < 6}

              onClick={() =>
                void run(async () => {
                  await verifyTotp(totpCode);
                  setTotpUri(null);
                  setTotpCode("");
                  setPassword("");
                  await refetchSession();
                  setMessage("Authenticator app turned on.");
                })
              }
            >
              Verify
            </button>
          </div>
        )}
      </SettingsField>
      <SettingsField
        label="Recovery codes"
        hint="Shown once; each code works once and cannot be recovered"
      >
        {user?.twoFactorEnabled ? (
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
          <span>Enable TOTP to create recovery codes.</span>
        )}
        {recoveryCodes.length === 0 ? null : <pre className="mt-2">{recoveryCodes.join("\n")}</pre>}
      </SettingsField>
      {error === null ? null : <div role="alert">{error}</div>}
      {message === null ? null : <div role="status">{message}</div>}
    </>
  );
}
