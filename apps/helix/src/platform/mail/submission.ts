import type { Actor } from "@helix/sdk-types";
import { simpleParser } from "mailparser";
import type { SecureContextOptions } from "node:tls";
import {
  SMTPServer,
  type SMTPServerAuthentication,
  type SMTPServerDataStream,
  type SMTPServerSession,
} from "smtp-server";
import type { AppPasswordAuthenticator } from "../auth/app-passwords.js";
import { addressObjectToList, assertParsedMailBounds, spoolStream } from "./ingest.js";
import { MailSendService } from "./outbound.js";
import type { MailStore } from "./store.js";
import type { MailAddress, MailOutboundEnvelope } from "./types.js";

export interface SmtpSubmissionOptions {
  readonly appPasswords: AppPasswordAuthenticator;
  readonly store: MailStore;
  readonly tls: Pick<SecureContextOptions, "key" | "cert">;
  readonly maxMessageBytes?: number;
  readonly maxRecipients?: number;
  readonly maxConnections?: number;
  readonly socketTimeoutMs?: number;
  readonly dataTimeoutMs?: number;
  readonly logger?: { error(error: unknown, message: string): void };
}

/** Authenticated RFC 6409 submission; inbound SMTP remains a separate service. */
export class SmtpSubmissionServer {
  readonly #server: SMTPServer;
  readonly #actors = new Map<string, Actor>();
  readonly #senders = new Map<string, string>();

