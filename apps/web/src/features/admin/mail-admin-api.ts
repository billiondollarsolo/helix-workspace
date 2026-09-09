import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";

/**
 * Mail-delivery admin client.
 *
 * Talks to the mail backend's admin REST surface under `/api/admin/mail/`:
 *  - `/providers`        — outbound mail providers (list / create / patch / set-default)
 *  - `/domains`          — canonical mail-enabled domains + DKIM keys
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
// Canonical mail domains + DKIM
// ---------------------------------------------------------------------------

export const DKIM_KEY_STATES = ["active", "retiring", "retired"] as const;
export type DkimKeyState = (typeof DKIM_KEY_STATES)[number];

const dkimKeySchema = z.object({
  id: z.string(),
  selector: z.string(),
  status: z.enum(DKIM_KEY_STATES),
  createdAt: z.string().nullish(),
});

export type DkimKey = z.infer<typeof dkimKeySchema>;

const mailDomainSchema = z.object({
  id: z.string(),
  domain: z.string(),
  status: z.enum(["pending", "verified", "quarantined", "released"]),
  isPrimary: z.boolean(),
  mailEnabled: z.boolean(),
  providerId: z.string().nullable(),
  dkimKeys: z.array(dkimKeySchema),
});

export type MailDomain = z.infer<typeof mailDomainSchema>;

const mailDomainsResponseSchema = z.object({
  domains: z.array(mailDomainSchema),
});

export type MailDomainsResponse = z.infer<typeof mailDomainsResponseSchema>;

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

export const ROUTING_ACTIONS = ["forward", "alias", "tag", "mailbox", "drop"] as const;
export type RoutingAction = (typeof ROUTING_ACTIONS)[number];

export const routingActionLabels: Record<RoutingAction, string> = {
  forward: "Forward",
  alias: "Deliver to user",
  tag: "Apply tag",
  mailbox: "Deliver to mailbox",
  drop: "Drop",
};

const routingMatchSchema = z.object({
  recipientPattern: z.string().optional(),
  senderPattern: z.string().optional(),
  subjectContains: z.string().optional(),
  headerName: z.string().optional(),
  headerContains: z.string().optional(),
});

const routingActionSchema = z.object({
  forwardTo: z.string().optional(),
  aliasActorId: z.string().optional(),
  tag: z.string().optional(),
  mailbox: z.string().optional(),
  stopProcessing: z.boolean().optional(),
});

const routingRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  isEnabled: z.boolean(),
  priority: z.number().int(),
  match: routingMatchSchema,
  actionKind: z.enum(ROUTING_ACTIONS),
  action: routingActionSchema,
});

export type RoutingRule = z.infer<typeof routingRuleSchema>;

const routingRulesResponseSchema = z.object({
  rules: z.array(routingRuleSchema),
});

export type RoutingRulesResponse = z.infer<typeof routingRulesResponseSchema>;

export interface RoutingRuleInput {
  readonly name: string;
  readonly recipientPattern?: string;
  readonly senderPattern?: string;
  readonly subjectContains?: string;
  readonly headerName?: string;
  readonly headerContains?: string;
  readonly actionKind: RoutingAction;
  readonly destination?: string;
  readonly stopProcessing?: boolean;
  readonly isEnabled: boolean;
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

const deadLettersSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      actorId: z.string(),
      messageId: z.string(),
      attemptCount: z.number().int(),
      lastError: z.string().nullable(),
      deadLetteredAt: z.string().nullable(),
    }),
  ),
});
const deliveryEventsSchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      outboundId: z.string(),
      kind: z.enum(["accepted", "delivered", "deferred", "bounced", "complained"]),
      recipient: z.string(),
      diagnostic: z.string().nullable(),
      occurredAt: z.string(),
    }),
  ),
});
const suppressionsSchema = z.object({
  suppressions: z.array(
    z.object({
      id: z.string(),
      address: z.string(),
      reason: z.enum(["hard_bounce", "complaint", "manual"]),
      createdAt: z.string(),
    }),
  ),
});
const mailJournalSchema = z.object({
  journal: z.object({
    enabled: z.boolean(),
    retentionDays: z.number().int(),
    entryCount: z.number().int(),
    lastJournaledAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  }),
});

export interface MailOperations {
  readonly deadLetters: z.infer<typeof deadLettersSchema>["messages"];
  readonly events: z.infer<typeof deliveryEventsSchema>["events"];
  readonly suppressions: z.infer<typeof suppressionsSchema>["suppressions"];
  readonly journal: z.infer<typeof mailJournalSchema>["journal"];
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const mailAdminQueryKeys = {
  providers: () => ["admin", "mail", "providers"] as const,
  domains: () => ["admin", "mail", "domains"] as const,
  dmarc: () => ["admin", "mail", "dmarc"] as const,
  routingRules: () => ["admin", "mail", "routing-rules"] as const,
  spam: () => ["admin", "mail", "spam"] as const,
  operations: () => ["admin", "mail", "operations"] as const,
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

export function mailDomainsQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: mailAdminQueryKeys.domains(),
    queryFn: () => fetchMailDomains(fetchImpl),
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

export function mailOperationsQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: mailAdminQueryKeys.operations(),
    queryFn: () => fetchMailOperations(fetchImpl),
    retry: false,
    throwOnError: false,
  });
}

export async function fetchMailOperations(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<MailOperations> {
  const [deadLetters, events, suppressions, journal] = await Promise.all([
    fetchImpl("/api/admin/mail/outbound/dead-letters", { method: "GET" }),
    fetchImpl("/api/admin/mail/outbound/delivery-events", { method: "GET" }),
    fetchImpl("/api/admin/mail/outbound/suppressions", { method: "GET" }),
    fetchImpl("/api/admin/mail/journal", { method: "GET" }),
  ]);
  return {
    deadLetters: (await parseResponse(deadLetters, "load dead letters", deadLettersSchema))
      .messages,
    events: (await parseResponse(events, "load delivery events", deliveryEventsSchema)).events,
    suppressions: (await parseResponse(suppressions, "load suppressions", suppressionsSchema))
      .suppressions,
    journal: (await parseResponse(journal, "load compliance journal", mailJournalSchema)).journal,
  };
}

export async function saveMailJournalSettings(
  input: { readonly enabled: boolean; readonly retentionDays: number },
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<MailOperations["journal"]> {
  const response = await fetchImpl("/api/admin/mail/journal", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (await parseResponse(response, "save compliance journal", mailJournalSchema)).journal;
}

export async function replayDeadLetter(
  id: string,
  reason: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl(`/api/admin/mail/outbound/${encodeURIComponent(id)}/replay`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
  });
  await ensureOk(response, "replay dead letter");
}

export async function removeMailSuppression(
  id: string,
  reason: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl(
    `/api/admin/mail/outbound/suppressions/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: jsonHeaders, body: JSON.stringify({ reason }) },
  );
  await ensureOk(response, "remove suppression");
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
// Canonical mail domains — fetchers + mutations
// ---------------------------------------------------------------------------

export async function fetchMailDomains(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<MailDomainsResponse> {
  const response = await fetchImpl("/api/admin/mail/domains", { method: "GET" });
  return parseResponse(response, "load mail domains", mailDomainsResponseSchema);
}

export async function disableMailDomain(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl(`/api/admin/mail/domains/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await ensureOk(response, "disable mail domain");
}

export async function generateDkimKey(
  domainId: string,
  selector: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DkimKey> {
  const response = await fetchImpl(`/api/admin/mail/domains/${encodeURIComponent(domainId)}/dkim`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ selector, keyBits: 2048 }),
  });
  return (await parseResponse(response, "generate DKIM key", z.object({ key: dkimKeySchema }))).key;
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
    body: JSON.stringify(routingRuleRequest(input)),
  });
  return (
    await parseResponse(response, "create routing rule", z.object({ rule: routingRuleSchema }))
  ).rule;
}

export async function patchRoutingRule(
  id: string,
  input: { readonly isEnabled: boolean },
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<RoutingRule> {
  const response = await fetchImpl(`/api/admin/mail/routing-rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (
    await parseResponse(response, "update routing rule", z.object({ rule: routingRuleSchema }))
  ).rule;
}

export async function deleteRoutingRule(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl(`/api/admin/mail/routing-rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await ensureOk(response, "delete routing rule");
}

function routingRuleRequest(input: RoutingRuleInput) {
  const destination = input.destination?.trim();
  const stopProcessing = input.stopProcessing === true ? { stopProcessing: true } : {};
  return {
    name: input.name,
    isEnabled: input.isEnabled,
    priority: input.priority,
    match: {
      ...(input.recipientPattern === undefined ? {} : { recipientPattern: input.recipientPattern }),
      ...(input.senderPattern === undefined ? {} : { senderPattern: input.senderPattern }),
      ...(input.subjectContains === undefined ? {} : { subjectContains: input.subjectContains }),
      ...(input.headerName === undefined ? {} : { headerName: input.headerName }),
      ...(input.headerContains === undefined ? {} : { headerContains: input.headerContains }),
    },
    actionKind: input.actionKind,
    action:
      input.actionKind === "forward"
        ? { forwardTo: destination, ...stopProcessing }
        : input.actionKind === "alias"
          ? { aliasActorId: destination, ...stopProcessing }
          : input.actionKind === "tag"
            ? { tag: destination, ...stopProcessing }
            : input.actionKind === "mailbox"
              ? { mailbox: destination, ...stopProcessing }
              : stopProcessing,
  };
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
