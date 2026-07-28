import type { Env } from "../../config/env.js";
import type { SecurityTier } from "@helix/sdk-types";
import type { OutboundMailConfig } from "./outbound.js";
import type { SpamdScannerOptions } from "./spam.js";
import type { ClamavScannerOptions } from "./antivirus.js";
import type { SmtpReceiverLimits } from "./ingest.js";
import type { SmtpTransportSecurity } from "./smtp-transport-security.js";

export interface MailReceiverConfig {
  readonly port: number;
  readonly host?: string;
  readonly transportSecurity: SmtpTransportSecurity;
  readonly limits: Partial<SmtpReceiverLimits>;
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
  const transportSecurity = buildReceiverTransportSecurity(env);
  return {
    port,
    ...(host === undefined || host.length === 0 ? {} : { host }),
    transportSecurity,
    limits: compactReceiverLimits({
      maxMessageBytes: parsePositiveInt(env.MAIL_SMTP_RECEIVER_MAX_MESSAGE_BYTES),
      maxRecipientsPerMessage: parsePositiveInt(env.MAIL_SMTP_RECEIVER_MAX_RECIPIENTS),
      maxMessagesPerConnection: parsePositiveInt(
        env.MAIL_SMTP_RECEIVER_MAX_MESSAGES_PER_CONNECTION,
      ),
      maxCommandsPerConnection: parsePositiveInt(
        env.MAIL_SMTP_RECEIVER_MAX_COMMANDS_PER_CONNECTION,
      ),
      maxConcurrentConnections: parsePositiveInt(env.MAIL_SMTP_RECEIVER_MAX_CONCURRENT_CONNECTIONS),
      maxConcurrentConnectionsPerIp: parsePositiveInt(
        env.MAIL_SMTP_RECEIVER_MAX_CONNECTIONS_PER_IP,
      ),
      connectionsPerWindow: parsePositiveInt(env.MAIL_SMTP_RECEIVER_CONNECTIONS_PER_WINDOW),
      connectionWindowMs: parsePositiveInt(env.MAIL_SMTP_RECEIVER_CONNECTION_WINDOW_MS),
      messagesPerWindow: parsePositiveInt(env.MAIL_SMTP_RECEIVER_MESSAGES_PER_WINDOW),
      messageWindowMs: parsePositiveInt(env.MAIL_SMTP_RECEIVER_MESSAGE_WINDOW_MS),
      recipientResolutionTimeoutMs: parsePositiveInt(env.MAIL_SMTP_RECEIVER_RECIPIENT_TIMEOUT_MS),
      socketTimeoutMs: parsePositiveInt(env.MAIL_SMTP_RECEIVER_SOCKET_TIMEOUT_MS),
    }),
  };
}

function buildReceiverTransportSecurity(env: Env): SmtpTransportSecurity {
  const configuredMode = env.MAIL_SMTP_RECEIVER_TRANSPORT_SECURITY;
  const mode =
    configuredMode ??
    (env.NODE_ENV === "production" ? undefined : ("development-plaintext" as const));
  if (mode === undefined) {
    throw new Error(
      "MAIL_SMTP_RECEIVER_TRANSPORT_SECURITY must select starttls or trusted-proxy in production.",
    );
  }
  switch (mode) {
    case "starttls": {
      const key = env.MAIL_SMTP_RECEIVER_TLS_KEY;
      const cert = env.MAIL_SMTP_RECEIVER_TLS_CERT;
      if (key === undefined || cert === undefined) {
        throw new Error(
          "STARTTLS requires MAIL_SMTP_RECEIVER_TLS_KEY and MAIL_SMTP_RECEIVER_TLS_CERT.",
        );
      }
      return {
        mode,
        key,
        cert,
        ...(env.MAIL_SMTP_RECEIVER_TLS_CA === undefined
          ? {}
          : { ca: env.MAIL_SMTP_RECEIVER_TLS_CA }),
      };
    }
    case "trusted-proxy":
      if (!envFlag(env.MAIL_SMTP_RECEIVER_PROXY_PROTOCOL)) {
        throw new Error("Trusted SMTP proxy mode requires PROXY protocol.");
      }
      return { mode, proxyProtocol: true };
    case "development-plaintext":
      if (env.NODE_ENV === "production") {
        throw new Error("Plaintext SMTP receipt is forbidden in production.");
      }
      return { mode };
  }
}

function compactReceiverLimits(input: {
  readonly [K in keyof SmtpReceiverLimits]: number | undefined;
}): Partial<SmtpReceiverLimits> {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [keyof SmtpReceiverLimits, number] => entry[1] !== undefined,
    ),
  );
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
