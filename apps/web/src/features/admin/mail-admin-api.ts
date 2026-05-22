import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";

/**
 * Mail-delivery admin client.
 *
 * Talks to the mail backend's admin REST surface under `/api/admin/mail/`:
 *  - `/providers`        — outbound mail providers (list / create / patch / set-default)
 *  - `/sending-domains`  — sending domains + per-domain DKIM keys
 *  - `/dmarc`            — DMARC aggregate reports + deliverability summary
 *  - `/routing-rules`    — inbound routing rules (CRUD)
 *  - `/spam`             — spamd threshold + status (read view)
 *
 * Every backend response is validated at the trust boundary with Zod so a
 * malformed payload can never reach the React tree.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

// ---------------------------------------------------------------------------
// Outbound providers
// ---------------------------------------------------------------------------

export const MAIL_PROVIDER_KINDS = ["ses", "mailgun", "smtp", "postmark"] as const;
export type MailProviderKind = (typeof MAIL_PROVIDER_KINDS)[number];

export const mailProviderKindLabels: Record<MailProviderKind, string> = {
  ses: "Amazon SES",
  mailgun: "Mailgun",
  smtp: "SMTP relay",
  postmark: "Postmark",
};

const mailProviderConfigSchema = z.object({
  /** Env-ref pointer to the API key/secret (e.g. `env:MAIL_SES_KEY`). */
  apiKeyRef: z.string().nullish(),
  region: z.string().nullish(),
  domain: z.string().nullish(),
  host: z.string().nullish(),
  port: z.number().int().nullish(),
});

export type MailProviderConfig = z.infer<typeof mailProviderConfigSchema>;

const mailProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(MAIL_PROVIDER_KINDS),
  isDefault: z.boolean(),
  enabled: z.boolean(),
  config: mailProviderConfigSchema,
  createdAt: z.string().nullish(),
});

export type MailProvider = z.infer<typeof mailProviderSchema>;

const mailProvidersResponseSchema = z.object({
  providers: z.array(mailProviderSchema),
});

export type MailProvidersResponse = z.infer<typeof mailProvidersResponseSchema>;

export interface CreateMailProviderInput {
  readonly name: string;
  readonly kind: MailProviderKind;
  readonly config: MailProviderConfig;
}

export interface PatchMailProviderInput {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly config?: MailProviderConfig;
}

// ---------------------------------------------------------------------------
// Sending domains + DKIM
// ---------------------------------------------------------------------------

export const VERIFICATION_STATES = ["verified", "pending", "failed"] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const DKIM_KEY_STATES = ["active", "retiring", "retired"] as const;
export type DkimKeyState = (typeof DKIM_KEY_STATES)[number];

const dkimKeySchema = z.object({
  id: z.string(),
  selector: z.string(),
  status: z.enum(DKIM_KEY_STATES),
  createdAt: z.string().nullish(),
});

export type DkimKey = z.infer<typeof dkimKeySchema>;

const sendingDomainSchema = z.object({
  id: z.string(),
  domain: z.string(),
  spf: z.enum(VERIFICATION_STATES),
  dkim: z.enum(VERIFICATION_STATES),
  dmarc: z.enum(VERIFICATION_STATES),
  dkimKeys: z.array(dkimKeySchema),
});

export type SendingDomain = z.infer<typeof sendingDomainSchema>;

const sendingDomainsResponseSchema = z.object({
  domains: z.array(sendingDomainSchema),
});

export type SendingDomainsResponse = z.infer<typeof sendingDomainsResponseSchema>;

// ---------------------------------------------------------------------------
// DMARC / deliverability
// ---------------------------------------------------------------------------

const dmarcReportSchema = z.object({
  id: z.string(),
  reporter: z.string(),
  domain: z.string(),
  rangeStart: z.string(),
  rangeEnd: z.string(),
  total: z.number().int(),
  passCount: z.number().int(),
  failCount: z.number().int(),
});

export type DmarcReport = z.infer<typeof dmarcReportSchema>;

const deliverabilitySchema = z.object({
  /** 0-1 pass fraction across the reporting window. */
  dmarcPassRate: z.number(),
  spfPassRate: z.number(),
  dkimPassRate: z.number(),
  messagesEvaluated: z.number().int(),
  windowDays: z.number().int(),
});

