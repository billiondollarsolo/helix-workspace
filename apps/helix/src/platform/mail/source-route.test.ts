import type { Actor } from "@helix/sdk-types";
import fastify, { type FastifyInstance } from "fastify";
import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/api-error.js";
import { prepareMailRawSource } from "./raw-source.js";
import { registerMailSourceRoutes } from "./source-route.js";
import type { MailRawSourceStore } from "./store.js";
import type { MailRawSourceRecord } from "./types.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const messageId = "33333333-3333-4333-8333-333333333333";
const raw = Buffer.from("From: a@example.net\r\nTo: b@example.com\r\n\r\nexact\r\n");

describe("raw mail source route", () => {
  it("exports the exact bytes with safe evidence headers", async () => {
    const source = await record();
    const store = new FakeSourceStore(source);
    const app = withApiErrorHandler(fastify());
    registerMailSourceRoutes(app, { store, actorFromRequest: () => actor(["mail.read"]) });

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
    });
    const hidden = withApiErrorHandler(fastify());
    registerMailSourceRoutes(hidden, {
      store: new FakeSourceStore(null),
      actorFromRequest: () => actor(["mail.read"]),
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

class FakeSourceStore implements MailRawSourceStore {
  readonly reads: Array<{ orgId: string; actorId: string; messageId: string }> = [];

  constructor(private readonly source: MailRawSourceRecord | null) {}

  async readRawSource(input: { orgId: string; actorId: string; messageId: string }) {
    this.reads.push(input);
    return this.source;
  }
}

async function record(): Promise<MailRawSourceRecord> {
  return { messageId, ...prepareMailRawSource(raw, await simpleParser(raw)) };
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
