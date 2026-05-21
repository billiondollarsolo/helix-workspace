import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { MailOutboundStatus } from "./types.js";

const adminConfigReadScope = "admin.config.read";
const adminConfigWriteScope = "admin.config.write";
const mailAdminScope = "mail.admin";

export type MailAdminReadinessStatus = "ready" | "configured" | "missing" | "unknown";
export type MailDnsRecordType = "MX" | "SPF" | "DKIM" | "DMARC";

export interface MailAdminDnsRecord {
  readonly type: MailDnsRecordType;
  readonly status: MailAdminReadinessStatus;
  readonly expected?: string | undefined;
  readonly evidence: string;
}

export interface MailAdminDomainStatus {
  readonly domain: string;
  readonly defaultFrom: boolean;
  readonly records: readonly MailAdminDnsRecord[];
}

export interface MailOutboundDeliveryHealth {
  readonly since: string;
  readonly counts: Readonly<Record<MailOutboundStatus, number>>;
  readonly failedLast24h: number;
  readonly lastFailureAt: string | null;
  readonly lastError: string | null;
}

export interface MailAdminStatus {
  readonly generatedAt: string;
  readonly inboundReceiver: {
    readonly enabled: boolean;
    readonly status: MailAdminReadinessStatus;
    readonly host: string | null;
    readonly port: number | null;
    readonly orgId: string | null;
    readonly evidence: string;
  };
  readonly outboundRelay: {
    readonly configured: boolean;
    readonly status: MailAdminReadinessStatus;
    readonly provider: "smtp" | "ses" | "none";
    readonly host: string | null;
    readonly port: number | null;
    readonly secure: boolean | null;
    readonly authConfigured: boolean;
    readonly evidence: string;
  };
  readonly domains: readonly MailAdminDomainStatus[];
  readonly quotas: {
    readonly perActorPerHour: number;
    readonly perActorPerDay: number;
    readonly maxMessageBytes: number | null;
    readonly evidence: string;
  };
  readonly deliveryHealth: MailOutboundDeliveryHealth;
}

export interface MailAdminDeliveryHealthStore {
  getOutboundDeliveryHealth(input: {
    readonly orgId: string;
    readonly since: Date;
  }): Promise<MailOutboundDeliveryHealth>;
}

export interface MailAdminStatusServiceOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly deliveryHealthStore?: MailAdminDeliveryHealthStore | undefined;
  readonly now?: (() => Date) | undefined;
}

export class MailAdminStatusService {
  readonly #env: NodeJS.ProcessEnv;
  readonly #deliveryHealthStore: MailAdminDeliveryHealthStore | undefined;
  readonly #now: () => Date;

  constructor(options: MailAdminStatusServiceOptions) {
    this.#env = options.env;
    this.#deliveryHealthStore = options.deliveryHealthStore;
    this.#now = options.now ?? (() => new Date());
  }

  async getStatus(actor: Actor): Promise<MailAdminStatus> {
    const generatedAt = this.#now();
    const since = new Date(generatedAt.getTime() - 24 * 60 * 60 * 1000);
    return {
      generatedAt: generatedAt.toISOString(),
      inboundReceiver: inboundReceiverStatus(this.#env),
      outboundRelay: outboundRelayStatus(this.#env),
      domains: domainStatuses(this.#env),
      quotas: quotasStatus(this.#env),
      deliveryHealth:
        this.#deliveryHealthStore === undefined
          ? emptyDeliveryHealth(since, "Delivery health store unavailable.")
          : await this.#deliveryHealthStore.getOutboundDeliveryHealth({
              orgId: actor.orgId,
              since,
            }),
    };
  }
}

export interface RegisterMailAdminRoutesOptions {
  readonly service: MailAdminStatusService;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
}

export async function registerMailAdminRoutes(
  app: FastifyInstance,
  options: RegisterMailAdminRoutesOptions,
): Promise<void> {
  app.get("/api/admin/mail/config", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadMailAdminStatus(actor)) {
      return reply.code(403).send({
        error: "Missing required scope.",
        requiredScope: `${adminConfigReadScope} or ${mailAdminScope}`,
      });
    }
    return options.service.getStatus(actor);
  });
}

export function canReadMailAdminStatus(actor: Actor): boolean {
  const scopes = actor.scopes ?? [];
  return (
    scopes.includes(adminConfigReadScope) ||
    scopes.includes(adminConfigWriteScope) ||
    scopes.includes(mailAdminScope) ||
    scopes.includes("admin.*")
  );
}

function inboundReceiverStatus(env: NodeJS.ProcessEnv): MailAdminStatus["inboundReceiver"] {
  const enabled = envValueFlag(env.MAIL_SMTP_RECEIVER_ENABLED ?? "", false);
  if (!enabled) {
    return {
      enabled: false,
      status: "missing",
      host: null,
      port: null,
      orgId: null,
      evidence: "MAIL_SMTP_RECEIVER_ENABLED is not enabled.",
    };
  }
  const host = env.MAIL_SMTP_RECEIVER_HOST ?? null;
  const port = parseInteger(env.MAIL_SMTP_RECEIVER_PORT ?? "2525");
  return {
    enabled: true,
    status: port === null ? "missing" : "ready",
    host,
    port,
    orgId: env.HELIX_DEFAULT_ORG_ID ?? "00000000-0000-0000-0000-000000000000",
    evidence: `SMTP receiver enabled on ${host ?? "default interface"}:${String(port ?? "invalid")}.`,
  };
}

