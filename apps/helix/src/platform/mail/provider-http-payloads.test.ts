import { describe, expect, it } from "vitest";
import { MailDeliveryError } from "./errors.js";
import { isTerminalDeliveryError } from "./outbound.js";
import {
  type FetchLike,
  MailgunMailProvider,
  PostmarkMailProvider,
  ProviderMailTransport,
} from "./providers.js";
import type { MailOutboundEnvelope } from "./types.js";

interface Captured {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | URLSearchParams | Uint8Array;
}

function fakeFetch(captured: Captured[], payload: unknown = { id: "<id@mg>", MessageID: "pm-1" }) {
  const fetch: FetchLike = async (url, init) => {
    captured.push({ url, headers: init.headers, body: init.body });
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => payload,
    };
  };
  return fetch;
}

function envelope(overrides: Partial<MailOutboundEnvelope> = {}): MailOutboundEnvelope {
  return {
    from: { address: "alice@helix.test", name: "Alice" },
    to: [{ address: "bob@example.com" }],
    cc: [],
    bcc: [],
    replyTo: { address: "team@helix.test", name: 'Team "Ops"' },
    subject: "Report",
    text: "See attached.",
    html: '<p>See <img src="cid:logo@helix"></p>',
    headers: { "Auto-Submitted": "auto-replied" },
    attachments: [
      {
        filename: "report.pdf",
        mimeType: "application/pdf",
        contentType: "application/pdf",
        content: Buffer.from("%PDF-1.7 report"),
      },
      {
        filename: "logo.png",
        mimeType: "image/png",
        contentType: "image/png",
        contentId: "<logo@helix>",
        disposition: "inline",
        content: Buffer.from("png-bytes"),
      },
    ],
    ...overrides,
  };
}

async function multipart(captured: Captured): Promise<FormData> {
  return new Response(captured.body as Uint8Array<ArrayBuffer>, {
    headers: { "content-type": captured.headers["Content-Type"] ?? "" },
  }).formData();
}

describe("Mailgun provider (ML2/ML3c/ML11)", () => {
  it("sends attachments, inline cid parts, Reply-To and allowlisted headers as multipart", async () => {
    const captured: Captured[] = [];
    const provider = new MailgunMailProvider({
      name: "mg",
      domain: "mg.helix.test",
      apiKey: "key",
      fetch: fakeFetch(captured),
    });
    await new ProviderMailTransport(provider).send(envelope(), { idempotencyKey: "idem-1" });
    const request = captured[0];
    if (request === undefined) throw new Error("Mailgun was not called.");
    expect(request.headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/u);
    const form = await multipart(request);
    const attachment = form.get("attachment") as File;
    expect(attachment.name).toBe("report.pdf");
    expect(Buffer.from(await attachment.arrayBuffer()).toString()).toBe("%PDF-1.7 report");
    const inline = form.get("inline") as File;
    expect(inline.name).toBe("logo@helix");
    expect(inline.type).toBe("image/png");
    expect(form.get("h:Auto-Submitted")).toBe("auto-replied");
    expect(form.get("h:Reply-To")).toBe('"Team \\"Ops\\"" <team@helix.test>');
    expect(form.get("h:X-Helix-Idempotency-Key")).toBe("idem-1");
  });
});

describe("Postmark provider (ML2/ML3c/ML11)", () => {
  it("sends base64 attachments with ContentID, Reply-To and headers", async () => {
    const captured: Captured[] = [];
    const provider = new PostmarkMailProvider({
      name: "pm",
      serverToken: "token",
      fetch: fakeFetch(captured),
    });
    await new ProviderMailTransport(provider).send(envelope(), { idempotencyKey: "idem-2" });
    const body = JSON.parse(String(captured[0]?.body)) as {
      Attachments: { Name: string; Content: string; ContentType: string; ContentID?: string }[];
      Headers: { Name: string; Value: string }[];
      ReplyTo: string;
    };
    expect(body.Attachments).toEqual([
      {
        Name: "report.pdf",
        Content: Buffer.from("%PDF-1.7 report").toString("base64"),
        ContentType: "application/pdf",
      },
      {
        Name: "logo.png",
        Content: Buffer.from("png-bytes").toString("base64"),
        ContentType: "image/png",
        ContentID: "cid:logo@helix",
      },
    ]);
    expect(body.Headers).toContainEqual({ Name: "Auto-Submitted", Value: "auto-replied" });
    expect(body.ReplyTo).toBe('"Team \\"Ops\\"" <team@helix.test>');
  });

  it("fails closed, without calling Postmark, for attachment types it cannot carry", async () => {
    const captured: Captured[] = [];
    const provider = new PostmarkMailProvider({
      name: "pm",
      serverToken: "token",
      fetch: fakeFetch(captured),
    });
    const send = new ProviderMailTransport(provider).send(
      envelope({
        attachments: [
          {
            filename: "setup.exe",
            mimeType: "application/octet-stream",
            content: Buffer.from("MZ"),
          },
        ],
      }),
      { idempotencyKey: "idem-3" },
    );
    const error = await send.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailDeliveryError);
    expect(isTerminalDeliveryError(error)).toBe(true);
    expect(captured).toHaveLength(0);
  });

  it("drops headers outside the outbound allowlist", async () => {
    const captured: Captured[] = [];
    const provider = new PostmarkMailProvider({
      name: "pm",
      serverToken: "token",
      fetch: fakeFetch(captured),
    });
    await new ProviderMailTransport(provider).send(
      envelope({ headers: { Bcc: "evil@attacker.example", "auto-submitted": "auto-replied" } }),
      { idempotencyKey: "idem-4" },
    );
    const body = JSON.parse(String(captured[0]?.body)) as {
      Headers: { Name: string; Value: string }[];
    };
    expect(body.Headers.map((header) => header.Name)).not.toContain("Bcc");
    expect(body.Headers).toContainEqual({ Name: "Auto-Submitted", Value: "auto-replied" });
  });
});
