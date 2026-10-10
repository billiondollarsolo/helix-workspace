import nodemailer from "nodemailer";
import addressparser from "nodemailer/lib/addressparser/index.js";
import { describe, expect, it } from "vitest";
import { addressSchema } from "./tools-compose.js";
import { addressObjectToList } from "./inbound-message.js";
import { remoteDeliveryEnvelope } from "./local-delivery.js";
import { NodemailerMailTransport } from "./outbound.js";
import { formatMailboxAddress, sanitizeDisplayName } from "./outbound-format.js";
import { createSmtpTransport, ProviderMailTransport, SmtpRelayMailProvider } from "./providers.js";
import type { MailOutboundEnvelope } from "./types.js";

const injected = 'Bob\\", evil@attacker.example, "x';
const adversarialNames = [
  injected,
  'Eve" <evil@attacker.example>, "',
  "Line\r\nBcc: evil@attacker.example",
  "Nul\0evil@attacker.example",
  "Back\\slash\\",
];

function streamTransport() {
  return nodemailer.createTransport({ streamTransport: true, buffer: true });
}

function adversarialEnvelope(): MailOutboundEnvelope {
  return {
    from: { address: "alice@helix.test", name: injected },
    to: adversarialNames.map((name, index) => ({
      address: `to${String(index)}@example.com`,
      name,
    })),
    cc: [{ address: "cc@example.com", name: injected }],
    bcc: [{ address: "bcc@example.com", name: injected }],
    replyTo: { address: "reply@example.com", name: injected },
    subject: "Hello",
    text: "Body",
    attachments: [],
  };
}

const expectedRecipients = [
  ...adversarialNames.map((_name, index) => `to${String(index)}@example.com`),
  "cc@example.com",
  "bcc@example.com",
].sort();

describe("outbound display-name safety (ML1)", () => {
  it("keeps the SMTP envelope equal to the normalized recipients on the env transport", async () => {
    const transport = new NodemailerMailTransport(streamTransport());
    const result = await transport.send(adversarialEnvelope(), { idempotencyKey: "key-1" });
    const envelope = result.deliveryMetadata?.envelope as { from: string; to: string[] };
    expect(envelope.from).toBe("alice@helix.test");
    expect([...envelope.to].sort()).toEqual(expectedRecipients);
  });

  it("keeps the SMTP envelope equal to the normalized recipients on tenant SMTP/SES", async () => {
    const sent: { envelope: { to: string[] }; message: Buffer }[] = [];
    const transporter = streamTransport();
    const original = transporter.sendMail.bind(transporter);
    transporter.sendMail = async (mail: Parameters<typeof original>[0]) => {
      const info = await original(mail);
      sent.push(info as never);
      return info;
    };
    const provider = new SmtpRelayMailProvider(
      { name: "relay", host: "smtp.example" },
      transporter,
    );
    await new ProviderMailTransport(provider).send(adversarialEnvelope(), { idempotencyKey: "k" });
    expect([...(sent[0]?.envelope.to ?? [])].sort()).toEqual(expectedRecipients);
    const headers = sent[0]?.message.toString().split("\r\n\r\n")[0] ?? "";
    expect(headers).toMatch(/^Reply-To: /mu);
  });

  it("formats quoted-strings that parse back to exactly one mailbox", () => {
    for (const name of adversarialNames) {
      const parsed = addressparser(formatMailboxAddress({ address: "bob@example.com", name }));
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({ address: "bob@example.com" });
    }
    expect(formatMailboxAddress({ address: "a@example.com", name: 'a\\b"c' })).toBe(
      '"a\\\\b\\"c" <a@example.com>',
    );
    expect(sanitizeDisplayName("a\r\nb\0c")).toBe("a b c");
  });

  it("rejects header-breaking display names at the tool schema", () => {
    expect(addressSchema.safeParse({ address: "a@example.com", name: "x\r\ny" }).success).toBe(
      false,
    );
    expect(addressSchema.safeParse({ address: "a@example.com", name: "x\0y" }).success).toBe(false);
    expect(addressSchema.safeParse({ address: "a@example.com", name: injected }).success).toBe(
      true,
    );
  });

  it("strips control characters from inbound display names", () => {
    const list = addressObjectToList({
      value: [{ address: "eve@example.com", name: "Eve\r\nBcc: x@y.z" }],
      html: "",
      text: "",
    });
    expect(list).toEqual([{ address: "eve@example.com", name: "Eve Bcc: x@y.z" }]);
  });
});

describe("mixed local/remote delivery (ML6)", () => {
  it("keeps visible To/Cc and sends only remote recipients in the SMTP envelope", async () => {
    const envelope: MailOutboundEnvelope = {
      from: { address: "alice@helix.test" },
      to: [{ address: "bob@helix.test" }, { address: "partner@example.com" }],
      cc: [{ address: "carol@helix.test" }],
      bcc: [{ address: "audit@example.org" }],
      subject: "Mixed",
      text: "Body",
      attachments: [],
    };
    const remote = remoteDeliveryEnvelope(
      envelope,
      new Set(["bob@helix.test", "carol@helix.test"]),
    );
    expect(remote?.to).toEqual(envelope.to);
    expect(remote?.cc).toEqual(envelope.cc);
    expect(remote?.envelopeRecipients).toEqual(["partner@example.com", "audit@example.org"]);
    expect(
      remoteDeliveryEnvelope(
        envelope,
        new Set(["bob@helix.test", "carol@helix.test", "partner@example.com", "audit@example.org"]),
      ),
    ).toBeNull();

    const info = await new NodemailerMailTransport(streamTransport()).send(
      remote as MailOutboundEnvelope,
      {
        idempotencyKey: "mixed",
      },
    );
    expect((info.deliveryMetadata?.envelope as { to: string[] }).to).toEqual([
      "partner@example.com",
      "audit@example.org",
    ]);
  });

  it("narrows visible recipients only for HTTP providers that cannot split the envelope", async () => {
    const seen: { to: string[] }[] = [];
    const provider = {
      kind: "postmark",
      name: "pm",
      async send(message: { to: readonly { address: string }[] }) {
        seen.push({ to: message.to.map((entry) => entry.address) });
        return {};
      },
    };
    await new ProviderMailTransport(provider).send(
      {
        from: { address: "alice@helix.test" },
        to: [{ address: "bob@helix.test" }, { address: "partner@example.com" }],
        cc: [],
        bcc: [],
        subject: "s",
        text: "t",
        attachments: [],
        envelopeRecipients: ["partner@example.com"],
      },
      { idempotencyKey: "k" },
    );
    expect(seen[0]?.to).toEqual(["partner@example.com"]);
  });
});

describe("tenant SMTP/SES transport security (ML7)", () => {
  it("requires STARTTLS unless implicit TLS is configured", () => {
    const starttls = createSmtpTransport({ host: "smtp.example", port: 587 });
    const implicit = createSmtpTransport({ host: "smtp.example", port: 465, secure: true });
    expect((starttls.options as { requireTLS?: boolean }).requireTLS).toBe(true);
    expect((implicit.options as { requireTLS?: boolean }).requireTLS).toBe(false);
  });
});