function outboundRelayStatus(env: NodeJS.ProcessEnv): MailAdminStatus["outboundRelay"] {
  const host = env.MAIL_SMTP_HOST ?? env.SES_SMTP_HOST;
  if (host === undefined || host.length === 0) {
    return {
      configured: false,
      status: "missing",
      provider: "none",
      host: null,
      port: null,
      secure: null,
      authConfigured: false,
      evidence: "MAIL_SMTP_HOST or SES_SMTP_HOST is required for outbound mail.",
    };
  }
  const port = parseInteger(env.MAIL_SMTP_PORT ?? env.SES_SMTP_PORT);
  const secureEnv = env.MAIL_SMTP_SECURE ?? env.SES_SMTP_SECURE;
  const user = env.MAIL_SMTP_USER ?? env.SES_SMTP_USER;
  const pass = env.MAIL_SMTP_PASS ?? env.SES_SMTP_PASS;
  return {
    configured: true,
    status: "ready",
    provider: env.SES_SMTP_HOST !== undefined && env.MAIL_SMTP_HOST === undefined ? "ses" : "smtp",
    host,
    port,
    secure: secureEnv === undefined ? null : envValueFlag(secureEnv, false),
    authConfigured: user !== undefined && user.length > 0 && pass !== undefined && pass.length > 0,
    evidence: "Outbound SMTP relay host is configured; credentials are not exposed.",
  };
}

function domainStatuses(env: NodeJS.ProcessEnv): readonly MailAdminDomainStatus[] {
  const defaultDomain = stringOrUndefined(env.MAIL_FROM_DOMAIN);
  const domains = uniqueStrings([
    ...csv(env.HELIX_MAIL_DOMAINS ?? env.MAIL_DOMAINS),
    ...(defaultDomain === undefined ? [] : [defaultDomain]),
  ]);
  return domains.map((domain) => ({
    domain,
    defaultFrom: domain === defaultDomain,
    records: [
      dnsRecord("MX", env, domain, "MAIL_DNS_MX_VERIFIED", env.MAIL_DNS_MX_EXPECTED),
      dnsRecord("SPF", env, domain, "MAIL_DNS_SPF_VERIFIED", env.MAIL_SPF_RECORD),
      dnsRecord("DKIM", env, domain, "MAIL_DNS_DKIM_VERIFIED", dkimExpectedRecord(env, domain)),
      dnsRecord("DMARC", env, domain, "MAIL_DNS_DMARC_VERIFIED", env.MAIL_DMARC_POLICY),
    ],
  }));
}

function dnsRecord(
  type: MailDnsRecordType,
  env: NodeJS.ProcessEnv,
  domain: string,
  verifiedEnv: string,
  expected: string | undefined,
): MailAdminDnsRecord {
  const verified = envValueFlag(env[verifiedEnv] ?? "", false);
  if (verified) {
    return {
      type,
      status: "ready",
      ...(expected === undefined ? {} : { expected }),
      evidence: `${verifiedEnv}=true for ${domain}.`,
    };
  }
  if (expected !== undefined && expected.length > 0) {
    return {
      type,
      status: "configured",
      expected,
      evidence: `Expected ${type} record is configured but not marked verified.`,
    };
  }
  return {
    type,
    status: "unknown",
    evidence: `No ${type} verification evidence configured for ${domain}.`,
  };
}

function quotasStatus(env: NodeJS.ProcessEnv): MailAdminStatus["quotas"] {
  return {
    perActorPerHour: parseInteger(env.MAIL_SEND_RATE_LIMIT_PER_HOUR) ?? 60,
    perActorPerDay: parseInteger(env.MAIL_SEND_RATE_LIMIT_PER_DAY) ?? 200,
    maxMessageBytes: parseInteger(env.MAIL_MAX_MESSAGE_BYTES),
    evidence: "Defaults align with the mail.send tool rate limit unless env overrides are present.",
  };
}

export function emptyDeliveryHealth(since: Date, evidence: string): MailOutboundDeliveryHealth {
  return {
    since: since.toISOString(),
    counts: {
      queued: 0,
      sending: 0,
      sent: 0,
      failed: 0,
      cancelled: 0,
    },
    failedLast24h: 0,
    lastFailureAt: null,
    lastError: evidence,
  };
}

function dkimExpectedRecord(env: NodeJS.ProcessEnv, domain: string): string | undefined {
  const selector = stringOrUndefined(env.MAIL_DKIM_SELECTOR);
  if (selector === undefined) {
    return stringOrUndefined(env.MAIL_DKIM_RECORD);
  }
  return `${selector}._domainkey.${domain}`;
}

function envValueFlag(value: string, defaultValue: boolean): boolean {
  if (value.length === 0) {
    return defaultValue;
  }
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function parseInteger(value: string | undefined): number | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function csv(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function stringOrUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}
