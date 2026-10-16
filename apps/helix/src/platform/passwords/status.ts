/** The workspace setting an administrator turns on to offer Passwords to people. */
export const PASSWORDS_APP_FLAG = "passwords_app";

/**
 * Native personal vaults are bundled with Helix and enabled by organization policy.
 * HELIX_PASSWORDS_URL preserves access to an existing external vault during migration.
 */
export interface PasswordsStatus {
  /** The deployment runs a password manager. */
  readonly installed: boolean;
  /** The organization offers it to its people. */
  readonly enabled: boolean;
  /** Where to open it. Present only when installed and enabled. */
  readonly url: string | null;
  readonly native: boolean;
}

export function resolvePasswordsStatus(
  publicUrl: string | undefined,
  enabled: boolean,
): PasswordsStatus {
  return { installed: true, enabled, native: true, url: enabled ? (publicUrl ?? null) : null };
}