  constructor(private readonly options: SmtpSubmissionOptions) {
    const maxMessageBytes = options.maxMessageBytes ?? 52_428_800;
    const maxRecipients = options.maxRecipients ?? 100;
    this.#server = new SMTPServer({
      secure: true,
      key: options.tls.key,
      cert: options.tls.cert,
      authMethods: ["PLAIN", "LOGIN"],
      authOptional: false,
      disabledCommands: ["XCLIENT", "XFORWARD"],
      size: maxMessageBytes,
      maxClients: options.maxConnections ?? 100,
      socketTimeout: options.socketTimeoutMs ?? 60_000,
      closeTimeout: 10_000,
      onAuth: (auth, session, callback) => {
        this.#authenticate(auth, session, callback);
      },
      onMailFrom: (address, session, callback) => {
        this.#senders.delete(session.id);
        const actor = this.#actors.get(session.id);
        if (actor === undefined || address.address === "") {
          callback(smtpError(530, "Authentication required."));
          return;
        }
        const store = this.options.store;
        if (store.resolveAuthorizedSender === undefined) {
          callback(smtpError(451, "Sender authorization is unavailable."));
          return;
        }
        store
          .resolveAuthorizedSender(actor.orgId, actor.id, address.address)
          .then((authorized) => {
            if (authorized === null) {
              callback(smtpError(553, "Sender address is not authorized."));
              return;
            }
            this.#senders.set(session.id, authorized);
            callback();
          })
          .catch((error: unknown) => {
            this.options.logger?.error(error, "SMTP submission sender authorization failed");
            callback(smtpError(451, "Sender authorization is temporarily unavailable."));
          });
      },
      onRcptTo: (_address, session, callback) => {
        callback(
          session.envelope.rcptTo.length >= maxRecipients
            ? smtpError(452, "Too many recipients.")
            : undefined,
        );
      },
      onData: (stream, session, callback) => {
        this.#submit(stream, session, maxMessageBytes)
          .then((id) => {
            callback(null, `Queued as ${id}`);
          })
          .catch((error: unknown) => {
            this.options.logger?.error(error, "SMTP submission failed");
            callback(asSmtpError(error));
          });
      },
      onClose: (session) => {
        this.#actors.delete(session.id);
        this.#senders.delete(session.id);
      },
    });
  }

  listen(port: number, host?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, host, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.close(resolve);
    });
  }

  get nodeServer(): SMTPServer {
    return this.#server;
  }

  #authenticate(
    auth: SMTPServerAuthentication,
    session: SMTPServerSession,
    callback: (error?: Error | null, response?: { readonly user: string }) => void,
  ): void {
    if (auth.username === undefined || auth.password === undefined) {
      callback(smtpError(535, "Authentication credentials invalid."));
      return;
    }
    this.options.appPasswords
      .authenticateAppPassword({
        username: auth.username,
        password: auth.password,
        requiredScope: "mail.send",
        compatibilityScope: "smtp",
      })
      .then(async (actor) => {
        if (actor === null) return null;
        return this.options.appPasswords.authenticateAppPassword({
          username: auth.username ?? "",
          password: auth.password ?? "",
          requiredScope: "mail.external",
          compatibilityScope: "smtp",
        });
      })
      .then((actor) => {
        if (actor === null) {
          callback(smtpError(535, "Authentication credentials invalid."));
          return;
        }
        this.#actors.set(session.id, actor);
        callback(null, { user: actor.id });
      })
      .catch((error: unknown) => {
        this.options.logger?.error(error, "SMTP submission authentication failed");
        callback(smtpError(454, "Authentication is temporarily unavailable."));
      });
  }

  async #submit(
    stream: SMTPServerDataStream,
    session: SMTPServerSession,
    maxMessageBytes: number,
  ): Promise<string> {
    const actor = this.#actors.get(session.id);
    const envelopeFrom = this.#senders.get(session.id);
    if (actor === undefined || envelopeFrom === undefined) {
      throw smtpError(530, "Authentication required.");
    }
    const raw = await spoolStream(stream, {
      maxBytes: maxMessageBytes,
      timeoutMs: this.options.dataTimeoutMs ?? 120_000,
    });
    const parsed = await simpleParser(raw, {
      maxHtmlLengthToParse: 5 * 1024 * 1024,
      skipTextToHtml: true,
    });
    assertParsedMailBounds(parsed);
    const from = addressObjectToList(parsed.from);
    if (from.length !== 1 || from[0]?.address.toLowerCase() !== envelopeFrom.toLowerCase()) {
      throw smtpError(553, "From header does not match the authorized envelope sender.");
    }
    const recipients = session.envelope.rcptTo.map((recipient) => recipient.address);
    const to = includedRecipients(addressObjectToList(parsed.to), recipients);
    const cc = includedRecipients(addressObjectToList(parsed.cc), recipients);
    const visible = new Set([...to, ...cc].map((address) => address.address.toLowerCase()));
    const bcc = recipients
      .filter((address) => !visible.has(address.toLowerCase()))
      .map((address) => ({ address }));
    const envelope: MailOutboundEnvelope = {
      from: from[0],
      to,
      cc,
      bcc,
      subject: parsed.subject ?? "",
      text: parsed.text ?? "",
      ...(typeof parsed.html === "string" ? { html: parsed.html } : {}),
      attachments: parsed.attachments.map((attachment) => ({
        filename: attachment.filename,
        mimeType: attachment.contentType,
        contentType: attachment.contentType,
        content: attachment.content,
        contentId: attachment.cid,
        disposition: attachment.contentDisposition,
      })),
      ...(parsed.messageId === undefined ? {} : { messageId: parsed.messageId }),
      ...(parsed.inReplyTo === undefined ? {} : { inReplyTo: parsed.inReplyTo }),
      ...(parsed.references === undefined
        ? {}
        : {
            references: Array.isArray(parsed.references) ? parsed.references : [parsed.references],
          }),
    };
    const queued = await new MailSendService({ store: this.options.store, undoWindowMs: 0 }).queue({
      orgId: actor.orgId,
      actorId: actor.id,
      envelope,
    });
    return queued.id;
  }
}

function includedRecipients(
  addresses: readonly MailAddress[],
  envelope: readonly string[],
): MailAddress[] {
  const accepted = new Set(envelope.map((address) => address.toLowerCase()));
  return addresses.filter((address) => accepted.has(address.address.toLowerCase()));
}

function smtpError(responseCode: number, message: string): Error {
  return Object.assign(new Error(message), { responseCode });
}

function asSmtpError(error: unknown): Error {
  return error instanceof Error ? error : smtpError(451, "Submission failed.");
}
