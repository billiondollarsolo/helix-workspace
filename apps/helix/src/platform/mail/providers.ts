import type { JsonObject, OutboundMailDelivery, OutboundMailProvider } from "@helix/sdk-types";
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { z } from "zod";
import { outboundFetch } from "../outbound-http.js";
import { MailDeliveryError } from "./errors.js";
import type { DkimOptionsResolver, OutboundMailTransport } from "./outbound.js";
import {
  formatMailboxAddress,
  type HelixOutboundMailMessage,
  outboundMessageHeaders,
  toNodemailerMail,
} from "./outbound-format.js";
import { mailgunMessageBody, postmarkMessageBody } from "./provider-http-payloads.js";
import { isSesSmtpHost, smtpDeliveryMessageId, managedSmtpDeliveryMessageId } from "./threading.js";
import { sesFeedbackTopicArnSchema } from "./ses-feedback.js";
import type { MailOutboundDeliveryResult, MailOutboundEnvelope } from "./types.js";

/**
 * Pluggable outbound mail providers.
 *
 * Outbound dispatch is generalised behind the {@link OutboundMailProvider}
 * capability: SES, Mailgun (HTTP API), a generic SMTP relay, and Postmark each
 * implement the same `send` contract. {@link ProviderMailTransport} adapts a
 * provider to the existing {@link OutboundMailTransport} the dispatcher and
 * undo-send worker already drive, so the queue / undo / dispatch path is
 * unchanged — only the wire delivery is swapped.
 *
 * The org-selected provider + per-provider config lives in
 * `mail_outbound_providers` (see {@link OutboundProviderStore}); secrets are
 * referenced by a tenant-scoped opaque handle and never persisted inline.
 */

export type OutboundMailProviderKind = "ses" | "mailgun" | "smtp" | "postmark";

export const OUTBOUND_MAIL_PROVIDER_KINDS = [
  "ses",
  "mailgun",
  "smtp",
  "postmark",
] as const satisfies readonly OutboundMailProviderKind[];

/** Resolved, non-secret provider configuration for a single provider instance. */
export interface OutboundProviderConfig {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly kind: OutboundMailProviderKind;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly config: JsonObject;
  /** Tenant Vault handle holding the API key / SMTP password. */
  readonly secretRef: string | null;
  /** Independent Tenant Vault handle used only to authenticate feedback. */
  readonly webhookSecretRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const smtpSettings = {
  dkimMode: z.enum(["provider", "tenant"]).optional(),
  feedbackProvider: z.enum(["sendgrid", "resend", "cloudflare"]).optional(),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .refine((value) => !value.includes("@") && !value.includes("/"), "Mail host required"),
  port: z.number().int().min(1).max(65_535).optional(),
  secure: z.boolean().optional(),
  user: z.string().trim().min(1).max(320).optional(),
  feedbackTopicArn: sesFeedbackTopicArnSchema.optional(),
};
const httpsUrl = z
  .string()
  .url()
  .refine(isCredentialFreeHttpsUrl, "Credential-free HTTPS URL required");
const providerPublicConfigs = {
  ses: z.object({ ...smtpSettings, region: z.string().trim().min(1).max(100).optional() }).strict(),
  smtp: z.object(smtpSettings).strict(),
  mailgun: z
    .object({
      dkimMode: z.literal("provider").optional(),
      domain: z
        .string()
        .trim()
        .min(1)
        .max(253)
        .refine((value) => !value.includes("@") && !value.includes("/"), "Mail domain required"),
      baseUrl: httpsUrl.optional(),
    })
    .strict(),
  postmark: z
    .object({
      baseUrl: httpsUrl.optional(),
      messageStream: z.string().max(200).optional(),
      dkimMode: z.literal("provider").optional(),
    })
    .strict(),
} satisfies Record<OutboundMailProviderKind, z.ZodTypeAny>;

export function parseOutboundProviderPublicConfig(
  kind: OutboundMailProviderKind,
  value: unknown,
): JsonObject {
  return providerPublicConfigs[kind].parse(value) as JsonObject;
}

/** SMTP relays require tenant signing unless the administrator selects provider signing. */
export function providerSignsMail(config: OutboundProviderConfig): boolean {
  return (
    config.config.dkimMode === "provider" ||
    (config.config.dkimMode === undefined && config.kind !== "smtp")
  );
}

function isCredentialFreeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export interface MailProviderSecretReader {
  read(input: {
    readonly orgId: string;
    readonly scope: "mail-provider";
    readonly handle: string;
  }): Promise<Record<string, string> | undefined>;
}

/** Optional fetch dependency so HTTP-API providers stay testable. */
export type FetchLike = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string | URLSearchParams | Uint8Array<ArrayBuffer>;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

// ---------------------------------------------------------------------------
// SES provider
// ---------------------------------------------------------------------------

export interface SesProviderOptions {
  readonly name: string;
  readonly region: string;
  /** SES SMTP relay host (SES exposes SMTP per region). */
  readonly host: string;
  readonly port?: number | undefined;
  readonly secure?: boolean | undefined;
  /** SES SMTP credentials (IAM-derived SMTP user / password). */
  readonly user?: string | undefined;
  readonly pass?: string | undefined;
}

/**
 * Amazon SES provider. SES is delivered through its per-region SMTP endpoint,
 * so this adapter wraps a nodemailer SMTP transport — preserving the prior
 * `NodemailerMailTransport` behaviour while exposing the provider capability.
 */
export class SesMailProvider implements OutboundMailProvider {
  readonly kind = "ses";
  readonly name: string;
  readonly #transport: Transporter<SMTPTransport.SentMessageInfo>;
  readonly #region: string;
  readonly #resolveDkim: DkimOptionsResolver | undefined;

