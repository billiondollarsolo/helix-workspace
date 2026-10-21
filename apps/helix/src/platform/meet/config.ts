import { createHmac } from "node:crypto";
import type { Env } from "../../config/env.js";
import type { LiveKitOptions } from "./livekit.js";

const REQUIRED_MEET_SETTINGS = [
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "MEET_CAPTURE_SECRET",
] as const;

/** The settings Meet still needs; empty when Meet is configured. */
export function missingMeetSecrets(env: Env): readonly string[] {
  return REQUIRED_MEET_SETTINGS.filter((name) => (env[name] ?? "") === "");
}

export interface MeetMediaConfig {
  readonly liveKit: LiveKitOptions;
  /** Bearer secret for internal capture services (live transcription, recordings). */
  readonly captureSecret: string;
  /** Signs guest invitations; derived from the capture secret so operators set one less secret. */
  readonly guestInviteSecret: string;
}

/**
 * Meet's media configuration, or null when it is not configured. Meet then stays
 * unavailable in every environment: there is no built-in development secret, so
 * local and test setups configure their own (see `.env.example`).
 */
export function meetSecrets(env: Env): MeetMediaConfig | null {
  const apiKey = env.LIVEKIT_API_KEY ?? "";
  const apiSecret = env.LIVEKIT_API_SECRET ?? "";
  const captureSecret = env.MEET_CAPTURE_SECRET ?? "";
  if (apiKey === "" || apiSecret === "" || captureSecret === "") return null;
  if (env.NODE_ENV === "production") {
    assertProductionSecret("LIVEKIT_API_SECRET", apiSecret);
    assertProductionSecret("MEET_CAPTURE_SECRET", captureSecret);
  }
  return {
    liveKit: {
      apiKey,
      apiSecret,
      publicUrl: env.LIVEKIT_PUBLIC_URL ?? defaultPublicUrl(env),
      internalUrl: env.LIVEKIT_INTERNAL_URL ?? "http://livekit:7880",
    },
    captureSecret,
    guestInviteSecret: createHmac("sha256", captureSecret)
      .update("helix-meet-guest-invite")
      .digest("base64url"),
  };
}

/** Same host as Workspace: Caddy routes /rtc to LiveKit. */
function defaultPublicUrl(env: Env): string {
  const base = new URL(
    env.HELIX_PUBLIC_URL ?? env.PUBLIC_BASE_URL ?? env.BETTER_AUTH_URL ?? "http://localhost:3000",
  );
  return `${base.protocol === "http:" ? "ws:" : "wss:"}//${base.host}`;
}

function assertProductionSecret(name: string, value: string): void {
  if (value.length < 32 || value.includes("dev_secret") || value.includes("change_me")) {
    throw new Error(
      `${name} must be a non-default secret of at least 32 characters in production.`,
    );
  }
}
