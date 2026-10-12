import { createPrivateKey, createPublicKey } from "node:crypto";
import { authenticate, dkimSign } from "mailauth";
import MailComposer from "nodemailer/lib/mail-composer";
import {
  summarizeAuthentication,
  type IngestRawMailInput,
  type MailAuthenticationSummary,
  type MailAuthenticator,
} from "../../platform/mail/ingest.js";
import type { OutboundMailTransport } from "../../platform/mail/outbound.js";
import { COMPANY } from "./company.js";
import type { DemoDns } from "./dns.js";
import { seedUuid } from "./random.js";
import type { ExternalOrg } from "./world.js";

export type MimeAddress = {
  readonly address: string;
  readonly name: string;
};

export interface MimeAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

export interface MimeMessage {
  readonly from: MimeAddress;
  readonly to: readonly MimeAddress[];
  readonly cc?: readonly MimeAddress[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly date: Date;
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly attachments?: readonly MimeAttachment[];
  readonly headers?: Readonly<Record<string, string>>;
  /** An iMIP invitation (text/calendar) carried as the calendar part. */
  readonly icalEvent?: { readonly method: string; readonly content: string };
}

const SELECTOR = "mail2024";

/**
 * The fictional senders' mail servers: each external domain publishes SPF,
 * an Ed25519 DKIM key and a DMARC policy in the demo DNS, and signs what it
 * sends, so inbound evidence is a real verification result.
 */
export class DemoMailServers {
  readonly #keys = new Map<string, string>();

  constructor(private readonly dns: DemoDns) {}

  register(
    entity: ExternalOrg,
    options: { readonly signed: boolean; readonly dmarc: boolean },
  ): void {
    this.dns.publishTxt(entity.domain, `v=spf1 ip4:${entity.ip} -all`);
    if (options.dmarc) {
      this.dns.publishTxt(
        `_dmarc.${entity.domain}`,
        `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@${entity.domain}`,
      );
    }
    if (!options.signed) return;
    const seed = Buffer.from(seedUuid("dkim", entity.domain).replaceAll("-", ""), "hex");
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        seed,
        seed,
      ]).subarray(0, 48),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey(privateKey)
      .export({ format: "der", type: "spki" })
      .subarray(-32);
    this.dns.publishTxt(
      `${SELECTOR}._domainkey.${entity.domain}`,
      `v=DKIM1; k=ed25519; p=${publicKey.toString("base64")}`,
    );
    this.#keys.set(entity.domain, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
  }

  /** Builds the message, DKIM-signs it as the sending domain and adds the MX's Received line. */
  async render(message: MimeMessage, entity: ExternalOrg | null): Promise<Buffer> {
    const raw = await compose(message);
    if (entity === null) return raw;
    const key = this.#keys.get(entity.domain);
    const signed =
      key === undefined
        ? raw
        : Buffer.concat([
            Buffer.from(
              (
                await dkimSign(raw, {
                  ...signer(entity.domain, key),
                  signTime: message.date,
                  // mailauth signs from `signatureData`; the flat fields only satisfy its typings.
                  signatureData: [{ ...signer(entity.domain, key), signTime: message.date }],
                })
              ).signatures,
            ),
            raw,
          ]);
    const received = `Received: from mail.${entity.domain} (mail.${entity.domain} [${entity.ip}])\r\n\tby mx.${COMPANY.domain} with ESMTPS id ${seedUuid("smtp", message.messageId).slice(0, 13)}\r\n\tfor <${message.to[0]?.address ?? ""}>; ${message.date.toUTCString()}\r\n`;
    return Buffer.concat([Buffer.from(received), signed]);
  }
}

function signer(domain: string, privateKey: string) {
  return {
    signingDomain: domain,
    selector: SELECTOR,
    privateKey,
    algorithm: "ed25519-sha256",
    canonicalization: "relaxed/relaxed",
  };
}

async function compose(message: MimeMessage): Promise<Buffer> {
  const composer = new MailComposer({
    from: message.from,
    to: [...message.to],
    ...(message.cc === undefined || message.cc.length === 0 ? {} : { cc: [...message.cc] }),
    subject: message.subject,
    text: message.text,
    ...(message.html === undefined ? {} : { html: message.html }),
    date: message.date,
    messageId: message.messageId,
    ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
    ...(message.references === undefined ? {} : { references: [...message.references] }),
    ...(message.headers === undefined ? {} : { headers: { ...message.headers } }),
    ...(message.icalEvent === undefined
      ? {}
      : { icalEvent: { method: message.icalEvent.method, content: message.icalEvent.content } }),
    attachments: (message.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: attachment.content,
    })),
  });
  return new Promise((resolve, reject) => {
    composer.compile().build((error, built) => {
      if (error !== null) reject(error);
      else resolve(built);
    });
  });
}

/**
 * Verifies inbound SPF, DKIM and DMARC with mailauth exactly as the SMTP
 * receiver does, but answers DNS from the demo world instead of the Internet.
 */
export class DemoMailAuthenticator implements MailAuthenticator {
  constructor(private readonly dns: DemoDns) {}

  async authenticate(input: IngestRawMailInput): Promise<MailAuthenticationSummary> {
    const result = await authenticate(input.raw, {
      ...(input.envelopeFrom === undefined ? {} : { sender: input.envelopeFrom }),
      ...(input.remoteAddress === undefined ? {} : { ip: input.remoteAddress }),
      ...(input.helo === undefined ? {} : { helo: input.helo }),
      mta: `mx.${COMPANY.domain}`,
      resolver: this.dns.mailauthResolver,
      disableArc: true,
      disableBimi: true,
    });
    return summarizeAuthentication(result);
  }
}

/**
 * Stands in for the upstream relay that accepts mail for external recipients.
 * The seed never sends mail off the machine; replies to customers are recorded
 * as accepted by this relay, the way a smarthost would acknowledge them.
 */
export const demoRelay: OutboundMailTransport = {
  async send(envelope) {
    return {
      providerMessageId:
        envelope.messageId ?? `<${seedUuid("relay", envelope.subject)}@relay.${COMPANY.domain}>`,
      deliveryMetadata: {
        transport: "demo-relay",
        recipients: (envelope.envelopeRecipients ?? []).length,
      },
    };
  },
};
