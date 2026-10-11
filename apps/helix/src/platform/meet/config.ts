import type { Env } from "../../config/env.js";

const REQUIRED_MEET_SECRETS = [
  "MEET_JITSI_JWT_SECRET",
  "MEET_JITSI_WEBHOOK_SHARED_SECRET",
] as const;

/** The Jitsi secrets Meet still needs; empty when Meet is configured. */
export function missingMeetSecrets(env: Env): readonly string[] {
  return REQUIRED_MEET_SECRETS.filter((name) => (env[name] ?? "") === "");
}

/**
 * Meet's Jitsi secrets, or null when they are not configured. Meet then stays
 * unavailable in every environment: there is no built-in development secret,
 * so local and test setups configure their own (see `.env.example`).
 */
export function meetSecrets(env: Env): {
  readonly jwtSecret: string;
  readonly webhookSecret: string;
} | null {
  const jwtSecret = env.MEET_JITSI_JWT_SECRET ?? "";
  const webhookSecret = env.MEET_JITSI_WEBHOOK_SHARED_SECRET ?? "";
  if (jwtSecret === "" || webhookSecret === "") return null;
  if (env.NODE_ENV === "production") {
    assertProductionSecret("MEET_JITSI_JWT_SECRET", jwtSecret);
    assertProductionSecret("MEET_JITSI_WEBHOOK_SHARED_SECRET", webhookSecret);
  }
  return { jwtSecret, webhookSecret };
}

function assertProductionSecret(name: string, value: string): void {
  if (value.length < 32 || value.includes("dev_secret") || value.includes("change_me")) {
    throw new Error(
      `${name} must be a non-default secret of at least 32 characters in production.`,
    );
  }
}