export type Deliverability = z.infer<typeof deliverabilitySchema>;

const dmarcResponseSchema = z.object({
  summary: deliverabilitySchema,
  reports: z.array(dmarcReportSchema),
});

export type DmarcResponse = z.infer<typeof dmarcResponseSchema>;

// ---------------------------------------------------------------------------
// Inbound routing rules
// ---------------------------------------------------------------------------

export const ROUTING_ACTIONS = ["forward", "mailbox", "drop", "webhook"] as const;
export type RoutingAction = (typeof ROUTING_ACTIONS)[number];

export const routingActionLabels: Record<RoutingAction, string> = {
  forward: "Forward",
  mailbox: "Deliver to mailbox",
  drop: "Drop",
  webhook: "Webhook",
};

const routingRuleSchema = z.object({
  id: z.string(),
  matchPattern: z.string(),
  action: z.enum(ROUTING_ACTIONS),
  destination: z.string(),
  enabled: z.boolean(),
  priority: z.number().int(),
});

export type RoutingRule = z.infer<typeof routingRuleSchema>;

const routingRulesResponseSchema = z.object({
  rules: z.array(routingRuleSchema),
});

export type RoutingRulesResponse = z.infer<typeof routingRulesResponseSchema>;

export interface RoutingRuleInput {
  readonly matchPattern: string;
  readonly action: RoutingAction;
  readonly destination: string;
  readonly enabled: boolean;
  readonly priority: number;
}

// ---------------------------------------------------------------------------
// Spam filtering (read view)
// ---------------------------------------------------------------------------

const spamSettingsResponseSchema = z.object({
  enabled: z.boolean(),
  /** spamd score above which a message is treated as spam. */
  threshold: z.number(),
  /** spamd score above which a message is rejected outright. */
  rejectThreshold: z.number().nullish(),
  daemonStatus: z.enum(["running", "stopped", "unknown"]),
  rulesetVersion: z.string().nullish(),
  taggedLast24h: z.number().int().nullish(),
});

export type SpamSettingsResponse = z.infer<typeof spamSettingsResponseSchema>;

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const mailAdminQueryKeys = {
  providers: () => ["admin", "mail", "providers"] as const,
  sendingDomains: () => ["admin", "mail", "sending-domains"] as const,
  dmarc: () => ["admin", "mail", "dmarc"] as const,
  routingRules: () => ["admin", "mail", "routing-rules"] as const,
  spam: () => ["admin", "mail", "spam"] as const,
};

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

export function mailProvidersQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: mailAdminQueryKeys.providers(),
    queryFn: () => fetchMailProviders(fetchImpl),
    retry: false,
    throwOnError: false,
  });
}

export function sendingDomainsQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: mailAdminQueryKeys.sendingDomains(),
    queryFn: () => fetchSendingDomains(fetchImpl),
    retry: false,
    throwOnError: false,
  });
}

export function mailDmarcQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: mailAdminQueryKeys.dmarc(),
    queryFn: () => fetchMailDmarc(fetchImpl),
    retry: false,
    throwOnError: false,
  });
}

export function routingRulesQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: mailAdminQueryKeys.routingRules(),
    queryFn: () => fetchRoutingRules(fetchImpl),
    retry: false,
    throwOnError: false,
  });
}

export function spamSettingsQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: mailAdminQueryKeys.spam(),
    queryFn: () => fetchSpamSettings(fetchImpl),
    retry: false,
    throwOnError: false,
  });
}

// ---------------------------------------------------------------------------
// Providers — fetchers + mutations
// ---------------------------------------------------------------------------

