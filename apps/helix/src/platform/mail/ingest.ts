import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { authenticate, type AuthStatus, type AuthenticateResult } from "mailauth";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { JsonObject, JsonValue } from "@helix/sdk-types";
import type {
  MailAddress,
  MailAttachmentInput,
  MailMessageInput,
  StoredMailMessage,
} from "./types.js";
import type { MailStore } from "./store.js";
import { evaluateInboundMail, type MailFilterEvaluationResult } from "./filters.js";

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

export interface IngestRawMailResult {
  readonly stored: StoredMailMessage;
  readonly auth: MailAuthenticationSummary;
  readonly filterResult: MailFilterEvaluationResult;
}

export interface MailAuthenticator {
  authenticate(input: IngestRawMailInput): Promise<MailAuthenticationSummary>;
}

export interface SmtpReceiverOptions {
  readonly store: MailStore;
  readonly orgId: string;
  readonly authenticator?: MailAuthenticator;
  readonly disabledCommands?: readonly string[];
  readonly logger?: { error(error: unknown, message?: string): void };
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

  constructor(private readonly options: SmtpReceiverOptions) {
    this.server = new SMTPServer({
      disabledCommands: [...(options.disabledCommands ?? ["AUTH"])],
      onData: (stream, session, callback) => {
        collectStream(stream)
          .then(async (raw) => {
            await ingestRawMail({
              store: this.options.store,
              ...(this.options.authenticator === undefined
                ? {}
                : { authenticator: this.options.authenticator }),
              input: {
                orgId: this.options.orgId,
                raw,
                ...(session.envelope.mailFrom === false
                  ? {}
                  : { envelopeFrom: session.envelope.mailFrom.address }),
                envelopeTo: session.envelope.rcptTo.map((recipient) => recipient.address),
                remoteAddress: session.remoteAddress,
                helo: session.hostNameAppearsAs,
              },
            });
            callback();
          })
          .catch((error: unknown) => {
            this.options.logger?.error(error, "SMTP mail ingest failed");
            callback(error instanceof Error ? error : new Error(String(error)));
          });
      },
    });
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

export async function ingestRawMail(input: {
  readonly store: MailStore;
  readonly input: IngestRawMailInput;
  readonly authenticator?: MailAuthenticator;
}): Promise<IngestRawMailResult> {
  // P2-6: an `smtp.receive` span covers authentication, parsing, persistence,
  // and inbound-filter evaluation for one received message.
  return trace.getTracer("helix.mail").startActiveSpan(
    "smtp.receive",
    { attributes: { "helix.mail.org_id": input.input.orgId } },
    async (span) => {
      try {
        const authenticator = input.authenticator ?? new MailauthAuthenticator();
        const [auth, parsed] = await Promise.all([
          authenticator.authenticate(input.input),
          simpleParser(input.input.raw),
        ]);
        const message = await parsedMailToMessage(input.store, input.input, parsed, auth);
        const stored = await input.store.insertInboundMessage(message);
        span.setAttribute("helix.mail.message_id", stored.messageId);
        span.setAttribute("helix.mail.auth_spf", auth.spf);
        span.setAttribute("helix.mail.auth_dmarc", auth.dmarc);
        const filterResult = await evaluateInboundMail(input.store, {
          message,
          stored,
          ...(message.actorId === undefined ? {} : { recipientActorId: message.actorId }),
          ...(input.input.receivedAt === undefined ? {} : { now: input.input.receivedAt }),
        });
        return { stored, auth, filterResult };
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
    from: addressObjectToList(parsed.from)[0] ?? {
      address: input.envelopeFrom ?? "unknown@localhost",
    },
    to,
    cc: addressObjectToList(parsed.cc),
    bcc: [],
    subject: parsed.subject ?? "",
    bodyText: parsed.text ?? "",
    ...(typeof parsed.html === "string" ? { bodyHtml: parsed.html } : {}),
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

function collectStream(stream: SMTPServerDataStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("error", (error: Error) => {
      reject(error);
    });
    stream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

export type { SMTPServerSession };
