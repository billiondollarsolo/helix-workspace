import { HttpError } from "./http.js";

/** Where people create the credentials that only a signed-in browser session can mint. */
const SIGNED_IN_ONLY_HINTS: Readonly<Record<string, string>> = {
  "app.passwords.create":
    "App passwords are created while signed in to Helix on the web: open Settings → App passwords. From the CLI you can list and revoke them (helix account app-passwords, helix account app-password-revoke).",
  "drive.s3-keys.create":
    "S3 access keys are created while signed in to Helix on the web: open Settings → S3 access keys. From the CLI you can list and revoke them (helix drive s3-keys list|revoke).",
};

const SIGNED_IN_ONLY = /\bTool (\S+) requires a signed-in session\b/u;

/**
 * What to do instead when a tool refused the CLI's delegated token because it
 * only runs in a signed-in browser session; undefined for any other failure.
 */
export function signedInSessionHint(error: unknown): string | undefined {
  if (!(error instanceof HttpError) || error.status !== 403) return undefined;
  const toolId = SIGNED_IN_ONLY.exec(error.body)?.[1];
  if (toolId === undefined) return undefined;
  return (
    SIGNED_IN_ONLY_HINTS[toolId] ??
    `${toolId} only runs while signed in to Helix on the web; the CLI's token cannot use it.`
  );
}