  constructor(
    options: SesProviderOptions,
    transport?: Transporter<SMTPTransport.SentMessageInfo>,
    resolveDkim?: DkimOptionsResolver,
  ) {
    this.name = options.name;
    this.#region = options.region;
    this.#resolveDkim = resolveDkim;
    this.#transport = transport ?? createSmtpTransport(options);
  }

  async send(message: HelixOutboundMailMessage): Promise<OutboundMailDelivery> {
    const dkim = await this.#resolveDkim?.(message.from.address);
    const info = await this.#transport.sendMail(toNodemailerMail(message, dkim, true));
    return {
      providerMessageId: smtpDeliveryMessageId(info, true),
      metadata: {
        provider: "ses",
        region: this.#region,
        response: info.response ?? null,
        accepted: info.accepted,
        rejected: info.rejected,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Mailgun provider (HTTP API)
// ---------------------------------------------------------------------------

export interface MailgunProviderOptions {
  readonly name: string;
  readonly domain: string;
  readonly apiKey: string;
  /** API base URL — `https://api.mailgun.net` (US) or `https://api.eu.mailgun.net`. */
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
}

/** Mailgun provider using the Mailgun `messages` HTTP API. */
export class MailgunMailProvider implements OutboundMailProvider {
  readonly kind = "mailgun";
  readonly name: string;
  readonly #domain: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(options: MailgunProviderOptions) {
    this.name = options.name;
    this.#domain = options.domain;
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.mailgun.net").replace(/\/+$/u, "");
    this.#fetch = options.fetch ?? defaultFetch();
  }

  async send(message: HelixOutboundMailMessage): Promise<OutboundMailDelivery> {
    const encoded = await mailgunMessageBody(message);
    const authorization = `Basic ${Buffer.from(`api:${this.#apiKey}`).toString("base64")}`;
    const response = await this.#fetch(`${this.#baseUrl}/v3/${this.#domain}/messages`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": encoded.contentType },
      body: encoded.body,
    });
    if (!response.ok) {
      await discardText(response);
      throw httpDeliveryError("Mailgun", response.status);
    }
    const payload = (await response.json()) as {
      readonly id?: unknown;
      readonly message?: unknown;
    };
    return {
      ...(typeof payload.id === "string" ? { providerMessageId: payload.id } : {}),
      metadata: {
        provider: "mailgun",
        domain: this.#domain,
        message: typeof payload.message === "string" ? payload.message : null,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// SMTP relay provider
// ---------------------------------------------------------------------------

export interface SmtpRelayProviderOptions {
  readonly name: string;
  readonly host: string;
  readonly port?: number | undefined;
  readonly secure?: boolean | undefined;
  readonly user?: string | undefined;
  readonly pass?: string | undefined;
}

/** Generic SMTP relay provider (any RFC 5321 relay). */
export class SmtpRelayMailProvider implements OutboundMailProvider {
  readonly kind = "smtp";
  readonly name: string;
  readonly #transport: Transporter<SMTPTransport.SentMessageInfo>;
  readonly #host: string;
  readonly #resolveDkim: DkimOptionsResolver | undefined;

  constructor(
    options: SmtpRelayProviderOptions,
    transport?: Transporter<SMTPTransport.SentMessageInfo>,
    resolveDkim?: DkimOptionsResolver,
  ) {
    this.name = options.name;
    this.#host = options.host;
    this.#resolveDkim = resolveDkim;
    this.#transport = transport ?? createSmtpTransport(options);
  }

  async send(message: HelixOutboundMailMessage): Promise<OutboundMailDelivery> {
    const dkim = await this.#resolveDkim?.(message.from.address);
    const info = await this.#transport.sendMail(
      toNodemailerMail(message, dkim, isSesSmtpHost(this.#host)),
    );
    return {
      providerMessageId: managedSmtpDeliveryMessageId(info, this.#host),
      metadata: {
        provider: "smtp",
        host: this.#host,
        response: info.response ?? null,
        accepted: info.accepted,
        rejected: info.rejected,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Postmark provider (HTTP API)
// ---------------------------------------------------------------------------

export interface PostmarkProviderOptions {
  readonly name: string;
  /** Postmark Server API token. */
  readonly serverToken: string;
  readonly baseUrl?: string | undefined;
  /** Optional Postmark message stream id (defaults to `outbound`). */
  readonly messageStream?: string | undefined;
  readonly fetch?: FetchLike | undefined;
}

/** Postmark provider using the Postmark `/email` HTTP API. */
export class PostmarkMailProvider implements OutboundMailProvider {
  readonly kind = "postmark";
  readonly name: string;
  readonly #serverToken: string;
  readonly #baseUrl: string;
  readonly #messageStream: string;
  readonly #fetch: FetchLike;

  constructor(options: PostmarkProviderOptions) {
    this.name = options.name;
    this.#serverToken = options.serverToken;
    this.#baseUrl = (options.baseUrl ?? "https://api.postmarkapp.com").replace(/\/+$/u, "");
    this.#messageStream = options.messageStream ?? "outbound";
    this.#fetch = options.fetch ?? defaultFetch();
  }

  async send(message: HelixOutboundMailMessage): Promise<OutboundMailDelivery> {
    const response = await this.#fetch(`${this.#baseUrl}/email`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": this.#serverToken,
      },
      body: postmarkMessageBody(message, this.#messageStream),
    });
    if (!response.ok) {
      await discardText(response);
      throw httpDeliveryError("Postmark", response.status);
    }
    const payload = (await response.json()) as {
      readonly MessageID?: unknown;
      readonly ErrorCode?: unknown;
      readonly Message?: unknown;
    };
    if (typeof payload.ErrorCode === "number" && payload.ErrorCode !== 0) {
      throw new Error(`Postmark rejected the message (${String(payload.ErrorCode)})`);
    }
    return {
      ...(typeof payload.MessageID === "string" ? { providerMessageId: payload.MessageID } : {}),
      metadata: {
        provider: "postmark",
        messageStream: this.#messageStream,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Transport adapter
// ---------------------------------------------------------------------------

/**
 * Adapts an {@link OutboundMailProvider} to the {@link OutboundMailTransport}
 * the dispatcher / undo-send worker already drive. This keeps the queue, undo
 * window, and dispatch span untouched while routing delivery through whichever
 * provider the org selected.
 */
export class ProviderMailTransport implements OutboundMailTransport {
  constructor(
    private readonly provider: OutboundMailProvider,
    private readonly providerId?: string,
    private readonly resolveDkim?: DkimOptionsResolver,
  ) {}

  async send(
    envelope: MailOutboundEnvelope,
    handoff: { readonly idempotencyKey: string },
  ): Promise<MailOutboundDeliveryResult> {
    if (this.resolveDkim !== undefined && !["ses", "smtp"].includes(this.provider.kind)) {
      const key = await this.resolveDkim(envelope.from.address);
      if (key !== null) {
        throw new MailDeliveryError(
          `${this.provider.kind} cannot preserve a tenant-owned DKIM signature; use SMTP or SES.`,
          false,
        );
      }
    }
    const delivery = await this.provider.send(
      envelopeToMessage(envelope, handoff.idempotencyKey, this.provider.kind),
    );
    return {
      ...(delivery.providerMessageId === undefined
        ? {}
        : { providerMessageId: delivery.providerMessageId }),
      deliveryMetadata: {
        provider: this.provider.kind,
        ...(this.providerId === undefined ? {} : { providerId: this.providerId }),
        providerName: this.provider.name,
        ...(delivery.metadata ?? {}),
      },
    };
  }
}

/**
 * Build a concrete {@link OutboundMailProvider} from a stored provider config.
 * `resolveSecret` supplies a credential already resolved from the tenant's
 * opaque Vault handle; missing secrets fail fast.
 */
export function createOutboundMailProvider(
  config: OutboundProviderConfig,
  resolveSecret: (ref: string | null) => string | undefined,
  deps: { readonly fetch?: FetchLike; readonly dkimResolver?: DkimOptionsResolver } = {},
): OutboundMailProvider {
  const settings = config.config;
  switch (config.kind) {
    case "ses": {
      const host = requireString(settings, "host", config.name);
      return new SesMailProvider(
        {
          name: config.name,
          region: stringSetting(settings, "region") ?? "us-east-1",
          host,
          ...(numberSetting(settings, "port") === undefined
            ? {}
            : { port: numberSetting(settings, "port") }),
          ...(booleanSetting(settings, "secure") === undefined
            ? {}
            : { secure: booleanSetting(settings, "secure") }),
          ...(stringSetting(settings, "user") === undefined
            ? {}
            : { user: stringSetting(settings, "user") }),
          ...(resolveSecret(config.secretRef) === undefined
            ? {}
            : { pass: resolveSecret(config.secretRef) }),
        },
        undefined,
        deps.dkimResolver,
      );
    }
    case "mailgun": {
      return new MailgunMailProvider({
        name: config.name,
        domain: requireString(settings, "domain", config.name),
        apiKey: requireSecret(resolveSecret, config.secretRef, config.name),
        ...(stringSetting(settings, "baseUrl") === undefined
          ? {}
          : { baseUrl: stringSetting(settings, "baseUrl") }),
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      });
    }
    case "smtp": {
      return new SmtpRelayMailProvider(
        {
          name: config.name,
          host: requireString(settings, "host", config.name),
          ...(numberSetting(settings, "port") === undefined
            ? {}
            : { port: numberSetting(settings, "port") }),
          ...(booleanSetting(settings, "secure") === undefined
            ? {}
            : { secure: booleanSetting(settings, "secure") }),
          ...(stringSetting(settings, "user") === undefined
            ? {}
            : { user: stringSetting(settings, "user") }),
          ...(resolveSecret(config.secretRef) === undefined
            ? {}
            : { pass: resolveSecret(config.secretRef) }),
        },
        undefined,
        deps.dkimResolver,
      );
    }
    case "postmark": {
      return new PostmarkMailProvider({
        name: config.name,
        serverToken: requireSecret(resolveSecret, config.secretRef, config.name),
        ...(stringSetting(settings, "baseUrl") === undefined
          ? {}
          : { baseUrl: stringSetting(settings, "baseUrl") }),
        ...(stringSetting(settings, "messageStream") === undefined
          ? {}
          : { messageStream: stringSetting(settings, "messageStream") }),
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      });
    }
    default: {
      const exhaustive: never = config.kind;
      throw new Error(`Unknown outbound mail provider kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Resolve the outbound transport for an org: when a default provider is
 * configured in the store, deliver through it; otherwise fall back to the
 * supplied default transport (the env-configured SMTP/SES relay). Secrets are
 * resolved from the injected tenant secret reader via the opaque handle.
 */
export async function resolveOutboundTransport(input: {
  readonly orgId: string;
  readonly providerStore: {
    getDefaultProvider(orgId: string): Promise<OutboundProviderConfig | null>;
  };
  readonly fallbackTransport?: OutboundMailTransport | undefined;
  readonly secretReader?: MailProviderSecretReader | undefined;
  readonly fetch?: FetchLike;
  readonly dkimResolver?: DkimOptionsResolver;
}): Promise<OutboundMailTransport> {
  const config = await input.providerStore.getDefaultProvider(input.orgId);
  if (config === null) {
    if (input.fallbackTransport === undefined) {
      throw new MailDeliveryError(
        `No outbound mail provider is configured for tenant ${input.orgId}.`,
        false,
      );
    }
    return input.fallbackTransport;
  }
  if (config.orgId !== input.orgId) {
    throw new MailDeliveryError("Outbound provider tenant mismatch.", false);
  }
  const secret =
    config.secretRef === null
      ? undefined
      : await input.secretReader?.read({
          orgId: input.orgId,
          scope: "mail-provider",
          handle: config.secretRef,
        });
  const resolveDkim = providerSignsMail(config) ? undefined : input.dkimResolver;
  let provider: OutboundMailProvider;
  try {
    provider = createOutboundMailProvider(config, () => secret?.credential, {
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      ...(resolveDkim === undefined ? {} : { dkimResolver: resolveDkim }),
    });
  } catch (error) {
    throw new MailDeliveryError("Outbound mail provider configuration is invalid.", false, {
      cause: error,
    });
  }
  return new ProviderMailTransport(provider, config.id, resolveDkim);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Providers that accept an SMTP envelope separate from the visible headers. */
const ENVELOPE_CAPABLE_PROVIDERS = new Set(["ses", "smtp"]);

function envelopeToMessage(
  envelope: MailOutboundEnvelope,
  idempotencyKey: string,
  providerKind: string,
): HelixOutboundMailMessage {
  const recipients = envelope.envelopeRecipients?.map((address) => address.toLowerCase());
  const separateEnvelope = recipients !== undefined && ENVELOPE_CAPABLE_PROVIDERS.has(providerKind);
  // HTTP APIs (Mailgun, Postmark) deliver to every visible recipient, so they
  // keep only the envelope recipients in To/Cc/Bcc rather than double-deliver.
  const visible = (list: MailOutboundEnvelope["to"]) =>
    (recipients === undefined || separateEnvelope
      ? list
      : list.filter((entry) => recipients.includes(entry.address.toLowerCase()))
    ).map(addressOf);
  return {
    from: addressOf(envelope.from),
    to: visible(envelope.to),
    cc: visible(envelope.cc),
    bcc: visible(envelope.bcc),
    subject: envelope.subject,
    text: envelope.text,
    ...(envelope.html === undefined ? {} : { html: envelope.html }),
    ...(envelope.replyTo === undefined ? {} : { replyTo: formatMailboxAddress(envelope.replyTo) }),
    headers: outboundMessageHeaders(envelope, idempotencyKey),
    ...(separateEnvelope && envelope.envelopeRecipients !== undefined
      ? { envelopeRecipients: envelope.envelopeRecipients }
      : {}),
    attachments: envelope.attachments.map((attachment) => ({
      ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
      ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
      ...(attachment.contentId === undefined ? {} : { contentId: attachment.contentId }),
      content: new Uint8Array(attachment.content ?? Buffer.alloc(0)),
    })),
  };
}

function httpDeliveryError(provider: string, status: number): MailDeliveryError {
  return new MailDeliveryError(
    `${provider} delivery failed with HTTP ${String(status)}`,
    status >= 500 || status === 408 || status === 425 || status === 429,
  );
}

function addressOf(value: { readonly address: string; readonly name?: string }): {
  readonly address: string;
  readonly name?: string;
} {
  return value.name === undefined
    ? { address: value.address }
    : { address: value.address, name: value.name };
}

/** Shared nodemailer SMTP transport used by the SES and SMTP-relay providers. */
export function createSmtpTransport(options: {
  readonly host: string;
  readonly port?: number | undefined;
  readonly secure?: boolean | undefined;
  readonly user?: string | undefined;
  readonly pass?: string | undefined;
}): Transporter<SMTPTransport.SentMessageInfo> {
  return nodemailer.createTransport({
    host: options.host,
    port: options.port ?? 587,
    secure: options.secure ?? false,
    // Same rule as the environment relay: STARTTLS must not be downgradable.
    requireTLS: options.secure !== true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    ...(options.user === undefined
      ? {}
      : { auth: { user: options.user, pass: options.pass ?? "" } }),
  });
}

function defaultFetch(): FetchLike {
  return (input, init) =>
    outboundFetch(input, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
}

async function discardText(response: { text(): Promise<string> }): Promise<void> {
  try {
    await response.text();
  } catch {
    // Ignore provider-controlled response text; status codes are safe to report.
  }
}

function stringSetting(settings: JsonObject, key: string): string | undefined {
  const value = settings[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberSetting(settings: JsonObject, key: string): number | undefined {
  const value = settings[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanSetting(settings: JsonObject, key: string): boolean | undefined {
  const value = settings[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function requireString(settings: JsonObject, key: string, providerName: string): string {
  const value = stringSetting(settings, key);
  if (value === undefined) {
    throw new Error(`Outbound provider "${providerName}" is missing required config "${key}".`);
  }
  return value;
}

function requireSecret(
  resolveSecret: (ref: string | null) => string | undefined,
  secretRef: string | null,
  providerName: string,
): string {
  const value = resolveSecret(secretRef);
  if (value === undefined || value.length === 0) {
    throw new Error(
      `Outbound provider "${providerName}" is missing its API credential (secret_ref).`,
    );
  }
  return value;
}
