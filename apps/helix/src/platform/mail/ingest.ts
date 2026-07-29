import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { authenticate, type AuthStatus, type AuthenticateResult } from "mailauth";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { JsonObject, JsonValue, SecurityTier } from "@helix/sdk-types";
import type {
  MailAddress,
  MailAttachmentInput,
  MailMessageInput,
  StoredMailMessage,
} from "./types.js";
import type {
  IdempotentStoredMailMessage,
  MailInboundResolvedRecipient,
  MailStore,
  RecipientAwareMailStore,
} from "./store.js";
import { evaluateInboundMail, type MailFilterEvaluationResult } from "./filters.js";
import type { SpamScanner, SpamScanResult } from "./spam.js";
import type { AntivirusScanner, AntivirusScanResult } from "./antivirus.js";
import { normalizeMailboxAddress, MailAddressNormalizationError } from "./address-normalization.js";
import { createInboundDeliveryDedup } from "./inbound-dedup.js";
import type { SmtpRecipientResolver, SmtpResolvedRecipient } from "./smtp-recipient-resolver.js";
import { InMemorySmtpRateLimitStore, type SmtpRateLimitStore } from "./smtp-rate-limit.js";
import {
  smtpDisabledCommands,
  smtpTransportSecurityOptions,
  type SmtpTransportSecurity,
} from "./smtp-transport-security.js";
import {
  inspectInboundAttachments,
  sanitizeMailHeaderDisplayValue,
  sanitizeMailHtml,
} from "./content-safety.js";
import type { MailQuarantineRecord, MailQuarantineStore } from "./quarantine.js";

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
  readonly raw: Buffer | string;
  readonly envelopeFrom?: string;
  readonly envelopeTo: readonly string[];
  readonly remoteAddress?: string;
  readonly helo?: string;
  readonly receivedAt?: Date;
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
  readonly quarantineReasons?: readonly string[];
  readonly scannerUnavailable?: boolean;
}

export interface IngestRawMailResult {
  readonly stored: StoredMailMessage;
  readonly auth: MailAuthenticationSummary;
  readonly filterResult: MailFilterEvaluationResult;
  readonly scan: InboundScanResult;
}

export interface ResolvedInboundDeliveryResult {
  readonly orgId: string;
  readonly recipients: readonly string[];
  readonly stored: IdempotentStoredMailMessage;
  readonly filterResults: readonly {
    readonly actorId: string;
    readonly result: MailFilterEvaluationResult;
  }[];
}

export interface IngestResolvedRawMailResult {
  readonly deliveries: readonly ResolvedInboundDeliveryResult[];
  readonly auth: MailAuthenticationSummary;
  readonly scan: InboundScanResult;
  readonly quarantines?: readonly MailQuarantineRecord[];
}

/**
 * Optional inbound content scanners. Personal mode may record an unavailable
 * scanner as unscanned. Business and higher tiers fail closed into quarantine.
 */
export interface InboundMailScanners {
  readonly spam?: SpamScanner | undefined;
  readonly antivirus?: AntivirusScanner | undefined;
  /** Business and higher tiers fail closed when no clean antivirus verdict exists. */
  readonly tier?: SecurityTier;
}

export interface MailAuthenticator {
  authenticate(input: IngestRawMailInput): Promise<MailAuthenticationSummary>;
}

export interface SmtpReceiverOptions {
  readonly store: RecipientAwareMailStore;
  readonly recipientResolver: SmtpRecipientResolver;
  readonly authenticator?: MailAuthenticator;
  readonly disabledCommands?: readonly string[];
  readonly logger?: { error(error: unknown, message?: string): void };
  /** Optional inbound spam + antivirus scanners (config-gated in server.ts). */
  readonly scanners?: InboundMailScanners | undefined;
  readonly quarantineStore?: MailQuarantineStore | undefined;
  readonly transportSecurity: SmtpTransportSecurity;
  readonly limits?: Partial<SmtpReceiverLimits> | undefined;
  readonly rateLimitStore?: SmtpRateLimitStore | undefined;
}

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

