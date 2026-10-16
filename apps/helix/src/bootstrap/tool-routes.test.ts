import type { ToolDefinition } from "@helix/sdk-types";
import fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore } from "../api/idempotency.js";
import { createPlatformMetrics } from "../api/metrics.js";
import { InMemoryOAuthClientStore } from "../platform/auth/oauth.js";
import { createToolRegistry } from "../platform/tool-registry.js";
import {
  CredentialAuthError,
  sendCredentialAuthError,
  traceIdForRequest,
} from "./request-principal.js";
import { registerToolRestRoutes } from "./tool-routes.js";

const passthrough = {
  parse: (value: unknown) => value,
  toJsonSchema: () => ({ type: "object" }),
};

function writeTool(id: string, handler: ToolDefinition["handler"]): ToolDefinition {
  return {
    id,
    description: id,
    permission: "platform.read",
    sideEffects: "write",
    inputSchema: passthrough,
    outputSchema: passthrough,
    handler,
  };
}

async function setup(tool: ToolDefinition, configure?: (app: FastifyInstance) => void) {
  const tokenStore = new InMemoryOAuthClientStore();
  await tokenStore.saveToken({
    token: "idem-token",
    clientId: "client-1",
    actorId: "user-idem",
    orgId: "org-idem",
    actorType: "user",
    scopes: ["platform.read"],
    issuedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  });
  const tools = createToolRegistry();
  tools.register(tool);
  const app = fastify();
  configure?.(app);
  registerToolRestRoutes(
    app,
    {
      tools,
      metrics: createPlatformMetrics(),
      tokenStore,
      idempotencyStore: new InMemoryIdempotencyStore(),
    },
    ["POST"],
  );
  const post = (key: string) =>
    app.inject({
      method: "POST",
      url: `/api/tools/${tool.id}`,
      headers: { authorization: "Bearer idem-token", "idempotency-key": key },
      payload: { subject: "hello" },
    });
  return { app, post, tokenStore };
}

describe("tool REST bearer authentication (CA4)", () => {
  it("answers an unknown bearer with 401 and a WWW-Authenticate challenge", async () => {
    const { app } = await setup(
      writeTool("auth.write", async () => ({ ok: true })),
      (app) => {
        app.setErrorHandler((error, request, reply) => {
          if (error instanceof CredentialAuthError) {
            return sendCredentialAuthError(reply, error, traceIdForRequest(request));
          }
          throw error;
        });
      },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/tools/auth.write",
      headers: { authorization: "Bearer revoked-token" },
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
    expect(response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    await app.close();
  });
});

describe("tool REST idempotency claims (CA3)", () => {
  it("executes concurrent identical requests once and reports the duplicate as in progress", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { app, post } = await setup(
      writeTool("idem.concurrent", async () => {
        calls += 1;
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { callNumber: calls };
      }),
    );

    const first = post("key-concurrent");
    await running;
    const duplicate = await post("key-concurrent");
    release();
    const completed = await first;
    const replay = await post("key-concurrent");

    expect(calls).toBe(1);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.headers["retry-after"]).toBe("2");
    expect(duplicate.json()).toMatchObject({ error: { code: "idempotency_in_progress" } });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual({ callNumber: 1 });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json()).toEqual({ callNumber: 1 });
    await app.close();
  });

  it.each([401, 403, 408, 429, 503])(
    "does not pin a %i failure to the key so a retry executes again",
    async (statusCode) => {
      let calls = 0;
      const { app, post } = await setup(
        writeTool("idem.transient", async () => {
          calls += 1;
          if (calls === 1) {
            throw Object.assign(new Error("Try again later."), {
              statusCode,
              retryAfterSeconds: 1,
            });
          }
          return { callNumber: calls };
        }),
      );

      const failed = await post("key-transient");
      const retried = await post("key-transient");

      expect(failed.statusCode).toBe(statusCode);
      expect(retried.statusCode).toBe(200);
      expect(retried.headers["idempotency-replayed"]).toBeUndefined();
      expect(retried.json()).toEqual({ callNumber: 2 });
      expect(calls).toBe(2);
      await app.close();
    },
  );

  it("replays deterministic client errors instead of executing again", async () => {
    let calls = 0;
    const { app, post } = await setup(
      writeTool("idem.invalid", async () => {
        calls += 1;
        throw Object.assign(new Error("Recipient is not allowed."), { statusCode: 422 });
      }),
    );

    const first = await post("key-invalid");
    const second = await post("key-invalid");

    expect(first.statusCode).toBe(422);
    expect(second.statusCode).toBe(422);
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(calls).toBe(1);
    await app.close();
  });
});

it("refuses cached results after the current token loses its scope", async () => {
  let calls = 0;
  const { app, post, tokenStore } = await setup(
    writeTool("auth.replay", async () => ({ privateResult: ++calls })),
  );
  try {
    expect((await post("scope-replay")).statusCode).toBe(200);
    await tokenStore.saveToken({
      token: "idem-token",
      clientId: "client-1",
      actorId: "user-idem",
      orgId: "org-idem",
      actorType: "user",
      scopes: [],
      issuedAt: new Date(),
      expiresAt: new Date("2099-01-01"),
    });
    expect((await post("scope-replay")).statusCode).toBe(403);
    expect(calls).toBe(1);
  } finally {
    await app.close();
  }
});
