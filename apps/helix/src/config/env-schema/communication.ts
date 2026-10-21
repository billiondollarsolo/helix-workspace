import { coercePositiveInt, optionalString, optionalUrl } from "./common.js";
export const communicationEnv = {
  CHAT_PRESENCE_TTL_SECONDS: coercePositiveInt(60),
  CHAT_WS_RATE_LIMIT_CAPACITY: coercePositiveInt(30),
  CHAT_WS_RATE_LIMIT_REFILL_PER_SECOND: coercePositiveInt(3),
  // Meet media runs on LiveKit (see platform/meet/livekit.ts).
  LIVEKIT_API_KEY: optionalString,
  LIVEKIT_API_SECRET: optionalString,
  /** Browser websocket origin; defaults to wss://<Workspace public host> (Caddy routes /rtc). */
  LIVEKIT_PUBLIC_URL: optionalUrl,
  /** Server API on the private network. */
  LIVEKIT_INTERNAL_URL: optionalUrl,
  /** Bearer secret for internal capture services (live transcription audio, recordings). */
  MEET_CAPTURE_SECRET: optionalString,
  /** Region where the LiveKit media server runs, for residency checks. */
  MEET_MEDIA_REGION: optionalString,
  /** TURN hostname LiveKit serves (DNS-only, never proxied). */
  HELIX_MEET_TURN_DOMAIN: optionalString,
  MEET_TRANSCRIPTION_ALLOWED_HOSTS: optionalString,
  MEET_TRANSCRIPTION_PROXY_URL: optionalUrl,
  HELIX_PASSWORDS_URL: optionalUrl,
};
