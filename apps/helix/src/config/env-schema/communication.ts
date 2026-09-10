import { coercePositiveInt, optionalString, optionalUrl } from "./common.js";
export const communicationEnv = {
  CHAT_PRESENCE_TTL_SECONDS: coercePositiveInt(60),
  CHAT_WS_RATE_LIMIT_CAPACITY: coercePositiveInt(30),
  CHAT_WS_RATE_LIMIT_REFILL_PER_SECOND: coercePositiveInt(3),
  JITSI_JWT_SECRET: optionalString,
  JITSI_WEBHOOK_SECRET: optionalString,
  MEET_JITSI_DOMAIN: optionalString,
  MEET_JITSI_ENABLED: optionalString,
  MEET_JITSI_PUBLIC_URL: optionalUrl,
  MEET_JITSI_JWT_SECRET: optionalString,
  MEET_JITSI_JWT_APP_ID: optionalString,
  MEET_JITSI_JWT_ISSUER: optionalString,
  MEET_JITSI_JWT_AUDIENCE: optionalString,
  MEET_JITSI_WEBHOOK_SHARED_SECRET: optionalString,
  MEET_JIBRI_HEALTH_URL: optionalUrl,
  MEET_JITSI_REGION: optionalString,
};