export async function fetchMailProviders(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<MailProvidersResponse> {
  const response = await fetchImpl("/api/admin/mail/providers", { method: "GET" });
  return parseResponse(response, "load mail providers", mailProvidersResponseSchema);
}

export async function createMailProvider(
  input: CreateMailProviderInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<MailProvider> {
  const response = await fetchImpl("/api/admin/mail/providers", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return parseResponse(response, "create mail provider", mailProviderSchema);
}

export async function patchMailProvider(
  id: string,
  input: PatchMailProviderInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<MailProvider> {
  const response = await fetchImpl(`/api/admin/mail/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return parseResponse(response, "update mail provider", mailProviderSchema);
}

export async function setDefaultMailProvider(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<MailProvidersResponse> {
  const response = await fetchImpl(
    `/api/admin/mail/providers/${encodeURIComponent(id)}/set-default`,
    { method: "POST", headers: jsonHeaders },
  );
  return parseResponse(response, "set default mail provider", mailProvidersResponseSchema);
}

// ---------------------------------------------------------------------------
// Sending domains — fetchers + mutations
// ---------------------------------------------------------------------------

export async function fetchSendingDomains(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<SendingDomainsResponse> {
  const response = await fetchImpl("/api/admin/mail/sending-domains", { method: "GET" });
  return parseResponse(response, "load sending domains", sendingDomainsResponseSchema);
}

export async function createSendingDomain(
  domain: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<SendingDomain> {
  const response = await fetchImpl("/api/admin/mail/sending-domains", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ domain }),
  });
  return parseResponse(response, "add sending domain", sendingDomainSchema);
}

export async function deleteSendingDomain(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl(
    `/api/admin/mail/sending-domains/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  await ensureOk(response, "delete sending domain");
}

export async function generateDkimKey(
  domainId: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<SendingDomain> {
  const response = await fetchImpl(
    `/api/admin/mail/sending-domains/${encodeURIComponent(domainId)}/dkim`,
    { method: "POST", headers: jsonHeaders },
  );
  return parseResponse(response, "generate DKIM key", sendingDomainSchema);
}

export async function rotateDkimKey(
  domainId: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<SendingDomain> {
  const response = await fetchImpl(
    `/api/admin/mail/sending-domains/${encodeURIComponent(domainId)}/dkim/rotate`,
    { method: "POST", headers: jsonHeaders },
  );
  return parseResponse(response, "rotate DKIM key", sendingDomainSchema);
}

// ---------------------------------------------------------------------------
// DMARC / deliverability — fetcher
// ---------------------------------------------------------------------------

export async function fetchMailDmarc(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DmarcResponse> {
  const response = await fetchImpl("/api/admin/mail/dmarc", { method: "GET" });
  return parseResponse(response, "load DMARC reports", dmarcResponseSchema);
}

// ---------------------------------------------------------------------------
// Routing rules — fetchers + mutations
// ---------------------------------------------------------------------------

export async function fetchRoutingRules(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<RoutingRulesResponse> {
  const response = await fetchImpl("/api/admin/mail/routing-rules", { method: "GET" });
  return parseResponse(response, "load routing rules", routingRulesResponseSchema);
}

export async function createRoutingRule(
  input: RoutingRuleInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<RoutingRule> {
  const response = await fetchImpl("/api/admin/mail/routing-rules", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return parseResponse(response, "create routing rule", routingRuleSchema);
}

export async function patchRoutingRule(
  id: string,
  input: Partial<RoutingRuleInput>,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<RoutingRule> {
  const response = await fetchImpl(
    `/api/admin/mail/routing-rules/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify(input),
    },
  );
  return parseResponse(response, "update routing rule", routingRuleSchema);
}

export async function deleteRoutingRule(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl(
    `/api/admin/mail/routing-rules/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  await ensureOk(response, "delete routing rule");
}

// ---------------------------------------------------------------------------
// Spam settings — fetcher
// ---------------------------------------------------------------------------

export async function fetchSpamSettings(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<SpamSettingsResponse> {
  const response = await fetchImpl("/api/admin/mail/spam", { method: "GET" });
  return parseResponse(response, "load spam settings", spamSettingsResponseSchema);
}

// ---------------------------------------------------------------------------
// Shared response handling
// ---------------------------------------------------------------------------

async function parseResponse<T>(
  response: Response,
  action: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessage(payload) ?? `Failed to ${action} (${String(response.status)}).`);
  }
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(`Failed to ${action}: malformed response.`);
}

async function ensureOk(response: Response, action: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const payload: unknown = await response.json().catch(() => ({}));
  throw new Error(errorMessage(payload) ?? `Failed to ${action} (${String(response.status)}).`);
}

function errorMessage(payload: unknown): string | undefined {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return undefined;
}
