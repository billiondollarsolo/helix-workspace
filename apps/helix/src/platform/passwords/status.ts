/** The workspace setting an administrator turns on to offer Passwords to people. */
export const PASSWORDS_APP_FLAG = "passwords_app";

/**
 * The optional password manager is a separate service with its own accounts;
 * the workspace only links to it. It is offered to people when the deployment
 * installed it (`HELIX_PASSWORDS_URL`) and their organization turned it on.
 */
export interface PasswordsStatus {
  /** The deployment runs a password manager. */
  readonly installed: boolean;
  /** The organization offers it to its people. */
  readonly enabled: boolean;
  /** Where to open it. Present only when installed and enabled. */
  readonly url: string | null;
}

export function resolvePasswordsStatus(
  publicUrl: string | undefined,
  enabled: boolean,
): PasswordsStatus {
  const installed = publicUrl !== undefined;
  return { installed, enabled, url: installed && enabled ? publicUrl : null };
}
