import type { Actor } from "@helix/sdk-types";
import fastify, { type FastifyInstance } from "fastify";
import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/api-error.js";
import { MAIL_RAW_PARSE_OPTIONS, prepareMailRawSource } from "./raw-source.js";
import { registerMailSourceRoutes } from "./source-route.js";
import type {
  MessageAttachmentContent,
  ReadMessageAttachmentInput,
} from "./store-attachment-read.js";
import type { MailRawSourceStore } from "./store.js";
import type { MailRawSourceRecord } from "./types.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const messageId = "33333333-3333-4333-8333-333333333333";
const objectId = "44444444-4444-4444-8444-444444444444";
const delegatorId = "55555555-5555-4555-8555-555555555555";
const raw = Buffer.from("From: a@example.net\r\nTo: b@example.com\r\n\r\nexact\r\n");

describe("raw mail source route", () => {
  it("exports the exact bytes with safe evidence headers", async () => {
    const source = await record();
    const store = new FakeSourceStore(source);
    const app = withApiErrorHandler(fastify());
    registerMailSourceRoutes(app, {
      store,
      actorFromRequest: () => actor(["mail.read"]),
      maxAttachmentBytes: 1024,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/mail/messages/${messageId}/source`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(raw);
    expect(response.headers["content-type"]).toContain("message/rfc822");
    expect(response.headers["content-disposition"]).toBe(`attachment; filename="${messageId}.eml"`);
    expect(response.headers["content-length"]).toBe(String(raw.byteLength));
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(store.reads).toEqual([{ orgId, actorId, messageId }]);
  });

  it("requires mail.read and conceals another mailbox's source", async () => {
    const denied = withApiErrorHandler(fastify());
    registerMailSourceRoutes(denied, {
      store: new FakeSourceStore(await record()),
      actorFromRequest: () => actor([]),
      maxAttachmentBytes: 1024,
    });
    const hidden = withApiErrorHandler(fastify());
    registerMailSourceRoutes(hidden, {
      store: new FakeSourceStore(null),
      actorFromRequest: () => actor(["mail.read"]),
      maxAttachmentBytes: 1024,
    });

    const deniedResponse = await denied.inject({
      method: "GET",
      url: `/api/mail/messages/${messageId}/source`,
    });
    const hiddenResponse = await hidden.inject({
      method: "GET",
      url: `/api/mail/messages/${messageId}/source`,
    });

    expect(deniedResponse.statusCode).toBe(403);
    expect(hiddenResponse.statusCode).toBe(404);
  });
});

describe("mail attachment download route", () => {
  const attachmentUrl = `/api/mail/messages/${messageId}/attachments/${objectId}`;

  it("streams a visible attachment as a download with safe headers", async () => {
    const store = new FakeSourceStore(null, {
      content: Buffer.from("%PDF-1.7"),
      mimeType: "application/pdf",
      filename: "Q3 plan.pdf",
      disposition: "attachment",
    });
    const app = withApiErrorHandler(fastify());
    registerMailSourceRoutes(app, {
      store,
      actorFromRequest: () => actor(["mail.read"]),
      maxAttachmentBytes: 1024,
    });

    const response = await app.inject({
      method: "GET",
      url: `${attachmentUrl}?mailboxActorId=${delegatorId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("%PDF-1.7");
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["content-disposition"]).toContain('attachment; filename="Q3 plan.pdf"');
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(store.attachmentReads).toEqual([
      { orgId, actorId: delegatorId, messageId, objectId, maxBytes: 1024 },
    ]);
  });

  it("shows passive images inline but never active content", async () => {
    const image = withApiErrorHandler(fastify());
    registerMailSourceRoutes(image, {
      store: new FakeSourceStore(null, {
        content: Buffer.from("png"),
        mimeType: "image/png",
        filename: "logo.png",
        disposition: "inline",
      }),
      actorFromRequest: () => actor(["mail.read"]),
      maxAttachmentBytes: 1024,
    });
    const active = withApiErrorHandler(fastify());
    registerMailSourceRoutes(active, {
      store: new FakeSourceStore(null, {
        content: Buffer.from("<svg/>"),
        mimeType: "image/svg+xml",
        filename: "logo.svg",
        disposition: "inline",
      }),
      actorFromRequest: () => actor(["mail.read"]),
      maxAttachmentBytes: 1024,
    });

    const inline = await image.inject({ method: "GET", url: `${attachmentUrl}?inline=true` });
    const forced = await active.inject({ method: "GET", url: `${attachmentUrl}?inline=true` });

    expect(inline.headers["content-disposition"]).toMatch(/^inline;/u);
    expect(forced.headers["content-disposition"]).toMatch(/^attachment;/u);
    expect(forced.headers["content-type"]).toContain("application/octet-stream");
  });

  it("requires mail.read and hides attachments outside the mailbox", async () => {
    const denied = withApiErrorHandler(fastify());
    registerMailSourceRoutes(denied, {
      store: new FakeSourceStore(null),
      actorFromRequest: () => actor([]),
      maxAttachmentBytes: 1024,
    });
    const hidden = withApiErrorHandler(fastify());
    registerMailSourceRoutes(hidden, {
      store: new FakeSourceStore(null),
      actorFromRequest: () => actor(["mail.read"]),
      maxAttachmentBytes: 1024,
    });

    expect((await denied.inject({ method: "GET", url: attachmentUrl })).statusCode).toBe(403);
    expect((await hidden.inject({ method: "GET", url: attachmentUrl })).statusCode).toBe(404);
  });
});

class FakeSourceStore implements MailRawSourceStore {
  readonly reads: Array<{ orgId: string; actorId: string; messageId: string }> = [];
  readonly attachmentReads: ReadMessageAttachmentInput[] = [];

  constructor(
    private readonly source: MailRawSourceRecord | null,
    private readonly attachment: MessageAttachmentContent | null = null,
  ) {}

  async readRawSource(input: { orgId: string; actorId: string; messageId: string }) {
    this.reads.push(input);
    return this.source;
  }

  async readMessageAttachment(input: ReadMessageAttachmentInput) {
    this.attachmentReads.push(input);
    return this.attachment;
  }
}

async function record(): Promise<MailRawSourceRecord> {
  return {
    messageId,
    ...prepareMailRawSource(raw, await simpleParser(raw, MAIL_RAW_PARSE_OPTIONS)),
  };
}

function actor(scopes: readonly string[]): Actor {
  return { id: actorId, orgId, type: "user", scopes };
}

function withApiErrorHandler(app: FastifyInstance): FastifyInstance {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ error: { code: error.code } });
    }
    throw error;
  });
  return app;
}
