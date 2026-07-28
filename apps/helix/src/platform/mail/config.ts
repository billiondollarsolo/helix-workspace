import type { Env } from "../../config/env.js";
import type { SecurityTier } from "@helix/sdk-types";
import type { OutboundMailConfig } from "./outbound.js";
import type { SpamdScannerOptions } from "./spam.js";
import type { ClamavScannerOptions } from "./antivirus.js";

export interface MailReceiverConfig {
  readonly orgId: string;
  readonly port: number;
  readonly host?: string;
}

export interface MailSignupFrom {
  readonly address: string;
  readonly name: string;
}

export interface MailConfig {
  readonly fromDomain: string;
  readonly defaultOrgId: string;
  readonly outbound: OutboundMailConfig | undefined;
  readonly receiver: MailReceiverConfig | undefined;
  readonly spamd: SpamdScannerOptions | undefined;
  readonly clamav: ClamavScannerOptions | undefined;
  readonly signupFrom: MailSignupFrom;
}

function envFlag(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined || value.trim().length === 0) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseFloatConfig(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Build outbound SMTP config from validated env (mirrors legacy getOutboundMailConfig). */
export function buildOutboundConfig(env: Env): OutboundMailConfig | undefined {
  const host = env.MAIL_SMTP_HOST ?? env.SES_SMTP_HOST;
  if (host === undefined || host.length === 0) {
    return undefined;
  }
  const portRaw = env.MAIL_SMTP_PORT ?? env.SES_SMTP_PORT;
  const secureRaw = env.MAIL_SMTP_SECURE ?? env.SES_SMTP_SECURE;
  const user = env.MAIL_SMTP_USER ?? env.SES_SMTP_USER;
  const pass = env.MAIL_SMTP_PASS ?? env.SES_SMTP_PASS;
  const port = parsePositiveInt(portRaw);
  return {
    host,
    ...(port === undefined ? {} : { port }),
    ...(secureRaw === undefined ? {} : { secure: envFlag(secureRaw, false) }),
    ...(user === undefined ? {} : { user }),
    ...(pass === undefined ? {} : { pass }),
  };
}

/** Build inbound SMTP receiver config from validated env. */
export function buildReceiverConfig(env: Env): MailReceiverConfig | undefined {
  if (!envFlag(env.MAIL_SMTP_RECEIVER_ENABLED ?? env.MAIL_RECEIVER_ENABLED)) {
    return undefined;
  }
  const host = env.MAIL_SMTP_RECEIVER_HOST;
  const port = parsePositiveInt(env.MAIL_SMTP_RECEIVER_PORT) ?? 2525;
  return {
    orgId: env.HELIX_DEFAULT_ORG_ID,
    port,
    ...(host === undefined || host.length === 0 ? {} : { host }),
  };
}

/** Build spamd scanner options from validated env. */
export function buildSpamdConfig(env: Env): SpamdScannerOptions | undefined {
  if (!envFlag(env.MAIL_SPAMD_ENABLED)) {
    return undefined;
  }
  const host = env.MAIL_SPAMD_HOST ?? "spamd";
  const port = parsePositiveInt(env.MAIL_SPAMD_PORT) ?? 783;
  const threshold = parseFloatConfig(env.MAIL_SPAMD_THRESHOLD) ?? 5.0;
  const timeoutMs = parsePositiveInt(env.MAIL_SPAMD_TIMEOUT_MS);
  return {
    host,
    port,
    threshold,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/** Build ClamAV scanner options from validated env. */
export function buildClamavConfig(
  env: Env,
  tier: SecurityTier = "personal",
): ClamavScannerOptions | undefined {
  if (!envFlag(env.MAIL_CLAMAV_ENABLED)) {
    return undefined;
  }
  const host = env.MAIL_CLAMAV_HOST ?? "clamav";
  const port = parsePositiveInt(env.MAIL_CLAMAV_PORT) ?? 3310;
  const timeoutMs = parsePositiveInt(env.MAIL_CLAMAV_TIMEOUT_MS);
  return {
    host,
    port,
    tier,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/**
 * Assemble the full mail config struct from a validated {@link Env}.
 * Zero raw `process.env` reads — call sites pass `env()` / `loadEnv(...)`.
 */
export function mailConfig(env: Env, securityTier: SecurityTier = "personal"): MailConfig {
  const fromDomain = env.MAIL_FROM_DOMAIN;
  return {
    fromDomain,
    defaultOrgId: env.HELIX_DEFAULT_ORG_ID,
    outbound: buildOutboundConfig(env),
    receiver: buildReceiverConfig(env),
    spamd: buildSpamdConfig(env),
    clamav: buildClamavConfig(env, securityTier),
    signupFrom: {
      address: env.HELIX_SIGNUP_EMAIL_FROM ?? `no-reply@${fromDomain}`,
      name: env.HELIX_SIGNUP_EMAIL_FROM_NAME,
    },
  };
}