interface SmtpSessionState {
  commands: number;
  messageAttempts: number;
  connected: boolean;
  envelopeFrom?: string | undefined;
  readonly recipients: Map<string, SmtpResolvedRecipient>;
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
    this.limits = resolveSmtpReceiverLimits(options.limits);
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
    let recipient: SmtpResolvedRecipient | null;
    try {
      recipient = await withTimeout(
        this.options.recipientResolver.resolveRecipient(normalized),
        this.limits.recipientResolutionTimeoutMs,
      );
    } catch {
      throw smtpError(451, "Recipient lookup temporarily unavailable.");
    }
    if (recipient === null) {
      throw smtpError(550, "Unknown recipient domain or mailbox.");
    }
    if (recipient.normalizedAddress !== normalized) {
      throw smtpError(451, "Recipient resolver returned inconsistent data.");
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
    const raw = await collectStream(stream, this.limits.maxMessageBytes);
    await ingestResolvedRawMail({
      store: this.options.store,
      ...(this.options.authenticator === undefined
        ? {}
        : { authenticator: this.options.authenticator }),
      ...(this.options.scanners === undefined ? {} : { scanners: this.options.scanners }),
      ...(this.options.quarantineStore === undefined
        ? {}
        : { quarantineStore: this.options.quarantineStore }),
      input: {
        raw,
        recipients: [...state.recipients.values()],
        ...(state.envelopeFrom === undefined ? {} : { envelopeFrom: state.envelopeFrom }),
        remoteAddress: session.remoteAddress,
        helo: session.hostNameAppearsAs,
      },
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

export async function ingestResolvedRawMail(input: {
  readonly store: RecipientAwareMailStore;
  readonly input: {
    readonly raw: Buffer | string;
    readonly recipients: readonly SmtpResolvedRecipient[];
    readonly envelopeFrom?: string | undefined;
    readonly remoteAddress?: string | undefined;
    readonly helo?: string | undefined;
    readonly receivedAt?: Date | undefined;
  };
  readonly authenticator?: MailAuthenticator;
  readonly scanners?: InboundMailScanners;
  readonly quarantineStore?: MailQuarantineStore;
}): Promise<IngestResolvedRawMailResult> {
  if (input.input.recipients.length === 0) {
    throw new TypeError("Resolved mail ingest requires at least one recipient.");
  }
  const receivedAt = input.input.receivedAt ?? new Date();
  const firstOrgId = input.input.recipients[0]?.orgId;
  if (firstOrgId === undefined) {
    throw new TypeError("Resolved mail ingest requires a recipient organization.");
  }

  return trace.getTracer("helix.mail").startActiveSpan("smtp.receive", async (span) => {
    try {
      const authenticator = input.authenticator ?? new MailauthAuthenticator();
      const authInput: IngestRawMailInput = {
        orgId: firstOrgId,
        raw: input.input.raw,
        envelopeTo: input.input.recipients.map((recipient) => recipient.normalizedAddress),
        ...(input.input.envelopeFrom === undefined
          ? {}
          : { envelopeFrom: input.input.envelopeFrom }),
        ...(input.input.remoteAddress === undefined
          ? {}
          : { remoteAddress: input.input.remoteAddress }),
        ...(input.input.helo === undefined ? {} : { helo: input.input.helo }),
        receivedAt,
      };
      const [auth, parsed, baseScan] = await Promise.all([
        authenticator.authenticate(authInput),
        simpleParser(input.input.raw),
        scanInboundMail(input.scanners, input.input.raw),
      ]);
      assertParsedInboundMessage(parsed);
      const scan = applyInboundSecurityPolicy(baseScan, auth, parsed);
      const groups = groupRecipientsByOrg(input.input.recipients);
      span.setAttribute("helix.mail.recipient_org_count", groups.size);
      span.setAttribute("helix.mail.recipient_count", input.input.recipients.length);
      span.setAttribute("helix.mail.auth_spf", auth.spf);
      span.setAttribute("helix.mail.auth_dmarc", auth.dmarc);
      span.setAttribute("helix.mail.spam_routed", scan.routedToSpam);

      const deliveries: ResolvedInboundDeliveryResult[] = [];
      if (scan.quarantined) {
        if (input.quarantineStore === undefined) {
          throw new MailQuarantinePersistenceRequiredError();
        }
        const quarantines: MailQuarantineRecord[] = [];
        for (const [orgId, recipients] of groups) {
          const dedup = createInboundDeliveryDedup({
            orgId,
            raw: input.input.raw,
            messageId: parsed.messageId,
            ...(input.input.envelopeFrom === undefined
              ? {}
              : { envelopeFrom: input.input.envelopeFrom }),
            envelopeTo: recipients.map((recipient) => recipient.normalizedAddress),
            receivedAt,
          });
          const result = await input.quarantineStore.quarantine({
            orgId,
            dedupKey: dedup.key,
            envelopeFrom: input.input.envelopeFrom ?? null,
            envelopeTo: recipients.map((recipient) => recipient.normalizedAddress),
            subject: sanitizeMailHeaderDisplayValue(parsed.subject ?? ""),
            reasons: scan.quarantineReasons ?? ["scanner_policy"],
            authEvidence: authenticationEvidence(auth),
            scanEvidence: scanEvidence(scan),
            rawMessage: Buffer.isBuffer(input.input.raw)
              ? input.input.raw
              : Buffer.from(input.input.raw),
          });
          quarantines.push(result.record);
        }
        span.setAttribute("helix.mail.quarantined", true);
        return { deliveries, auth, scan, quarantines };
      }
      for (const [orgId, recipients] of groups) {
        const dedup = createInboundDeliveryDedup({
          orgId,
          raw: input.input.raw,
          messageId: parsed.messageId,
          ...(input.input.envelopeFrom === undefined
            ? {}
            : { envelopeFrom: input.input.envelopeFrom }),
          envelopeTo: recipients.map((recipient) => recipient.normalizedAddress),
          receivedAt,
        });
        const message = withScanMetadata(
          parsedMailToResolvedMessage({
            orgId,
            parsed,
            auth,
            scan,
            recipients,
            dedupKey: dedup.key,
            envelopeFrom: input.input.envelopeFrom,
            receivedAt,
          }),
          scan,
        );
        const storeRecipients: MailInboundResolvedRecipient[] = recipients.map((recipient) => ({
          actorId: recipient.actorId,
          address: recipient.normalizedAddress,
          match: recipient.match,
        }));
        const stored = await input.store.insertInboundMessageIdempotent({
          message,
          dedup,
          recipients: storeRecipients,
        });
        const filterResults: {
          readonly actorId: string;
          readonly result: MailFilterEvaluationResult;
        }[] = [];
        // A retry after the final 250 was lost must not repeat vacation/filter
        // side effects for a delivery the durable store already committed.
        if (!stored.duplicate) {
          for (const actorId of new Set(recipients.map((recipient) => recipient.actorId))) {
            const result = await evaluateInboundMail(input.store, {
              message,
              stored,
              recipientActorId: actorId,
              now: receivedAt,
            });
            filterResults.push({ actorId, result });
            if (scan.routedToSpam) {
              await input.store.updateThreadState({
                orgId,
                actorId,
                threadId: stored.threadId,
                patch: { spamAt: receivedAt },
              });
            }
          }
        }
        deliveries.push({
          orgId,
          recipients: recipients.map((recipient) => recipient.normalizedAddress),
          stored,
          filterResults,
        });
      }
      return { deliveries, auth, scan };
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

function assertParsedInboundMessage(parsed: ParsedMail): void {
  if (addressObjectToList(parsed.from).length === 0) {
    throw smtpError(550, "Malformed message: a valid From header is required.");
  }
}

export async function ingestRawMail(input: {
  readonly store: MailStore;
  readonly input: IngestRawMailInput;
  readonly authenticator?: MailAuthenticator;
  readonly scanners?: InboundMailScanners;
  readonly quarantineStore?: MailQuarantineStore;
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
          const authenticator = input.authenticator ?? new MailauthAuthenticator();
          const [auth, parsed, baseScan] = await Promise.all([
            authenticator.authenticate(input.input),
            simpleParser(input.input.raw),
            scanInboundMail(input.scanners, input.input.raw),
          ]);
          const scan = applyInboundSecurityPolicy(baseScan, auth, parsed);
          if (scan.quarantined) {
            if (input.quarantineStore === undefined) {
              throw new MailQuarantinePersistenceRequiredError();
            }
            const dedup = createInboundDeliveryDedup({
              orgId: input.input.orgId,
              raw: input.input.raw,
              messageId: parsed.messageId,
              envelopeFrom: input.input.envelopeFrom,
              envelopeTo: input.input.envelopeTo,
              receivedAt: input.input.receivedAt ?? new Date(),
            });
            const quarantined = await input.quarantineStore.quarantine({
              orgId: input.input.orgId,
              dedupKey: dedup.key,
              envelopeFrom: input.input.envelopeFrom ?? null,
              envelopeTo: input.input.envelopeTo,
              subject: sanitizeMailHeaderDisplayValue(parsed.subject ?? ""),
              reasons: scan.quarantineReasons ?? ["scanner_policy"],
              authEvidence: authenticationEvidence(auth),
              scanEvidence: scanEvidence(scan),
              rawMessage: Buffer.isBuffer(input.input.raw)
                ? input.input.raw
                : Buffer.from(input.input.raw),
            });
            throw new MailInboundQuarantinedError(quarantined.record.id);
          }
          const message = withScanMetadata(
            await parsedMailToMessage(input.store, input.input, parsed, auth),
            scan,
          );
          const stored = await input.store.insertInboundMessage(message);
          span.setAttribute("helix.mail.message_id", stored.messageId);
          span.setAttribute("helix.mail.auth_spf", auth.spf);
          span.setAttribute("helix.mail.auth_dmarc", auth.dmarc);
          span.setAttribute("helix.mail.spam_routed", scan.routedToSpam);
          const filterResult = await evaluateInboundMail(input.store, {
            message,
            stored,
            ...(message.actorId === undefined ? {} : { recipientActorId: message.actorId }),
            ...(input.input.receivedAt === undefined ? {} : { now: input.input.receivedAt }),
          });
          // Route a spam/virus-flagged message to the recipient's Spam folder.
          // Best-effort: a routed message that has no resolved actor (unknown
          // recipient) is left unrouted — there is no per-actor folder to file it
          // into.
          if (scan.routedToSpam && message.actorId != null) {
            await input.store.updateThreadState({
              orgId: input.input.orgId,
              actorId: message.actorId,
              threadId: stored.threadId,
              patch: { spamAt: input.input.receivedAt ?? new Date() },
            });
          }
          return { stored, auth, filterResult, scan };
        } catch (error) {
          span.recordException(error instanceof Error ? error : new Error(String(error)));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
}

function parsedMailToResolvedMessage(input: {
  readonly orgId: string;
  readonly parsed: ParsedMail;
  readonly auth: MailAuthenticationSummary;
  readonly scan: InboundScanResult;
  readonly recipients: readonly SmtpResolvedRecipient[];
  readonly dedupKey: string;
  readonly envelopeFrom?: string | undefined;
  readonly receivedAt: Date;
}): MailMessageInput {
  const primaryRecipient = input.recipients[0];
  if (primaryRecipient === undefined) {
    throw new TypeError("Tenant delivery requires at least one recipient.");
  }
  const tenantAddresses = input.recipients.map((recipient) => ({
    address: recipient.normalizedAddress,
  }));
  return {
    orgId: input.orgId,
    actorId: primaryRecipient.actorId,
    from: sanitizeMailAddress(addressObjectToList(input.parsed.from)[0]) ?? {
      address: input.envelopeFrom ?? "unknown@localhost",
    },
    // Deliberately project only this tenant's accepted envelope recipients.
    // Parsed To/Cc/Bcc may contain recipients belonging to another tenant.
    to: tenantAddresses,
    cc: [],
    bcc: [],
    subject: sanitizeMailHeaderDisplayValue(input.parsed.subject ?? ""),
    bodyText: input.parsed.text ?? "",
    ...(typeof input.parsed.html === "string"
      ? { bodyHtml: sanitizeMailHtml(input.parsed.html).html }
      : {}),
    messageId: input.parsed.messageId,
    inReplyTo: input.parsed.inReplyTo,
    references: Array.isArray(input.parsed.references)
      ? input.parsed.references
      : input.parsed.references === undefined
        ? []
        : [input.parsed.references],
    receivedAt: input.receivedAt,
    attachments: input.parsed.attachments.map(
      (attachment): MailAttachmentInput => ({
        filename: attachment.filename,
        mimeType: attachment.contentType,
        content: attachment.content,
        contentId: attachment.cid,
        disposition: attachment.contentDisposition,
      }),
    ),
    metadata: {
      direction: "inbound",
      auth: { ...input.auth },
      envelopeFrom: input.envelopeFrom ?? null,
      envelopeTo: input.recipients.map((recipient) => recipient.normalizedAddress),
      recipientActorIds: [...new Set(input.recipients.map((recipient) => recipient.actorId))],
      inboundDedupKey: input.dedupKey,
      quarantined: input.scan.quarantined,
      remoteImagesBlocked:
        typeof input.parsed.html === "string"
          ? sanitizeMailHtml(input.parsed.html).remoteImagesBlocked
          : 0,
    },
  };
}

function groupRecipientsByOrg(
  recipients: readonly SmtpResolvedRecipient[],
): Map<string, SmtpResolvedRecipient[]> {
  const groups = new Map<string, SmtpResolvedRecipient[]>();
  for (const recipient of recipients) {
    const group = groups.get(recipient.orgId) ?? [];
    if (!group.some((existing) => existing.normalizedAddress === recipient.normalizedAddress)) {
      group.push(recipient);
      groups.set(recipient.orgId, group);
    }
  }
  return groups;
}

async function parsedMailToMessage(
  store: MailStore,
  input: IngestRawMailInput,
  parsed: ParsedMail,
  auth: MailAuthenticationSummary,
): Promise<MailMessageInput> {
  const to = addressObjectToList(parsed.to);
  const primaryRecipient = firstEnvelopeRecipient(input.envelopeTo, to);
  const actor =
    primaryRecipient === undefined
      ? null
      : await store.findActorByAddress(input.orgId, primaryRecipient);

  return {
    orgId: input.orgId,
    actorId: actor?.actorId ?? null,
    from: sanitizeMailAddress(addressObjectToList(parsed.from)[0]) ?? {
      address: input.envelopeFrom ?? "unknown@localhost",
    },
    to,
    cc: addressObjectToList(parsed.cc),
    bcc: [],
    subject: sanitizeMailHeaderDisplayValue(parsed.subject ?? ""),
    bodyText: parsed.text ?? "",
    ...(typeof parsed.html === "string" ? { bodyHtml: sanitizeMailHtml(parsed.html).html } : {}),
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references === undefined
        ? []
        : [parsed.references],
    receivedAt: input.receivedAt ?? new Date(),
    attachments: parsed.attachments.map(
      (attachment): MailAttachmentInput => ({
        filename: attachment.filename,
        mimeType: attachment.contentType,
        content: attachment.content,
        contentId: attachment.cid,
        disposition: attachment.contentDisposition,
      }),
    ),
    metadata: {
      direction: "inbound",
      auth: { ...auth },
      envelopeFrom: input.envelopeFrom ?? null,
      envelopeTo: [...input.envelopeTo],
    },
  };
}

/**
 * Run the configured inbound spam + antivirus scanners over the raw message.
 *
 * Scanner failures become an explicit unavailable outcome. Personal may allow
 * that outcome; Business and higher tiers quarantine it.
 */
export async function scanInboundMail(
  scanners: InboundMailScanners | undefined,
  raw: Buffer | string,
): Promise<InboundScanResult> {
  const tier = scanners?.tier ?? "personal";
  if (scanners === undefined) {
    return {
      spam: null,
      antivirus: null,
      routedToSpam: false,
      quarantined: false,
      spamReason: null,
    };
  }
  const [spamOutcome, antivirusOutcome] = await Promise.all([
    runScan(scanners.spam, raw),
    runScan(scanners.antivirus, raw),
  ]);
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
  const spamRouted = spam !== null && spam.isSpam;
  return {
    spam,
    antivirus,
    routedToSpam: virusRouted || policyQuarantined || spamRouted,
    quarantined: policyQuarantined,
    quarantineReasons: policyQuarantined
      ? [virusRouted ? "malware" : scannerUnavailable ? "scanner_unavailable" : "scanner_policy"]
      : [],
    scannerUnavailable,
    spamReason: virusRouted
      ? "virus"
      : policyQuarantined
        ? "scanner-policy"
        : spamRouted
          ? "spam-score"
          : null,
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

export function applyInboundSecurityPolicy(
  scan: InboundScanResult,
  auth: MailAuthenticationSummary,
  parsed: ParsedMail,
): InboundScanResult {
  const attachmentPolicy = inspectInboundAttachments(parsed.attachments);
  const authFailed =
    auth.dmarc === "fail" ||
    ((auth.spf === "fail" || auth.spf === "softfail") &&
      (auth.dkim === "fail" || auth.dkim === "none"));
  const quarantineReasons = new Set(scan.quarantineReasons ?? []);
  for (const reason of attachmentPolicy.reasons) quarantineReasons.add(reason);
  return {
    ...scan,
    routedToSpam: scan.routedToSpam || authFailed || attachmentPolicy.quarantine,
    quarantined: scan.quarantined || attachmentPolicy.quarantine,
    spamReason:
      scan.spamReason ??
      (attachmentPolicy.quarantine ? "scanner-policy" : authFailed ? "auth-failure" : null),
    quarantineReasons: [...quarantineReasons],
  };
}

export class MailQuarantinePersistenceRequiredError extends Error {
  constructor() {
    super("Inbound message requires quarantine, but no durable quarantine store is configured.");
    this.name = "MailQuarantinePersistenceRequiredError";
  }
}

export class MailInboundQuarantinedError extends Error {
  constructor(readonly quarantineId: string) {
    super("Inbound message was accepted into quarantine and was not delivered.");
    this.name = "MailInboundQuarantinedError";
  }
}

function sanitizeMailAddress(address: MailAddress | undefined): MailAddress | undefined {
  if (address === undefined) return undefined;
  return {
    ...address,
    ...(typeof address.name === "string"
      ? { name: sanitizeMailHeaderDisplayValue(address.name, 320) }
      : {}),
  };
}

function authenticationEvidence(auth: MailAuthenticationSummary): JsonObject {
  return {
    spf: auth.spf,
    dkim: auth.dkim,
    dmarc: auth.dmarc,
    arc: auth.arc,
    ...(auth.headers === undefined ? {} : { rawAuthenticationHeaders: auth.headers }),
    ...(auth.evidence === undefined ? {} : { details: auth.evidence }),
  };
}

function scanEvidence(scan: InboundScanResult): JsonObject {
  return {
    routedToSpam: scan.routedToSpam,
    quarantined: scan.quarantined,
    reason: scan.spamReason,
    scannerUnavailable: scan.scannerUnavailable ?? false,
    quarantineReasons: [...(scan.quarantineReasons ?? [])],
    ...(scan.antivirus?.evidence === undefined ? {} : { antivirus: scan.antivirus.evidence }),
    ...(scan.spam?.evidence === undefined ? {} : { spam: scan.spam.evidence }),
  };
}

/** Merge spam + antivirus scan evidence into the stored message metadata. */
function withScanMetadata(message: MailMessageInput, scan: InboundScanResult): MailMessageInput {
  if (scan.spam === null && scan.antivirus === null) {
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
            aligned: item.status.aligned,
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
                  result:
                    result.dmarc.alignment.spf.result === false
                      ? null
                      : result.dmarc.alignment.spf.result,
                  strict: result.dmarc.alignment.spf.strict,
                }),
                dkim: compactJsonObject({
                  result:
                    result.dmarc.alignment.dkim.result === false
                      ? null
                      : result.dmarc.alignment.dkim.result,
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

function compactJsonObject(values: Record<string, JsonValue | undefined>): JsonObject {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
  );
}

function addressObjectToList(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
  const objects = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return objects
    .flatMap((object) =>
      object.value.map((address) => ({
        address: address.address ?? "",
        ...(address.name === "" ? {} : { name: address.name }),
      })),
    )
    .filter((address) => address.address.length > 0);
}

function firstEnvelopeRecipient(
  envelopeTo: readonly string[],
  parsedTo: readonly MailAddress[],
): string | undefined {
  return envelopeTo[0] ?? parsedTo[0]?.address;
}

function collectStream(stream: SMTPServerDataStream, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let observedBytes = 0;
    let oversized = false;
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      observedBytes += bytes.byteLength;
      if (observedBytes > maxBytes) {
        oversized = true;
        return;
      }
      chunks.push(bytes);
    });
    stream.on("error", (error: Error) => {
      reject(error);
    });
    stream.on("end", () => {
      if (oversized || stream.sizeExceeded) {
        reject(smtpError(552, "Message exceeds the configured size limit."));
      } else {
        resolve(Buffer.concat(chunks, observedBytes));
      }
    });
  });
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

export type { SMTPServerSession };
