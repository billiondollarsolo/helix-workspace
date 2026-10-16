import fastify from "fastify";
import { expect, it } from "vitest";
import { InMemoryEventBus } from "../events/in-memory-event-bus.js";
import { EventStreamLimiter } from "../events/stream-limit.js";
import { registerMailStreamRoutes } from "./stream.js";

it.each([null, { id: "anonymous", orgId: "org" }])(
  "rejects unauthenticated mail streams: %j",
  async (actor) => {
    const app = fastify();
    registerMailStreamRoutes(app, { events: new InMemoryEventBus(), resolveActor: () => actor });
    try {
      expect((await app.inject("/sse/mail")).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  },
);

it.each(["revoked", "identity-changed", "verifier-failed"])(
  "closes a mail stream before delivery when %s",
  async (failure) => {
    const app = fastify();
    const bus = new InMemoryEventBus();
    const limiter = new EventStreamLimiter({ maxPerOrg: 1 });
    const actor = { id: "person", orgId: "org" };
    let valid = true;
    registerMailStreamRoutes(app, {
      events: bus,
      streamLimiter: limiter,
      resolveActor: () => {
        if (valid) return actor;
        if (failure === "verifier-failed") throw new Error("Verifier unavailable");
        return failure === "revoked" ? null : { ...actor, id: "another-person" };
      },
    });
    const controller = new AbortController();
    try {
      const base = await app.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(`${base}/sse/mail`, { signal: controller.signal });
      expect(response.status).toBe(200);
      if (response.body === null) throw new Error("Expected a streaming response");
      const reader = response.body.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(": ok\n\n");
      expect((await fetch(`${base}/sse/mail`)).status).toBe(429);
      await bus.publish("activity.mail.received", {
        ...actor,
        actorId: actor.id,
        threadId: "before",
      });
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        '"threadId":"before"',
      );
      valid = false;
      await bus.publish("activity.mail.received", {
        ...actor,
        actorId: actor.id,
        threadId: "after",
      });
      expect(await reader.read()).toMatchObject({ done: true });
      expect(limiter.activeFor(actor.orgId)).toBe(0);
    } finally {
      controller.abort();
      await app.close();
    }
  },
);
