import { describe, expect, it, vi } from "vitest";
import type { OutboundMailMessage } from "@helix/sdk-types";
import {
  MailgunMailProvider,
  PostmarkMailProvider,
  ProviderMailTransport,
  SesMailProvider,
  SmtpRelayMailProvider,
  createOutboundMailProvider,
  type FetchLike,
  type OutboundProviderConfig,
} from "./providers.js";
import type { MailOutboundEnvelope } from "./types.js";

const message: OutboundMailMessage = {
  from: { address: "sender@helix.test", name: "Helix" },
  to: [{ address: "recipient@example.com" }],
  cc: [],
  bcc: [],
  subject: "Hello",
  text: "Body text",
};

const envelope: MailOutboundEnvelope = {
  from: { address: "sender@helix.test", name: "Helix" },
  to: [{ address: "recipient@example.com" }],
  cc: [],
  bcc: [],
  subject: "Hello",
  text: "Body text",
  attachments: [],
};

interface FetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** A `FetchLike` returning a fixed JSON body and recording its calls. */
function jsonFetch(
  status: number,
  body: unknown,
): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  };
  return { fetch: fetchImpl, calls };
}

/** A fake nodemailer transporter. */
function fakeTransport(messageId = "smtp-1"): {
  sendMail: ReturnType<typeof vi.fn>;
} {
  return {
    sendMail: vi.fn(async () => ({
      messageId,
      response: "250 OK",
      accepted: ["recipient@example.com"],
      rejected: [],
      envelope: {},
    })),
  };
}

describe("MailgunMailProvider", () => {
  it("posts a form-encoded message to the Mailgun API", async () => {
    const stub = jsonFetch(200, { id: "<mg-123@mailgun.org>", message: "Queued" });
    const provider = new MailgunMailProvider({
      name: "mg",
      domain: "mg.helix.test",
      apiKey: "key-secret",
      fetch: stub.fetch,
    });
    const delivery = await provider.send(message);
    expect(delivery.providerMessageId).toBe("<mg-123@mailgun.org>");
    const call = stub.calls[0];
    expect(call?.url).toContain("/v3/mg.helix.test/messages");
    expect(call?.headers.Authorization).toMatch(/^Basic /u);
  });

  it("throws on a non-2xx Mailgun response", async () => {
    const provider = new MailgunMailProvider({
      name: "mg",
      domain: "mg.helix.test",
      apiKey: "key-secret",
      fetch: jsonFetch(401, { message: "Unauthorized" }).fetch,
    });
    await expect(provider.send(message)).rejects.toThrow(/Mailgun delivery failed \(401\)/u);
  });
});

describe("PostmarkMailProvider", () => {
  it("posts a JSON message to the Postmark API", async () => {
    const stub = jsonFetch(200, { MessageID: "pm-7", ErrorCode: 0 });
    const provider = new PostmarkMailProvider({
      name: "pm",
      serverToken: "token-secret",
      fetch: stub.fetch,
    });
    const delivery = await provider.send(message);
    expect(delivery.providerMessageId).toBe("pm-7");
    expect(stub.calls[0]?.headers["X-Postmark-Server-Token"]).toBe("token-secret");
  });

  it("throws when Postmark returns a non-zero ErrorCode", async () => {
    const provider = new PostmarkMailProvider({
      name: "pm",
      serverToken: "token-secret",
      fetch: jsonFetch(200, { ErrorCode: 406, Message: "Inactive recipient" }).fetch,
    });
    await expect(provider.send(message)).rejects.toThrow(/Postmark rejected the message/u);
  });
});

describe("SES and SMTP relay providers", () => {
  it("delivers SES mail through its SMTP transport", async () => {
    const transport = fakeTransport("ses-1");
    const provider = new SesMailProvider(
      { name: "ses", region: "us-east-1", host: "email-smtp.us-east-1.amazonaws.com" },
      transport as never,
    );
    const delivery = await provider.send(message);
    expect(delivery.providerMessageId).toBe("ses-1");
    expect(transport.sendMail).toHaveBeenCalledOnce();
  });

  it("delivers SMTP relay mail through its transport", async () => {
    const transport = fakeTransport("relay-1");
    const provider = new SmtpRelayMailProvider(
      { name: "relay", host: "relay.helix.test" },
      transport as never,
    );
    const delivery = await provider.send(message);
    expect(delivery.providerMessageId).toBe("relay-1");
  });
});

describe("ProviderMailTransport", () => {
  it("adapts a provider to the outbound transport contract", async () => {
    const provider = new MailgunMailProvider({
      name: "mg",
      domain: "mg.helix.test",
      apiKey: "key",
      fetch: jsonFetch(200, { id: "<x@mg>" }).fetch,
    });
    const transport = new ProviderMailTransport(provider);
    const result = await transport.send(envelope);
    expect(result.providerMessageId).toBe("<x@mg>");
    expect(result.deliveryMetadata).toMatchObject({ provider: "mailgun", providerName: "mg" });
  });
});

describe("createOutboundMailProvider", () => {
  const base = {
    id: "p1",
    orgId: "org-1",
    enabled: true,
    isDefault: true,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  } as const;

  it("builds a Mailgun provider with a resolved secret", () => {
    const config: OutboundProviderConfig = {
      ...base,
      name: "mg",
      kind: "mailgun",
      config: { domain: "mg.helix.test" },
      secretRef: "MAILGUN_KEY",
    };
    const provider = createOutboundMailProvider(config, (ref) =>
      ref === "MAILGUN_KEY" ? "secret-value" : undefined,
    );
    expect(provider.kind).toBe("mailgun");
  });

  it("fails fast when a required HTTP-API secret is missing", () => {
    const config: OutboundProviderConfig = {
      ...base,
      name: "pm",
      kind: "postmark",
      config: {},
      secretRef: null,
    };
    expect(() => createOutboundMailProvider(config, () => undefined)).toThrow(
      /missing its API credential/u,
    );
  });

  it("fails fast when an SMTP provider is missing the host", () => {
    const config: OutboundProviderConfig = {
      ...base,
      name: "relay",
      kind: "smtp",
      config: {},
      secretRef: null,
    };
    expect(() => createOutboundMailProvider(config, () => undefined)).toThrow(
      /missing required config "host"/u,
    );
  });
});
