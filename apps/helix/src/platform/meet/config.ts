import type { Env } from "../../config/env.js";

export const DEVELOPMENT_MEET_JWT_SECRET = "helix_jitsi_dev_secret_for_local_only";
export const DEVELOPMENT_MEET_WEBHOOK_SECRET = "helix_dev_jitsi_webhook_secret_change_me";

export function meetSecrets(env: Env): {
  readonly jwtSecret: string;
  readonly webhookSecret: string;
} {
  const jwtSecret = env.MEET_JITSI_JWT_SECRET ?? DEVELOPMENT_MEET_JWT_SECRET;
  const webhookSecret = env.MEET_JITSI_WEBHOOK_SHARED_SECRET ?? DEVELOPMENT_MEET_WEBHOOK_SECRET;
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
