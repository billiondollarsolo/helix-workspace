import type { OutboundMailMessage } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
  MailgunMailProvider,
  PostmarkMailProvider,
  ProviderMailTransport,
  SesMailProvider,
  SmtpRelayMailProvider,
  createOutboundMailProvider,
  parseOutboundProviderPublicConfig,
  resolveOutboundTransport,
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
function jsonFetch(status: number, body: unknown): { fetch: FetchLike; calls: FetchCall[] } {
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
      fetch: jsonFetch(401, { message: "remote-secret" }).fetch,
    });
    const failure = await provider.send(message).catch((error: unknown) => error);
    expect(String(failure)).toMatch(/Mailgun delivery failed with HTTP 401/u);
    expect(String(failure)).not.toContain("remote-secret");
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
      fetch: jsonFetch(200, { ErrorCode: 406, Message: "remote-secret" }).fetch,
    });
    const failure = await provider.send(message).catch((error: unknown) => error);
    expect(String(failure)).toMatch(/Postmark rejected the message/u);
    expect(String(failure)).not.toContain("remote-secret");
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
    const result = await transport.send(envelope, { idempotencyKey: "handoff-1" });
    expect(result.providerMessageId).toBe("<x@mg>");
    expect(result.deliveryMetadata).toMatchObject({ provider: "mailgun", providerName: "mg" });
  });

  it("passes canonical threading headers through provider adapters", async () => {
    const send = vi.fn(async () => ({ providerMessageId: "provider-1" }));
    const transport = new ProviderMailTransport({
      kind: "smtp",
      name: "relay",
      send,
    });

    await transport.send(
      {
        ...envelope,
        messageId: "<outbound@helix.test>",
        inReplyTo: "<parent@example.net>",
        references: ["<root@example.net>", "<parent@example.net>"],
      },
      { idempotencyKey: "handoff-1" },
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          "Message-ID": "<outbound@helix.test>",
          "In-Reply-To": "<parent@example.net>",
          References: "<root@example.net> <parent@example.net>",
          "X-Helix-Idempotency-Key": "handoff-1",
        },
      }),
    );
  });

  it("fails closed when an HTTP provider cannot preserve tenant DKIM", async () => {
    const provider = new MailgunMailProvider({
      name: "mg",
      domain: "mg.helix.test",
      apiKey: "key",
      fetch: jsonFetch(200, { id: "<x@mg>" }).fetch,
    });
    const transport = new ProviderMailTransport(provider, undefined, async () => ({
      domainName: "example.com",
      keySelector: "s1",
      privateKey: "kms-unwrapped-key",
    }));
    await expect(transport.send(envelope, { idempotencyKey: "handoff-1" })).rejects.toThrow(
      /use SMTP or SES/u,
    );
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
    webhookSecretRef: null,
  } as const;

  it("builds a Mailgun provider with a resolved secret", () => {
    const config: OutboundProviderConfig = {
      ...base,
      name: "mg",
      kind: "mailgun",
      config: { domain: "mg.helix.test" },
      secretRef: "mailgun-primary",
    };
    const provider = createOutboundMailProvider(config, (ref) =>
      ref === "mailgun-primary" ? "secret-value" : undefined,
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

describe("outbound provider public configuration", () => {
  it("rejects inline credentials and unknown settings", () => {
    expect(() =>
      parseOutboundProviderPublicConfig("mailgun", {
        domain: "mg.example.com",
        apiKey: "directly-usable-secret",
      }),
    ).toThrow();
    expect(() =>
      parseOutboundProviderPublicConfig("postmark", {
        baseUrl: "https://user:secret@api.postmarkapp.com",
      }),
    ).toThrow();
    expect(() =>
      parseOutboundProviderPublicConfig("smtp", { host: "user:secret@smtp.example.com" }),
    ).toThrow();
  });
});

describe("resolveOutboundTransport tenant boundary", () => {
  it("fails closed when the provider store returns another tenant's config", async () => {
    await expect(
      resolveOutboundTransport({
        orgId: "org-a",
        providerStore: {
          getDefaultProvider: async () => ({
            id: "p1",
            orgId: "org-b",
            name: "relay",
            kind: "smtp",
            enabled: true,
            isDefault: true,
            config: { host: "smtp.example.test" },
            secretRef: null,
            webhookSecretRef: null,
            createdAt: "2026-05-21T00:00:00.000Z",
            updatedAt: "2026-05-21T00:00:00.000Z",
          }),
        },
      }),
    ).rejects.toThrow("Outbound provider tenant mismatch");
  });

  it("requires either a tenant provider or an explicit global fallback", async () => {
    await expect(
      resolveOutboundTransport({
        orgId: "org-a",
        providerStore: { getDefaultProvider: async () => null },
      }),
    ).rejects.toThrow("No outbound mail provider is configured for tenant org-a");
  });
});
