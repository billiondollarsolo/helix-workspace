import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { ensureOk, parseResponse } from "@/features/admin/api-response";

// `parseResponse` used to be defined and exported here; it now lives in
// `api-response.ts`, but stays re-exported so existing importers keep working.
export { parseResponse };

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

/** Single-provider writes answer with the record wrapped in a `provider` key. */
const mailProviderEnvelopeSchema = z.object({
  provider: mailProviderSchema,
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

/** DKIM key writes answer with the key wrapped in a `key` envelope. */
const dkimKeyEnvelopeSchema = z.object({
  key: dkimKeySchema,
});

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

/**
 * The wire shape is deliberately looser than `deliverabilitySchema`.
 *
 * The backend stores DMARC aggregate reports at report granularity — total,
 * pass, fail as evaluated by DMARC alignment — so it can back the DMARC pass
 * rate but not the per-mechanism SPF/DKIM rates, which exist only in the
 * per-record rows. It also has nothing to say when no reports have arrived.
 * Rather than have the server invent numbers to satisfy this schema, an
 * incomplete summary is treated as no summary: the header cards are dropped, not
 * filled with rates nothing measured. If the backend later aggregates
 * record-level results, the fields simply arrive and the cards appear.
 */
const dmarcSummaryWireSchema = z.object({
  dmarcPassRate: z.number().nullish(),
  spfPassRate: z.number().nullish(),
  dkimPassRate: z.number().nullish(),
  messagesEvaluated: z.number().int().nullish(),
  windowDays: z.number().int().nullish(),
});

const dmarcResponseSchema = z.object({
  summary: dmarcSummaryWireSchema.nullish(),
  reports: z.array(dmarcReportSchema),
});

export interface DmarcResponse {
  /** `null` when the server could not state every rate the header reports. */
  readonly summary: Deliverability | null;
  readonly reports: readonly DmarcReport[];
}

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
  /** Present on current API; optional for older servers. */
  spamd: z
    .object({
      enabled: z.boolean(),
      host: z.string().nullable(),
      port: z.number().nullable(),
    })
    .optional(),
  aiBeta: z
    .object({
      enabled: z.boolean(),
      model: z.string(),
      baseUrl: z.string(),
      apiKeyConfigured: z.boolean(),
    })
    .optional(),
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
  const payload = await parseResponse(response, "create mail provider", mailProviderEnvelopeSchema);
  return payload.provider;
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
  const payload = await parseResponse(response, "update mail provider", mailProviderEnvelopeSchema);
  return payload.provider;
}

/**
 * Promote a provider to the org default.
 *
 * There is no `/set-default` endpoint — this used to POST to one, and every
 * click 404'd. Default is a field on the provider, and the patch route already
 * moves the flag (and demotes the incumbent) transactionally, so this is that
 * route with one field set rather than a second way to express the same write.
 */
export async function setDefaultMailProvider(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<MailProvider> {
  const response = await fetchImpl(`/api/admin/mail/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ isDefault: true }),
  });
  const payload = await parseResponse(
    response,
    "set default mail provider",
    mailProviderEnvelopeSchema,
  );
  return payload.provider;
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

/* Returns nothing on purpose. The create route answers `201 { domain }` with a
   raw store record — only the list route joins in spf/dkim/dmarc/dkimKeys — so
   parsing a `SendingDomain` out of it failed on every successful create and
   told the operator "Failed to add sending domain: malformed response." after
   the domain had in fact been added. The sole caller discards the value and
   invalidates the list, which is where the joined record lives. */
export async function createSendingDomain(
  domain: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl("/api/admin/mail/sending-domains", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ domain }),
  });
  await ensureOk(response, "add sending domain");
}

export async function deleteSendingDomain(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl(`/api/admin/mail/sending-domains/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await ensureOk(response, "delete sending domain");
}

/**
 * Issue this domain's first DKIM signing key.
 *
 * No `selector` is sent: it must be unique among the domain's selectors for as
 * long as any of them exists, so choosing one means reading the existing keys
 * first — from the browser a list-then-generate pair that races other admins and
 * spends two of the tenant's five requests per second. The server picks it, the
 * same way rotation does, and answers with the key alone.
 */
export async function generateDkimKey(
  domainId: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DkimKey> {
  const response = await fetchImpl(
    `/api/admin/mail/sending-domains/${encodeURIComponent(domainId)}/dkim`,
    // Fastify rejects an empty body under a JSON content-type, so send `{}`.
    { method: "POST", headers: jsonHeaders, body: JSON.stringify({}) },
  );
  const payload = await parseResponse(response, "generate DKIM key", dkimKeyEnvelopeSchema);
  return payload.key;
}

/**
 * Rotate this domain's DKIM signing key: a fresh key becomes active and the
 * incumbent drops to `retiring`, staying published in DNS until mail already
 * signed with it has been delivered. Retiring that old key is a separate,
 * deliberate step (`/dkim/:keyId/retire`) — pulling it here would break DKIM on
 * in-flight messages.
 *
 * This is one server call rather than a client-side list-then-generate pair:
 * the new selector has to be unique among the domain's existing selectors, and
 * choosing it in the browser both races other admins and spends two of the
 * tenant's five requests per second.
 */
export async function rotateDkimKey(
  domainId: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DkimKey> {
  const response = await fetchImpl(
    `/api/admin/mail/sending-domains/${encodeURIComponent(domainId)}/dkim/rotate`,
    // Fastify rejects an empty body under a JSON content-type, so send `{}`.
    { method: "POST", headers: jsonHeaders, body: JSON.stringify({}) },
  );
  const payload = await parseResponse(response, "rotate DKIM key", dkimKeyEnvelopeSchema);
  return payload.key;
}

// ---------------------------------------------------------------------------
// DMARC / deliverability — fetcher
// ---------------------------------------------------------------------------

export async function fetchMailDmarc(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DmarcResponse> {
  const response = await fetchImpl("/api/admin/mail/dmarc", { method: "GET" });
  const wire = await parseResponse(response, "load DMARC reports", dmarcResponseSchema);
  /* Re-parsing normalises the loose wire shape into the one the UI reads:
     the fields the server must state (DMARC rate, window, message count) are
     required, and the two it cannot yet aggregate arrive as null. */
  const summary = deliverabilitySchema.safeParse(
    wire.summary === null || wire.summary === undefined
      ? null
      : {
          ...wire.summary,
          spfPassRate: wire.summary.spfPassRate ?? null,
          dkimPassRate: wire.summary.dkimPassRate ?? null,
        },
  );
  return { summary: summary.success ? summary.data : null, reports: wire.reports };
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
  const response = await fetchImpl(`/api/admin/mail/routing-rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return parseResponse(response, "update routing rule", routingRuleSchema);
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

// ---------------------------------------------------------------------------
// Spam settings — fetcher
// ---------------------------------------------------------------------------

export async function fetchSpamSettings(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<SpamSettingsResponse> {
  const response = await fetchImpl("/api/admin/mail/spam", { method: "GET" });
  return parseResponse(response, "load spam settings", spamSettingsResponseSchema);
}
