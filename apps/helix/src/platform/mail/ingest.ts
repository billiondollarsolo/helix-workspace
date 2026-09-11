import type { JsonObject, SecurityTier } from "@helix/sdk-types";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { authenticate, type AuthenticateResult, type AuthStatus } from "mailauth";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { createHash } from "node:crypto";
import { mkdtemp, open as openFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import { compactJsonObject } from "../util/json.js";
import { MailAddressNormalizationError, normalizeMailboxAddress } from "./address-normalization.js";
import type { AntivirusScanner, AntivirusScanResult } from "./antivirus.js";
import {
  inspectInboundAttachments,
  sanitizeMailHeaderDisplayValue,
  sanitizeMailHtml,
} from "./content-safety.js";
import { MailAddressDeliveryError, MailMalwareRejectedError } from "./errors.js";
import { evaluateInboundMail, type MailFilterEvaluationResult } from "./filters.js";
import {
  evaluateInboundAuthenticationPolicy,
  parseInboundAuthenticationPolicy,
  type InboundAuthenticationPolicy,
  type InboundPolicyDecision,
  type InboundThreatVerdicts,
} from "./inbound-policy.js";
import type { MailQuarantineStore } from "./quarantine.js";
import { prepareMailRawSource } from "./raw-source.js";
import { InMemorySmtpRateLimitStore, type SmtpRateLimitStore } from "./smtp-rate-limit.js";
import {
  smtpDisabledCommands,
  smtpTransportSecurityOptions,
  type SmtpTransportSecurity,
} from "./smtp-transport-security.js";
import type { SpamScanner, SpamScanResult } from "./spam.js";
import type { MailStore } from "./store.js";
import type {
  MailAddress,
  MailAttachmentInput,
  MailInboundAddressResolution,
  MailInboundRecipient,
  MailInboundRoutingRule,
  MailMessageInput,
  StoredMailMessage,
} from "./types.js";
export interface MailAuthenticationSummary {
  readonly spf: string;
  readonly dkim: string;
  readonly dmarc: string;
  readonly arc: string;
  readonly headers?: string;
  readonly evidence?: JsonObject;
}

export interface IngestRawMailInput {
  readonly orgId: string;
  readonly recipients: readonly MailInboundRecipient[];
  readonly raw: Buffer | string;
  readonly envelopeFrom?: string;
  readonly remoteAddress?: string;
  readonly helo?: string;
  readonly providerDeliveryId?: string;
  readonly receivedAt?: Date;
  readonly parsed?: ParsedMail;
}

export type MailInboundRecipientResolution =
  MailInboundAddressResolution | MailInboundRecipient | readonly MailInboundRecipient[] | null;

export function resolvedMailRecipients(
  resolution: MailInboundRecipientResolution,
): readonly MailInboundRecipient[] {
  if (resolution === null) return [];
  if (isAddressResolution(resolution)) return resolution.recipients;
  return Array.isArray(resolution)
    ? (resolution as readonly MailInboundRecipient[])
    : [resolution as MailInboundRecipient];
}

function isAddressResolution(
  resolution: Exclude<MailInboundRecipientResolution, null>,
): resolution is MailInboundAddressResolution {
  return !Array.isArray(resolution) && "recipients" in resolution && "rules" in resolution;
}

function acceptsInboundRecipient(resolution: MailInboundRecipientResolution): boolean {
  return (
    resolvedMailRecipients(resolution).length > 0 ||
    (resolution !== null && isAddressResolution(resolution) && resolution.rules.length > 0)
  );
}

/**
 * Outcome of inbound spam + antivirus scanning. `routedToSpam` is true when
 * either scanner produced a verdict that moved the message to the Spam folder.
 */
export interface InboundScanResult {
  readonly spam: SpamScanResult | null;
  readonly antivirus: AntivirusScanResult | null;
  readonly routedToSpam: boolean;
  /** True when malware policy withheld the message because no clean verdict exists. */
  readonly quarantined: boolean;
  readonly spamReason: "spam-score" | "virus" | "scanner-policy" | "auth-failure" | null;
  /**
   * Who put the message in Spam (for UI + feedback).
   * Layering: spamd first; AI/rules only after spamd passes (not spam).
   */
  readonly spamCatcher?: SpamCatcher;
  readonly quarantineReasons?: readonly string[];
  readonly scannerUnavailable?: boolean;
}

export interface IngestRawMailResult {
  readonly stored: StoredMailMessage;
  readonly auth: MailAuthenticationSummary;
  readonly filterResult: MailFilterEvaluationResult;
  readonly scan: InboundScanResult;
  readonly policy: InboundPolicyDecision;
}

export type InboundScanFailurePolicy = "deliver" | "defer";

interface InboundScannerUnavailableEvent {
  readonly scanner: "spam" | "antivirus";
  readonly policy: InboundScanFailurePolicy;
  readonly error: unknown;
}

/** Optional scanners plus the tenant's explicit scanner-outage policy. */
export interface InboundMailScanners {
  /** Business and higher tiers fail closed when no clean antivirus verdict exists. */
  readonly tier?: SecurityTier;
  /**
   * Optional beta AI+rules second pass after spamd. Must not throw; callers
   * treat missing/failed AI as no additional vote. Return `null` when beta is
   * disabled at call time (config is re-resolved per invocation for hot-reload).
   */
  readonly betaSpamSecondPass?:
    | ((features: {
        readonly subject: string;
        readonly bodyText: string;
        readonly fromAddress: string;
        readonly spamdScore?: number | undefined;
        readonly spamdIsSpam?: boolean | undefined;
      }) => Promise<{ readonly isSpam: boolean; readonly evidence: JsonObject } | null>)
    | undefined;

  readonly spam?: SpamScanner | undefined;
  readonly antivirus?: AntivirusScanner | undefined;
  readonly failurePolicy?: InboundScanFailurePolicy | undefined;
  readonly onUnavailable?: ((event: InboundScannerUnavailableEvent) => void) | undefined;
}

export interface MailAuthenticator {
  authenticate(input: IngestRawMailInput): Promise<MailAuthenticationSummary>;
}

export interface SmtpReceiverOptions {
  readonly transportSecurity: SmtpTransportSecurity;
  readonly limits?: Partial<SmtpReceiverLimits> | undefined;
  readonly rateLimitStore?: SmtpRateLimitStore | undefined;
  readonly store: MailStore;
  readonly quarantineStore?: MailQuarantineStore | undefined;
  readonly resolveRecipient: (address: string) => Promise<MailInboundRecipientResolution>;
  readonly authenticator?: MailAuthenticator;
  readonly disabledCommands?: readonly string[];
  readonly logger?: { error(error: unknown, message?: string): void };
  readonly maxMessageBytes?: number;
  readonly maxRecipients?: number;
  readonly maxConnections?: number;
  readonly socketTimeoutMs?: number;
  readonly dataTimeoutMs?: number;
  /** Optional inbound spam + antivirus scanners (config-gated in server.ts). */
  readonly scanners?: InboundMailScanners | undefined;
  /** Resolve the receiving tenant's scanner-outage policy before persistence. */
  readonly resolveScanFailurePolicy?:
    ((orgId: string) => Promise<InboundScanFailurePolicy>) | undefined;
  readonly resolveAuthenticationPolicy?:
    ((orgId: string) => Promise<InboundAuthenticationPolicy>) | undefined;
  /** Establish the tenant-local database context for a direct SMTP delivery. */
  readonly runForTenant?:
    (<T>(orgId: string, operation: () => Promise<T>) => Promise<T>) | undefined;
  readonly authorizeForward?:
    | ((input: {
        readonly orgId: string;
        readonly actorId: string;
        readonly content: unknown;
      }) => Promise<boolean>)
    | undefined;
}

export class MailauthAuthenticator implements MailAuthenticator {
  async authenticate(input: IngestRawMailInput): Promise<MailAuthenticationSummary> {
    const result = await authenticate(input.raw, {
      ...(input.envelopeFrom === undefined ? {} : { sender: input.envelopeFrom }),
      ...(input.remoteAddress === undefined ? {} : { ip: input.remoteAddress }),
      ...(input.helo === undefined ? {} : { helo: input.helo }),
    });
    return summarizeAuthentication(result);
  }
}

export class SmtpMailReceiver {
  private readonly server: SMTPServer;
  private readonly sessions = new WeakMap<SMTPServerSession, SmtpSessionState>();
  private readonly activeConnectionsByIp = new Map<string, number>();
  private readonly limits: SmtpReceiverLimits;
  private readonly rateLimits: SmtpRateLimitStore;

  constructor(private readonly options: SmtpReceiverOptions) {
    this.limits = resolveSmtpReceiverLimits({
      ...options.limits,
      ...(options.maxMessageBytes === undefined
        ? {}
        : { maxMessageBytes: options.maxMessageBytes }),
      ...(options.maxRecipients === undefined
        ? {}
        : { maxRecipientsPerMessage: options.maxRecipients }),
      ...(options.maxConnections === undefined
        ? {}
        : { maxConcurrentConnections: options.maxConnections }),
      ...(options.socketTimeoutMs === undefined
        ? {}
        : { socketTimeoutMs: options.socketTimeoutMs }),
    });
    this.rateLimits = options.rateLimitStore ?? new InMemorySmtpRateLimitStore();
    this.server = new SMTPServer({
      ...smtpTransportSecurityOptions(options.transportSecurity),
      disabledCommands: smtpDisabledCommands(
        options.transportSecurity,
        options.disabledCommands ?? ["AUTH"],
      ),
      maxClients: this.limits.maxConcurrentConnections,
      size: this.limits.maxMessageBytes,
      socketTimeout: this.limits.socketTimeoutMs,
      hideSMTPUTF8: true,
      onConnect: (session, callback) => {
        void this.handleConnect(session).then(
          () => {
            callback();
          },
          (error: unknown) => {
            callback(asSmtpError(error, 421, "Connection temporarily refused."));
          },
        );
      },
      onClose: (session) => {
        this.handleClose(session);
      },
      onMailFrom: (address, session, callback) => {
        try {
          const state = this.requireCommandCapacity(session);
          if (state.messageAttempts >= this.limits.maxMessagesPerConnection) {
            callback(smtpError(452, "Message limit for this connection exceeded."));
            return;
          }
          state.recipients.clear();
          state.envelopeFrom =
            address.address.length === 0
              ? undefined
              : normalizeMailboxAddress(address.address).address;
          callback();
        } catch (error) {
          callback(
            error instanceof MailAddressNormalizationError
              ? smtpError(553, "Malformed envelope sender.")
              : asSmtpError(error, 421, "Command limit exceeded."),
          );
        }
      },
      onRcptTo: (address, session, callback) => {
        void this.handleRecipient(address.address, session).then(
          () => {
            callback();
          },
          (error: unknown) => {
            callback(asSmtpError(error, 451, "Recipient lookup unavailable."));
          },
        );
      },
      onData: (stream, session, callback) => {
        this.handleData(stream, session)
          .then(() => {
            callback(null, "Message accepted for delivery.");
          })
          .catch((error: unknown) => {
            this.options.logger?.error(error, "SMTP mail ingest failed");
            callback(asSmtpError(error, 451, "Message persistence temporarily unavailable."));
          });
      },
    });
  }

  private async handleConnect(session: SMTPServerSession): Promise<void> {
    const allowed = await this.rateLimits.consume({
      scope: "connection",
      key: session.remoteAddress,
      limit: this.limits.connectionsPerWindow,
      windowMs: this.limits.connectionWindowMs,
    });
    if (!allowed) {
      throw smtpError(421, "Connection rate limit exceeded.");
    }
    const current = this.activeConnectionsByIp.get(session.remoteAddress) ?? 0;
    if (current >= this.limits.maxConcurrentConnectionsPerIp) {
      throw smtpError(421, "Concurrent connection limit exceeded.");
    }
    this.activeConnectionsByIp.set(session.remoteAddress, current + 1);
    this.sessions.set(session, {
      commands: 0,
      messageAttempts: 0,
      connected: true,
      recipients: new Map(),
    });
  }

  private handleClose(session: SMTPServerSession): void {
    const state = this.sessions.get(session);
    if (state?.connected !== true) {
      return;
    }
    state.connected = false;
    const current = this.activeConnectionsByIp.get(session.remoteAddress) ?? 0;
    if (current <= 1) {
      this.activeConnectionsByIp.delete(session.remoteAddress);
    } else {
      this.activeConnectionsByIp.set(session.remoteAddress, current - 1);
    }
  }

  private async handleRecipient(address: string, session: SMTPServerSession): Promise<void> {
    const state = this.requireCommandCapacity(session);
    let normalized: string;
    try {
      normalized = normalizeMailboxAddress(address).address;
    } catch {
      throw smtpError(550, "Unknown or malformed recipient.");
    }
    if (state.recipients.has(normalized)) {
      return;
    }
    if (state.recipients.size >= this.limits.maxRecipientsPerMessage) {
      throw smtpError(452, "Recipient limit exceeded.");
    }
    let recipient: MailInboundRecipientResolution;
    try {
      recipient = await withTimeout(
        this.options.resolveRecipient(normalized),
        this.limits.recipientResolutionTimeoutMs,
      );
    } catch (error) {
      if (error instanceof MailAddressDeliveryError) throw error;
      throw smtpError(451, "Recipient lookup temporarily unavailable.");
    }
    if (!acceptsInboundRecipient(recipient)) {
      throw smtpError(550, "Unknown recipient domain or mailbox.");
    }
    state.recipients.set(normalized, recipient);
  }

  private async handleData(
    stream: SMTPServerDataStream,
    session: SMTPServerSession,
  ): Promise<void> {
    const state = this.requireCommandCapacity(session);
    if (state.recipients.size === 0) {
      throw smtpError(554, "No accepted recipients.");
    }
    state.messageAttempts += 1;
    const rateAllowed = await this.rateLimits.consume({
      scope: "message",
      key: session.remoteAddress,
      limit: this.limits.messagesPerWindow,
      windowMs: this.limits.messageWindowMs,
    });
    if (!rateAllowed) {
      throw smtpError(451, "Message rate limit exceeded.");
    }
    const raw = await spoolStream(stream, {
      maxBytes: this.limits.maxMessageBytes,
      timeoutMs: this.options.dataTimeoutMs ?? 120000,
    });
    await ingestSmtpEnvelope({
      ...this.options,
      raw,
      envelopeTo: [...state.recipients.keys()],
      ...(state.envelopeFrom === undefined ? {} : { envelopeFrom: state.envelopeFrom }),
      remoteAddress: session.remoteAddress,
      helo: session.hostNameAppearsAs,
    });
  }

  private requireCommandCapacity(session: SMTPServerSession): SmtpSessionState {
    const state = this.sessions.get(session);
    if (state === undefined || !state.connected) {
      throw smtpError(421, "SMTP session is not active.");
    }
    state.commands += 1;
    if (state.commands > this.limits.maxCommandsPerConnection) {
      throw smtpError(421, "Command limit exceeded.");
    }
    return state;
  }

  listen(port: number, host?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server.close(() => {
          resolve();
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  get nodeServer(): SMTPServer {
    return this.server;
  }
}

interface InboundForward {
  readonly ruleId: string;
  readonly source: MailInboundRecipient;
  readonly target: string;
}

interface TenantInboundPlan {
  readonly mailboxes: Map<string, MailInboundRecipient>;
  readonly tags: Map<string, Set<string>>;
  readonly forwards: Map<string, InboundForward>;
}

function tenantInboundPlan(): TenantInboundPlan {
  return { mailboxes: new Map(), tags: new Map(), forwards: new Map() };
}

function evaluateInboundRouting(
  resolution: MailInboundAddressResolution,
  parsed: ParsedMail | undefined,
): {
  readonly handled: boolean;
  readonly recipients: readonly MailInboundRecipient[];
  readonly tags: readonly string[];
  readonly forwards: readonly InboundForward[];
} {
  let recipients = resolution.recipients;
  let handled = recipients.length > 0;
  const tags = new Set<string>();
  const forwards: InboundForward[] = [];
  for (const rule of resolution.rules) {
    if (!matchesInboundRoutingRule(rule, resolution.address, parsed)) continue;
    switch (rule.actionKind) {
      case "alias":
      case "mailbox":
        if (rule.targetRecipients.length > 0) {
          recipients = rule.targetRecipients;
          handled = true;
        }
        break;
      case "drop":
        recipients = [];
        forwards.length = 0;
        handled = true;
        break;
      case "tag": {
        const tag = rule.action.tag;
        if (recipients.length > 0 && typeof tag === "string") {
          tags.add(tag);
          handled = true;
        }
        break;
      }
      case "forward": {
        const target = rule.action.forwardTo;
        if (rule.sourceRecipient !== undefined && typeof target === "string") {
          forwards.push({ ruleId: rule.id, source: rule.sourceRecipient, target });
          handled = true;
        }
        break;
      }
    }
    if (rule.action.stopProcessing === true) break;
  }
  return { handled, recipients, tags: [...tags], forwards };
}

function matchesInboundRoutingRule(
  rule: MailInboundRoutingRule,
  recipient: string,
  parsed: ParsedMail | undefined,
): boolean {
  const recipientPattern = rule.match.recipientPattern;
  if (typeof recipientPattern === "string" && !matchesAddressPattern(recipient, recipientPattern)) {
    return false;
  }
  const senderPattern = rule.match.senderPattern;
  if (
    typeof senderPattern === "string" &&
    !matchesAddressPattern(addressObjectToList(parsed?.from)[0]?.address ?? "", senderPattern)
  ) {
    return false;
  }
  const subjectContains = rule.match.subjectContains;
  if (
    typeof subjectContains === "string" &&
    !(parsed?.subject ?? "").toLowerCase().includes(subjectContains.toLowerCase())
  ) {
    return false;
  }
  const headerName = rule.match.headerName;
  const headerContains = rule.match.headerContains;
  if (typeof headerName === "string" && typeof headerContains === "string") {
    const value = parsed?.headers.get(headerName.toLowerCase());
    if (!mailHeaderText(value).toLowerCase().includes(headerContains.toLowerCase())) return false;
  }
  return true;
}

function mailHeaderText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function matchesAddressPattern(address: string, pattern: string): boolean {
  const normalizedAddress = address.trim().toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();
  return normalizedPattern.startsWith("*@")
    ? normalizedAddress.endsWith(normalizedPattern.slice(1))
    : normalizedAddress === normalizedPattern;
}

async function queueInboundForward(
  store: MailStore,
  input: {
    readonly orgId: string;
    readonly stored: StoredMailMessage;
    readonly parsed: ParsedMail;
    readonly forward: InboundForward;
    readonly authorize?: SmtpReceiverOptions["authorizeForward"];
  },
): Promise<void> {
  const originalSender = addressObjectToList(input.parsed.from)[0]?.address ?? "unknown sender";
  const subject = input.parsed.subject ?? "";
  const text = `Forwarded message from ${originalSender}\n\n${input.parsed.text ?? ""}`;
  const attachments = parsedAttachments(input.parsed);
  if (
    input.authorize !== undefined &&
    !(await input.authorize({
      orgId: input.orgId,
      actorId: input.forward.source.actorId,
      content: { subject, text, attachments },
    }))
  ) {
    return;
  }
  await store.createOutbound({
    orgId: input.orgId,
    actorId: input.forward.source.actorId,
    threadId: input.stored.threadId,
    envelope: {
      from: { address: input.forward.source.address },
      to: [{ address: input.forward.target }],
      cc: [],
      bcc: [],
      subject: /^fwd:/iu.test(subject) ? subject : `Fwd: ${subject}`,
      text,
      attachments,
    },
    undoUntil: new Date(),
    outboxSubject: "mail.send",
    idempotencyKey: `routing:${input.stored.messageId}:${input.forward.ruleId}`,
  });
}

export async function ingestSmtpEnvelope(input: {
  readonly store: MailStore;
  readonly quarantineStore?: MailQuarantineStore | undefined;
  readonly resolveRecipient: (address: string) => Promise<MailInboundRecipientResolution>;
  readonly raw: Buffer | string;
  readonly envelopeFrom?: string | undefined;
  readonly envelopeTo: readonly string[];
  readonly remoteAddress?: string | undefined;
  readonly helo?: string | undefined;
  readonly authenticator?: MailAuthenticator | undefined;
  readonly scanners?: InboundMailScanners | undefined;
  readonly resolveScanFailurePolicy?:
    ((orgId: string) => Promise<InboundScanFailurePolicy>) | undefined;
  readonly resolveAuthenticationPolicy?:
    ((orgId: string) => Promise<InboundAuthenticationPolicy>) | undefined;
  readonly runForTenant?:
    (<T>(orgId: string, operation: () => Promise<T>) => Promise<T>) | undefined;
  readonly authorizeForward?: SmtpReceiverOptions["authorizeForward"];
}): Promise<readonly IngestRawMailResult[]> {
  const resolved = await Promise.all(input.envelopeTo.map(input.resolveRecipient));
  if (resolved.some((resolution) => !acceptsInboundRecipient(resolution))) {
    throw rejectedRecipient("unknown mailbox");
  }
  const hasRoutingRules = resolved.some(
    (resolution) =>
      resolution !== null && isAddressResolution(resolution) && resolution.rules.length > 0,
  );
  const parsed = hasRoutingRules
    ? await simpleParser(input.raw, { skipTextToHtml: true })
    : undefined;
  if (parsed !== undefined) assertParsedMailBounds(parsed);

  const tenants = new Map<string, TenantInboundPlan>();
  for (const [index, resolution] of resolved.entries()) {
    const evaluated =
      resolution !== null && isAddressResolution(resolution)
        ? evaluateInboundRouting(resolution, parsed)
        : {
            handled: resolvedMailRecipients(resolution).length > 0,
            recipients: resolvedMailRecipients(resolution),
            tags: [] as const,
            forwards: [] as const,
          };
    if (!evaluated.handled) throw rejectedRecipient(input.envelopeTo[index] ?? "unknown mailbox");
    for (const recipient of evaluated.recipients) {
      const tenant = tenants.get(recipient.orgId) ?? tenantInboundPlan();
      tenant.mailboxes.set(recipient.actorId, recipient);
      for (const tag of evaluated.tags) {
        const tags = tenant.tags.get(recipient.actorId) ?? new Set<string>();
        tags.add(tag);
        tenant.tags.set(recipient.actorId, tags);
      }
      tenants.set(recipient.orgId, tenant);
    }
    for (const forward of evaluated.forwards) {
      const tenant = tenants.get(forward.source.orgId) ?? tenantInboundPlan();
      tenant.forwards.set(forward.ruleId, forward);
      tenants.set(forward.source.orgId, tenant);
    }
  }
  const results = await Promise.all(
    [...tenants.entries()].map(async ([orgId, tenant]) => {
      const [resolvedFailurePolicy, authenticationPolicy] = await Promise.all([
        input.resolveScanFailurePolicy?.(orgId),
        input.resolveAuthenticationPolicy?.(orgId),
      ]);
      const failurePolicy = resolvedFailurePolicy ?? input.scanners?.failurePolicy ?? "deliver";
      const ingest = async () => {
        try {
          const result = await ingestRawMail({
            store: input.store,
            ...(input.quarantineStore === undefined
              ? {}
              : { quarantineStore: input.quarantineStore }),
            ...(input.authenticator === undefined ? {} : { authenticator: input.authenticator }),
            scanners: { ...input.scanners, failurePolicy },
            malwareDisposition: "quarantine",
            ...(authenticationPolicy === undefined ? {} : { authenticationPolicy }),
            input: {
              orgId,
              recipients: [...tenant.mailboxes.values()],
              raw: input.raw,
              ...(parsed === undefined ? {} : { parsed }),
              ...(input.envelopeFrom === undefined ? {} : { envelopeFrom: input.envelopeFrom }),
              ...(input.remoteAddress === undefined ? {} : { remoteAddress: input.remoteAddress }),
              ...(input.helo === undefined ? {} : { helo: input.helo }),
            },
          });
          await Promise.all([
            ...result.stored.deliveredActorIds.flatMap((actorId) => {
              const tags = tenant.tags.get(actorId);
              return tags === undefined || tags.size === 0
                ? []
                : [
                    input.store.updateThreadState({
                      orgId,
                      actorId,
                      threadId: result.stored.threadId,
                      patch: { addLabels: [...tags] },
                    }),
                  ];
            }),
            ...(parsed === undefined
              ? []
              : [...tenant.forwards.values()].map((forward) =>
                  queueInboundForward(input.store, {
                    orgId,
                    stored: result.stored,
                    parsed,
                    forward,
                    authorize: input.authorizeForward,
                  }),
                )),
          ]);
          return result;
        } catch (error) {
          if (error instanceof MailInboundQuarantinedError) return null;
          throw error;
        }
      };
      return input.runForTenant === undefined ? ingest() : input.runForTenant(orgId, ingest);
    }),
  );
  return results.filter((result): result is IngestRawMailResult => result !== null);
}

export async function ingestRawMail(input: {
  readonly store: MailStore;
  readonly input: IngestRawMailInput;
  readonly authenticator?: MailAuthenticator;
  readonly scanners?: InboundMailScanners;
  readonly quarantineStore?: MailQuarantineStore;
  readonly malwareDisposition?: "spam" | "quarantine" | "reject";
  readonly authenticationPolicy?: InboundAuthenticationPolicy | false;
  readonly threatVerdicts?: InboundThreatVerdicts;
}): Promise<IngestRawMailResult> {
  // P2-6: an `smtp.receive` span covers authentication, parsing, persistence,
  // inbound-filter evaluation, and spam/antivirus scanning for one message.
  return trace
    .getTracer("helix.mail")
    .startActiveSpan(
      "smtp.receive",
      { attributes: { "helix.mail.org_id": input.input.orgId } },
      async (span) => {
        try {
          validateRecipients(input.input);
          // Copy once so parser, scanners, authenticator, and evidence storage observe
          // the same bytes even if a caller retains and mutates its input Buffer.
          const raw = Buffer.from(input.input.raw);
          const canonicalInput = { ...input.input, raw };
          const authenticator = input.authenticator ?? new MailauthAuthenticator();
          const [auth, parsed, scannerResult] = await Promise.all([
            authenticator.authenticate(canonicalInput),
            canonicalInput.parsed === undefined
              ? simpleParser(raw, { maxHtmlLengthToParse: 5 * 1024 * 1024, skipTextToHtml: true })
              : Promise.resolve(canonicalInput.parsed),
            scanInboundMail(input.scanners, raw),
          ]);
          assertParsedMailBounds(parsed);
          if (addressObjectToList(parsed.from).length === 0)
            throw smtpError(550, "Malformed message: a valid From header is required.");
          // Published DMARC and tenant authentication policy are evaluated below.
          const scan = applyInboundSecurityPolicy(scannerResult, auth, parsed, false);
          if (scan.quarantined) {
            const disposition = input.malwareDisposition === "reject" ? "reject" : "quarantine";
            if (disposition === "reject") {
              throw new MailMalwareRejectedError(
                scan.antivirus?.signature ?? scan.quarantineReasons?.join(",") ?? "scanner-policy",
              );
            }
            {
              if (input.quarantineStore === undefined) {
                throw deferredMalwareQuarantine();
              }
              const quarantine = await input.quarantineStore.quarantine({
                orgId: canonicalInput.orgId,
                recipientAddresses: canonicalInput.recipients.map((recipient) => recipient.address),
                raw,
                signature:
                  scan.antivirus?.signature ??
                  scan.quarantineReasons?.join(",") ??
                  "scanner-policy",
                authentication: quarantineAuthentication(auth),
                scanEvidence: scan.antivirus?.evidence ?? {
                  reasons: [...(scan.quarantineReasons ?? [])],
                },
                ...(canonicalInput.envelopeFrom === undefined
                  ? {}
                  : { envelopeFrom: canonicalInput.envelopeFrom }),
                ...(canonicalInput.remoteAddress === undefined
                  ? {}
                  : { remoteAddress: canonicalInput.remoteAddress }),
                ...(canonicalInput.helo === undefined ? {} : { helo: canonicalInput.helo }),
                ...(canonicalInput.providerDeliveryId === undefined
                  ? {}
                  : { providerDeliveryId: canonicalInput.providerDeliveryId }),
              });
              span.setAttribute("helix.mail.quarantine_id", quarantine.id);
              throw new MailInboundQuarantinedError(quarantine.id);
            }
          }
          const fromAddress =
            addressObjectToList(parsed.from)[0]?.address ?? input.input.envelopeFrom ?? "";
          const policy =
            input.authenticationPolicy === false
              ? ({ disposition: "allow", reasons: [] } satisfies InboundPolicyDecision)
              : evaluateInboundAuthenticationPolicy({
                  auth,
                  fromAddress,
                  policy: input.authenticationPolicy ?? parseInboundAuthenticationPolicy(undefined),
                  ...(input.threatVerdicts === undefined ? {} : { threats: input.threatVerdicts }),
                  sample: authenticationSample(raw),
                });
          if (policy.disposition === "reject") {
            throw rejectedAuthenticationPolicy(policy.reasons);
          }
          if (policy.disposition === "quarantine") {
            if (input.quarantineStore === undefined) throw deferredAuthenticationQuarantine();
            const quarantine = await input.quarantineStore.quarantine({
              orgId: canonicalInput.orgId,
              recipientAddresses: canonicalInput.recipients.map((recipient) => recipient.address),
              raw,
              signature: `mail-policy:${policy.reasons.join(",")}`,
              authentication: quarantineAuthentication(auth),
              scanEvidence: compactJsonObject({
                policy: { disposition: policy.disposition, reasons: [...policy.reasons] },
                threats:
                  input.threatVerdicts === undefined
                    ? undefined
                    : compactJsonObject({
                        impersonation: input.threatVerdicts.impersonation,
                        lookalike: input.threatVerdicts.lookalike,
                        url: input.threatVerdicts.url,
                      }),
              }),
              ...(canonicalInput.envelopeFrom === undefined
                ? {}
                : { envelopeFrom: canonicalInput.envelopeFrom }),
              ...(canonicalInput.remoteAddress === undefined
                ? {}
                : { remoteAddress: canonicalInput.remoteAddress }),
              ...(canonicalInput.helo === undefined ? {} : { helo: canonicalInput.helo }),
              ...(canonicalInput.providerDeliveryId === undefined
                ? {}
                : { providerDeliveryId: canonicalInput.providerDeliveryId }),
            });
            span.setAttribute("helix.mail.quarantine_id", quarantine.id);
            throw new MailInboundQuarantinedError(quarantine.id);
          }
          const message = withPolicyMetadata(
            withScanMetadata(
              {
                ...parsedMailToMessage(canonicalInput, parsed, auth),
                rawSource: prepareMailRawSource(raw, parsed),
              },
              scan,
            ),
            policy,
          );
          const stored = await input.store.insertInboundMessage(message);
          const deliveredActorIds = new Set(stored.deliveredActorIds);
          const deliveredRecipients = input.input.recipients.filter((recipient) =>
            deliveredActorIds.has(recipient.actorId),
          );
          span.setAttribute("helix.mail.message_id", stored.messageId);
          span.setAttribute("helix.mail.created", stored.created);
          span.setAttribute("helix.mail.auth_spf", auth.spf);
          span.setAttribute("helix.mail.auth_dmarc", auth.dmarc);
          span.setAttribute("helix.mail.auth_policy", policy.disposition);
          span.setAttribute("helix.mail.spam_routed", scan.routedToSpam);
          const filterResults = await Promise.all(
            deliveredRecipients.map((recipient) =>
              evaluateInboundMail(input.store, {
                message,
                stored,
                recipientActorId: recipient.actorId,
                recipientAddress: recipient.address,
                ...(input.input.receivedAt === undefined ? {} : { now: input.input.receivedAt }),
              }),
            ),
          );
          const filterResult = combineFilterResults(filterResults);
          if (scan.routedToSpam) {
            await Promise.all(
              deliveredRecipients.map((recipient) =>
                input.store.updateThreadState({
                  orgId: input.input.orgId,
                  actorId: recipient.actorId,
                  threadId: stored.threadId,
                  patch: { spamAt: input.input.receivedAt ?? new Date() },
                }),
              ),
            );
          }
          if (scan.routedToSpam && stored.created && input.store.recordSpamFeedback !== undefined) {
            const feedback = autoSpamFeedback(scan);
            for (const recipient of deliveredRecipients)
              await input.store.recordSpamFeedback({
                orgId: input.input.orgId,
                actorId: recipient.actorId,
                threadId: stored.threadId,
                label: "spam",
                source: feedback.source,
                evidence: feedback.evidence,
              });
          }
          return { stored, auth, filterResult, scan, policy };
        } catch (error) {
          if (!(error instanceof MailInboundQuarantinedError)) {
            span.recordException(error instanceof Error ? error : new Error(String(error)));
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          throw error;
        } finally {
          span.end();
        }
      },
    );
}

class MailInboundQuarantinedError extends Error {
  constructor(readonly quarantineId: string) {
    super("Inbound mail accepted into quarantine.");
    this.name = "MailInboundQuarantinedError";
    this.name = "MailInboundQuarantinedError";
  }
}

function deferredMalwareQuarantine(): Error {
  const error = new Error("Mail quarantine is unavailable; delivery deferred.") as Error & {
    responseCode: number;
  };
  error.responseCode = 451;
  return error;
}

function deferredAuthenticationQuarantine(): Error {
  const error = new Error(
    "Mail authentication quarantine is unavailable; delivery deferred.",
  ) as Error & {
    responseCode: number;
  };
  error.responseCode = 451;
  return error;
}

function rejectedAuthenticationPolicy(reasons: readonly string[]): Error {
  return Object.assign(
    new Error(`Inbound mail rejected by authentication policy: ${reasons.join(", ")}`),
    {
      responseCode: 550,
    },
  );
}

function authenticationSample(raw: Buffer): number {
  return createHash("sha256").update(raw).digest().readUInt32BE(0) % 100;
}

function quarantineAuthentication(auth: MailAuthenticationSummary): JsonObject {
  return {
    spf: auth.spf,
    dkim: auth.dkim,
    dmarc: auth.dmarc,
    arc: auth.arc,
    ...(auth.evidence === undefined ? {} : { evidence: auth.evidence }),
  };
}

function parsedMailToMessage(
  input: IngestRawMailInput,
  parsed: ParsedMail,
  auth: MailAuthenticationSummary,
): MailMessageInput {
  const visibleRecipients = new Set(
    input.recipients.map((recipient) => recipient.address.toLowerCase()),
  );
  const to = addressObjectToList(parsed.to).filter((recipient) =>
    visibleRecipients.has(recipient.address.toLowerCase()),
  );

  return {
    orgId: input.orgId,
    actorId: null,
    mailboxActorIds: input.recipients.map((recipient) => recipient.actorId),
    from: addressObjectToList(parsed.from)[0] ?? {
      address: input.envelopeFrom ?? "unknown@localhost",
    },
    to,
    cc: addressObjectToList(parsed.cc).filter((recipient) =>
      visibleRecipients.has(recipient.address.toLowerCase()),
    ),
    bcc: [],
    subject: sanitizeMailHeaderDisplayValue(parsed.subject ?? ""),
    bodyText: parsed.text ?? "",
    ...(typeof parsed.html === "string" ? { bodyHtml: sanitizeMailHtml(parsed.html).html } : {}),
    messageId: parsed.messageId,
    ...(input.providerDeliveryId === undefined
      ? {}
      : { providerDeliveryId: input.providerDeliveryId }),
    inReplyTo: parsed.inReplyTo,
    references: Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references === undefined
        ? []
        : [parsed.references],
    receivedAt: input.receivedAt ?? new Date(),
    attachments: parsedAttachments(parsed),
    metadata: {
      direction: "inbound",
      auth: { ...auth },
      envelopeFrom: input.envelopeFrom ?? null,
    },
  };
}

function parsedAttachments(parsed: ParsedMail): readonly MailAttachmentInput[] {
  return parsed.attachments.map((attachment) => ({
    filename: attachment.filename,
    mimeType: attachment.contentType,
    content: attachment.content,
    contentId: attachment.cid,
    disposition: attachment.contentDisposition,
  }));
}

function validateRecipients(input: IngestRawMailInput): void {
  if (
    input.recipients.length === 0 ||
    input.recipients.some((recipient) => recipient.orgId !== input.orgId)
  ) {
    throw new Error("Inbound mail requires at least one recipient in its organization.");
  }
}

function combineFilterResults(
  results: readonly MailFilterEvaluationResult[],
): MailFilterEvaluationResult {
  return {
    matchedFilterIds: [...new Set(results.flatMap((result) => result.matchedFilterIds))],
    vacationQueued: results.some((result) => result.vacationQueued),
  };
}

/**
 * Run the configured inbound spam + antivirus scanners over the raw message.
 *
 * `deliver` is an explicit best-effort policy. `defer` fails before persistence
 * when either scanner is missing, unavailable, or reports an incomplete scan.
 */
export async function scanInboundMail(
  scanners: InboundMailScanners | undefined,
  raw: Buffer | string,
): Promise<InboundScanResult> {
  if (scanners === undefined) {
    return {
      spam: null,
      antivirus: null,
      routedToSpam: false,
      quarantined: false,
      spamReason: null,
    };
  }
  const tier = scanners.tier ?? "personal";
  const [spamOutcome, antivirusOutcome] = await Promise.all([
    runScan(scanners.spam, raw),
    runScan(scanners.antivirus, raw),
  ]);
  if (scanners.spam === undefined || spamOutcome.failed)
    handleUnavailable(scanners, "spam", new Error("Spam scanner unavailable"));
  if (
    scanners.antivirus === undefined ||
    antivirusOutcome.failed ||
    antivirusOutcome.result?.scanned === false
  )
    handleUnavailable(scanners, "antivirus", new Error("Antivirus scanner unavailable"));
  const spam = spamOutcome.result;
  const antivirus = antivirusOutcome.result;
  const virusRouted = antivirus !== null && antivirus.infected;
  const spamScannerUnavailable = scanners.spam === undefined || spamOutcome.failed;
  const antivirusScannerUnavailable =
    scanners.antivirus === undefined || antivirusOutcome.failed || antivirus?.scanned === false;
  const scannerUnavailable = spamScannerUnavailable || antivirusScannerUnavailable;
  const policyQuarantined =
    virusRouted ||
    antivirus?.disposition === "quarantine" ||
    (tier !== "personal" && scannerUnavailable);
  // Layer 1: SpamAssassin. If it says spam, do not run AI.
  const spamdIsSpam = spam !== null && spam.isSpam;
  let spamRouted = spamdIsSpam;
  let spamCatcher: SpamCatcher = null;
  let spamReason: InboundScanResult["spamReason"] = null;
  if (virusRouted) {
    spamCatcher = "virus";
    spamReason = "virus";
  } else if (policyQuarantined) {
    spamCatcher = "scanner-policy";
    spamReason = "scanner-policy";
  } else if (spamdIsSpam) {
    spamCatcher = "spamd";
    spamReason = "spam-score";
  }

  // Layer 2: beta AI spam tool — only when spamd passed (not spam) and not quarantined.
  // Fail-open: never block SMTP accept on LLM/rules errors.
  let betaEvidence: JsonObject | null = null;
  const spamdPassed =
    spam !== null && !spamOutcome.failed && !spamdIsSpam && !virusRouted && !policyQuarantined;
  if (scanners.betaSpamSecondPass !== undefined && spamdPassed) {
    try {
      const features = extractSpamFeaturesFromRaw(raw, spam);
      const decision = await scanners.betaSpamSecondPass(features);
      // null = beta disabled at call time (Admin/env may flip after boot).
      if (decision !== null) {
        betaEvidence = decision.evidence;
        if (decision.isSpam) {
          spamRouted = true;
          spamReason = "spam-score";
          const src = (decision.evidence as { source?: string }).source ?? "ai";
          spamCatcher = src === "rules" ? "rules" : "ai";
        }
      }
    } catch {
      betaEvidence = { beta: true, failed: true, layer: "ai-after-spamd-pass" };
    }
  }

  const spamWithBeta: SpamScanResult | null =
    spam === null && betaEvidence === null
      ? null
      : {
          score: spam?.score ?? 0,
          thresholdReportedBySpamd: spam?.thresholdReportedBySpamd ?? null,
          isSpam: spamRouted && !virusRouted && !policyQuarantined,
          symbols: spam?.symbols ?? [],
          evidence: {
            ...(spam?.evidence ?? {}),
            layering: "spamd_then_ai_if_pass",
            spamdPassed,
            ...(betaEvidence === null ? {} : { betaSecondPass: betaEvidence }),
            ...(spamCatcher === null ? {} : { catcher: spamCatcher }),
          },
        };

  return {
    spam: spamWithBeta,
    antivirus,
    routedToSpam: virusRouted || policyQuarantined || spamRouted,
    quarantined: policyQuarantined,
    quarantineReasons: policyQuarantined ? [quarantineReason(virusRouted, scannerUnavailable)] : [],
    scannerUnavailable,
    spamReason,
    spamCatcher,
  };
}

async function runScan<T>(
  scanner: { scan(raw: Buffer | string): Promise<T> } | undefined,
  raw: Buffer | string,
): Promise<{ readonly result: T | null; readonly failed: boolean }> {
  if (scanner === undefined) {
    return { result: null, failed: false };
  }
  try {
    return { result: await scanner.scan(raw), failed: false };
  } catch {
    return { result: null, failed: true };
  }
}

function handleUnavailable(
  scanners: InboundMailScanners,
  scanner: "spam" | "antivirus",
  error: unknown,
): void {
  const policy = scanners.failurePolicy ?? "deliver";
  try {
    scanners.onUnavailable?.({ scanner, policy, error });
  } catch {
    // Alerting must not change the configured delivery decision.
  }
  if (policy === "defer") {
    const deferred = new Error(
      `Inbound ${scanner} scanning is unavailable; delivery deferred.`,
    ) as Error & { responseCode: number };
    deferred.responseCode = 451;
    throw deferred;
  }
}

/** Merge spam + antivirus scan evidence into the stored message metadata. */
function withScanMetadata(message: MailMessageInput, scan: InboundScanResult): MailMessageInput {
  if (scan.spam === null && scan.antivirus === null && !scan.routedToSpam) {
    return message;
  }
  return {
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      spam: {
        routedToSpam: scan.routedToSpam,
        quarantined: scan.quarantined,
        reason: scan.spamReason,
        catcher: scan.spamCatcher ?? null,
        ...(scan.spam === null
          ? {}
          : {
              score: scan.spam.score,
              isSpam: scan.spam.isSpam,
              symbols: [...scan.spam.symbols],
              scan: scan.spam.evidence,
            }),
        ...(scan.antivirus === null
          ? {}
          : {
              antivirus: {
                infected: scan.antivirus.infected,
                signature: scan.antivirus.signature,
                scanned: scan.antivirus.scanned,
                disposition: scan.antivirus.disposition ?? null,
                state: scan.antivirus.securityScan?.state ?? null,
                scan: scan.antivirus.evidence,
              },
            }),
      },
    },
  };
}

function withPolicyMetadata(
  message: MailMessageInput,
  policy: InboundPolicyDecision,
): MailMessageInput {
  if (policy.disposition === "allow") return message;
  return {
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      inboundPolicy: { disposition: policy.disposition, reasons: [...policy.reasons] },
    },
  };
}

export function summarizeAuthentication(result: AuthenticateResult): MailAuthenticationSummary {
  return {
    spf: result.spf === false ? "none" : result.spf.status.result,
    dkim: result.dkim.results.some((item) => item.status.result === "pass")
      ? "pass"
      : (result.dkim.results[0]?.status.result ?? "none"),
    dmarc: result.dmarc === false ? "none" : result.dmarc.status.result,
    arc: result.arc === false ? "none" : result.arc.status.result,
    headers: result.headers,
    evidence: compactJsonObject({
      spf:
        result.spf === false
          ? { result: "none" }
          : compactJsonObject({
              result: result.spf.status.result,
              domain: result.spf.domain,
              clientIp: result.spf["client-ip"],
              envelopeFrom: result.spf["envelope-from"],
              helo: result.spf.helo,
              record: result.spf.rr,
              header: result.spf.header,
              comment: result.spf.status.comment,
              policy: authPolicyEvidence(result.spf.status),
              lookups:
                result.spf.lookups === undefined
                  ? undefined
                  : compactJsonObject({
                      limit: result.spf.lookups.limit,
                      count: result.spf.lookups.count,
                      void: result.spf.lookups.void,
                    }),
            }),
      dkim: compactJsonObject({
        result: result.dkim.results.some((item) => item.status.result === "pass")
          ? "pass"
          : (result.dkim.results[0]?.status.result ?? "none"),
        headerFrom: result.dkim.headerFrom,
        envelopeFrom: result.dkim.envelopeFrom === false ? null : result.dkim.envelopeFrom,
        signatures: result.dkim.results.map((item) =>
          compactJsonObject({
            result: item.status.result,
            signingDomain: item.signingDomain,
            selector: item.selector,
            aligned: item.status.aligned === undefined ? undefined : item.status.aligned !== false,
            underSized: item.status.underSized,
            algorithm: item.algorithm,
            canonicalization: item.canonicalization,
            signingTime: item.signingTime?.toISOString(),
            expiration: item.expiration?.toISOString(),
            comment: item.status.comment,
            policy: authPolicyEvidence(item.status),
          }),
        ),
      }),
      dmarc:
        result.dmarc === false
          ? { result: "none" }
          : compactJsonObject({
              result: result.dmarc.status.result,
              domain: result.dmarc.domain,
              policy: result.dmarc.policy,
              organizationalPolicy: result.dmarc.p,
              subdomainPolicy: result.dmarc.sp,
              pct: result.dmarc.pct,
              record: result.dmarc.rr,
              comment: result.dmarc.status.comment,
              error: result.dmarc.error,
              alignment: compactJsonObject({
                spf: compactJsonObject({
                  result: result.dmarc.alignment.spf.result ?? null,
                  strict: result.dmarc.alignment.spf.strict,
                }),
                dkim: compactJsonObject({
                  result: result.dmarc.alignment.dkim.result ?? null,
                  strict: result.dmarc.alignment.dkim.strict,
                  underSized: result.dmarc.alignment.dkim.underSized,
                }),
              }),
            }),
    }),
  };
}

function authPolicyEvidence(status: AuthStatus): JsonObject | undefined {
  return status.policy === undefined ? undefined : compactJsonObject(status.policy);
}

export function addressObjectToList(
  value: AddressObject | AddressObject[] | undefined,
): MailAddress[] {
  const objects = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return objects
    .flatMap((object) =>
      object.value.map((address) => ({
        address: address.address ?? "",
        ...(address.name === "" ? {} : { name: sanitizeMailHeaderDisplayValue(address.name, 320) }),
      })),
    )
    .filter((address) => address.address.length > 0);
}

export async function spoolStream(
  stream: SMTPServerDataStream,
  options: { readonly maxBytes: number; readonly timeoutMs: number },
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "helix-smtp-"));
  const path = join(directory, "message.eml");
  const file = await openFile(path, "wx", 0o600);
  const timeout = setTimeout(() => {
    stream.destroy(smtpDataError(451, "Message transfer timed out."));
  }, options.timeoutMs);
  timeout.unref();
  try {
    let byteSize = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += bytes.byteLength;
      if (byteSize > options.maxBytes || stream.sizeExceeded) {
        throw smtpDataError(552, "Message exceeds the maximum accepted size.");
      }
      await file.write(bytes);
    }
    await file.close();
    return await readFile(path);
  } finally {
    clearTimeout(timeout);
    await file.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

export function assertParsedMailBounds(parsed: ParsedMail): void {
  if (parsed.attachments.length > 100) {
    throw smtpDataError(552, "Message has too many MIME attachments.");
  }
  if (parsed.attachments.some((attachment) => attachment.size > 26_214_400)) {
    throw smtpDataError(552, "A MIME attachment exceeds the maximum accepted size.");
  }
}

function smtpDataError(responseCode: 451 | 552, message: string): Error {
  return Object.assign(new Error(message), { responseCode });
}

function rejectedRecipient(address: string): Error {
  return Object.assign(new Error(`Mailbox unavailable: ${address}`), { responseCode: 550 });
}

export type { SMTPServerSession };

type SpamCatcher = "spamd" | "ai" | "rules" | "virus" | "scanner-policy" | "auth-failure" | null;

export interface SmtpReceiverLimits {
  readonly maxMessageBytes: number;
  readonly maxRecipientsPerMessage: number;
  readonly maxMessagesPerConnection: number;
  readonly maxCommandsPerConnection: number;
  readonly maxConcurrentConnections: number;
  readonly maxConcurrentConnectionsPerIp: number;
  readonly connectionsPerWindow: number;
  readonly connectionWindowMs: number;
  readonly messagesPerWindow: number;
  readonly messageWindowMs: number;
  readonly recipientResolutionTimeoutMs: number;
  readonly socketTimeoutMs: number;
}

interface SmtpSessionState {
  commands: number;
  messageAttempts: number;
  connected: boolean;
  envelopeFrom?: string | undefined;
  readonly recipients: Map<string, MailInboundRecipientResolution>;
}

function resolveSmtpReceiverLimits(
  configured: Partial<SmtpReceiverLimits> | undefined,
): SmtpReceiverLimits {
  const limits = { ...DEFAULT_SMTP_RECEIVER_LIMITS, ...configured };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function smtpError(responseCode: number, message: string): Error {
  return Object.assign(new Error(message), { responseCode });
}

function asSmtpError(error: unknown, fallbackCode: number, fallbackMessage: string): Error {
  if (
    error instanceof Error &&
    "responseCode" in error &&
    typeof (error as { readonly responseCode?: unknown }).responseCode === "number"
  ) {
    return error;
  }
  return smtpError(fallbackCode, fallbackMessage);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          reject(new Error("SMTP recipient resolution timed out."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

function quarantineReason(virusRouted: boolean, scannerUnavailable: boolean): string {
  if (virusRouted) return "malware";
  return scannerUnavailable ? "scanner_unavailable" : "scanner_policy";
}

function extractSpamFeaturesFromRaw(
  raw: Buffer | string,
  spam: SpamScanResult | null,
): {
  readonly subject: string;
  readonly bodyText: string;
  readonly fromAddress: string;
  readonly spamdScore?: number | undefined;
  readonly spamdIsSpam?: boolean | undefined;
} {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  const subject = (/^subject:\s*(.+)$/imu.exec(text)?.[1] ?? "").trim();
  const fromAddress = (/^from:\s*(.+)$/imu.exec(text)?.[1] ?? "").trim();
  const bodySplit = text.split(/\r?\n\r?\n/u);
  const bodyText = bodySplit.slice(1).join("\n\n").slice(0, 8_000);
  return {
    subject,
    bodyText,
    fromAddress,
    ...(spam === null ? {} : { spamdScore: spam.score, spamdIsSpam: spam.isSpam }),
  };
}

function applyInboundSecurityPolicy(
  scan: InboundScanResult,
  auth: MailAuthenticationSummary,
  parsed: ParsedMail,
  evaluateAuthentication = true,
): InboundScanResult {
  const attachmentPolicy = inspectInboundAttachments(parsed.attachments);
  const authFailed =
    evaluateAuthentication &&
    (auth.dmarc === "fail" ||
      ((auth.spf === "fail" || auth.spf === "softfail") &&
        (auth.dkim === "fail" || auth.dkim === "none")));
  const quarantineReasons = new Set(scan.quarantineReasons ?? []);
  for (const reason of attachmentPolicy.reasons) quarantineReasons.add(reason);
  const routedToSpam = scan.routedToSpam || authFailed || attachmentPolicy.quarantine;
  let spamCatcher: SpamCatcher = scan.spamCatcher ?? null;
  let policyReason: InboundScanResult["spamReason"] = null;
  if (attachmentPolicy.quarantine) {
    spamCatcher ??= "scanner-policy";
    policyReason = "scanner-policy";
  } else if (authFailed) {
    if (!scan.routedToSpam) spamCatcher = "auth-failure";
    policyReason = "auth-failure";
  }
  return {
    ...scan,
    routedToSpam,
    quarantined: scan.quarantined || attachmentPolicy.quarantine,
    spamReason: scan.spamReason ?? policyReason,
    spamCatcher,
    quarantineReasons: [...quarantineReasons],
  };
}

function autoSpamFeedback(scan: InboundScanResult): {
  readonly source: "auto_ai" | "auto_rules" | "auto_spamd";
  readonly evidence: JsonObject;
} {
  const catcher = scan.spamCatcher ?? null;
  let source: "auto_ai" | "auto_rules" | "auto_spamd" = "auto_spamd";
  if (catcher === "ai") source = "auto_ai";
  else if (catcher === "rules") source = "auto_rules";
  return {
    source,
    evidence: {
      catcher,
      reason: scan.spamReason,
      layering: "spamd_then_ai_if_pass",
    },
  };
}
const DEFAULT_SMTP_RECEIVER_LIMITS: SmtpReceiverLimits = {
  maxMessageBytes: 25 * 1024 * 1024,
  maxRecipientsPerMessage: 100,
  maxMessagesPerConnection: 20,
  maxCommandsPerConnection: 500,
  maxConcurrentConnections: 250,
  maxConcurrentConnectionsPerIp: 20,
  connectionsPerWindow: 60,
  connectionWindowMs: 60_000,
  messagesPerWindow: 120,
  messageWindowMs: 60_000,
  recipientResolutionTimeoutMs: 5_000,
  socketTimeoutMs: 60_000,
};
