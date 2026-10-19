import type { Actor, ToolContext, ToolDefinition } from "@helix/sdk-types";
import {
  pendingMailReviewResultSchema,
  pendingActionReviewResultSchema,
  pendingActionQueueSchema,
} from "@helix/contracts";
import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryOAuthClientStore } from "../platform/auth/oauth.js";
import { createToolRegistry } from "../platform/tool-registry.js";
import {
  InMemoryConfirmationGate,
  InMemoryPendingActionStore,
} from "../platform/tools/registry.js";
import { registerActionStatusRoutes, registerPendingActionMutationRoutes } from "./tool-routes.js";

const owner: Actor = {
  id: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000010",
  type: "user",
  scopes: ["mail.send"],
};
const agent: Actor = { ...owner, id: "00000000-0000-4000-8000-000000000002", type: "agent" };
const passthrough = { parse: (input: unknown) => input, toJsonSchema: () => ({ type: "object" }) };

async function setup(toolId = "mail.send") {
  const handler = vi.fn(async (_input: unknown, _context: ToolContext) => ({
    id: "outbound-fixture",
  }));
  const tool: ToolDefinition = {
    id: toolId,
    description: "Send email",
    permission: "mail.send",
    sideEffects: "external_communication",
    inputSchema: passthrough,
    outputSchema: passthrough,
    handler,
  };
  const tools = createToolRegistry({
    confirmationGate: new InMemoryConfirmationGate(new InMemoryPendingActionStore()),
    resolvePendingPrincipal: async (record) => ({ actor: record.requesterPrincipal }),
  });
  tools.register(tool);
  const queued = await tools.invoke(
    toolId,
    {
      from: { address: "atlas@example.test", name: "Atlas" },
      to: [{ address: "mike@example.test" }],
      subject: "Review this email",
      bodyText: "Exact email body",
      metadata: { secret: "hidden" },
    },
    { actor: agent, credentialOwnerActorId: owner.id, enforceConfirmation: true },
  );
  if (!queued.ok || queued.status !== "pending_confirmation")
    throw new Error(JSON.stringify(queued));
  const store = new InMemoryOAuthClientStore();
  const outsider: Actor = { ...owner, id: "00000000-0000-4000-8000-000000000003" };
  const foreign: Actor = { ...owner, orgId: "00000000-0000-4000-8000-000000000099" };
  for (const [token, actor] of [
    ["owner", owner],
    ["agent", agent],
    ["outsider", outsider],
    ["foreign", foreign],
  ] as const)
    await store.saveToken({
      token,
      clientId: token,
      actorId: actor.id,
      orgId: actor.orgId,
      actorType: actor.type,
      scopes: actor.scopes ?? [],
      issuedAt: new Date(),
      expiresAt: new Date("2099-01-01"),
    });
  const app = fastify();
  registerActionStatusRoutes(app, { tools, tokenStore: store });
  registerPendingActionMutationRoutes(app, { tools, tokenStore: store });
  return { app, tools, id: queued.pending.id, handler };
}

describe("human action queue", () => {
  it("lists only the human's actionable requests without message bodies, inputs or credential metadata", async () => {
    const { app, id, handler } = await setup();
    try {
      const response = await app.inject({
        url: "/actions",
        headers: { authorization: "Bearer owner" },
      });
      expect(response.statusCode).toBe(200);
      expect(pendingActionQueueSchema.parse(response.json())).toMatchObject({
        total: 1,
        items: [{ id }],
      });
      for (const secret of ["Exact email body", "hidden", "requesterCredentialId", "inputHash"])
        expect(response.body).not.toContain(secret);
      for (const token of ["outsider", "foreign"])
        expect(
          (
            await app.inject({ url: "/actions", headers: { authorization: `Bearer ${token}` } })
          ).json(),
        ).toEqual({ total: 0, items: [] });
      expect(
        (await app.inject({ url: "/actions", headers: { authorization: "Bearer agent" } }))
          .statusCode,
      ).toBe(403);
      expect(handler).not.toHaveBeenCalled();
      await app.inject({
        method: "POST",
        url: `/api/tools/pending/${id}/cancel`,
        headers: { authorization: "Bearer owner" },
        payload: {},
      });
      expect(
        (await app.inject({ url: "/actions", headers: { authorization: "Bearer owner" } })).json(),
      ).toEqual({ total: 0, items: [] });
    } finally {
      await app.close();
    }
  });

  it("counts all authorized requests, paginates and hides expired requests before the expiry worker runs", async () => {
    const { app, tools, handler } = await setup("drive.rename");
    try {
      for (let index = 0; index < 51; index++)
        await tools.invoke(
          "drive.rename",
          { objectId: `object-${String(index)}` },
          { actor: agent, credentialOwnerActorId: owner.id, enforceConfirmation: true },
        );
      const first = (
        await app.inject({ url: "/actions", headers: { authorization: "Bearer owner" } })
      ).json<{ items: { id: string }[]; total: number }>();
      const last = (
        await app.inject({ url: "/actions?offset=50", headers: { authorization: "Bearer owner" } })
      ).json<{ items: { id: string }[]; total: number }>();
      expect(first.total).toBe(52);
      expect(first.items).toHaveLength(50);
      expect(last.total).toBe(52);
      expect(last.items).toHaveLength(2);
      expect(new Set([...first.items, ...last.items].map((item) => item.id)).size).toBe(52);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect(
        (await app.inject({ url: "/actions", headers: { authorization: "Bearer owner" } })).json(),
      ).toEqual({ total: 0, items: [] });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });
});

describe("human email review", () => {
  it("shows the exact stored message to its owner without executing or leaking metadata", async () => {
    const { app, id, handler } = await setup();
    try {
      const response = await app.inject({
        url: `/actions/${id}/review`,
        headers: { authorization: "Bearer owner" },
      });
      expect(response.statusCode).toBe(200);
      const result = pendingMailReviewResultSchema.parse(response.json());
      expect(result.review).toMatchObject({
        subject: "Review this email",
        bodyText: "Exact email body",
        to: [{ address: "mike@example.test" }],
      });
      expect(response.body).not.toContain("hidden");
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("reviews a non-email action with redacted arguments and executes it once as the requester", async () => {
    const { app, id, handler } = await setup("drive.rename");
    try {
      const response = await app.inject({
        url: `/actions/${id}/review`,
        headers: { authorization: "Bearer owner" },
      });
      expect(response.statusCode).toBe(200);
      expect(pendingActionReviewResultSchema.parse(response.json())).toMatchObject({
        action: { toolId: "drive.rename" },
        review: {
          kind: "action",
          input: { metadata: "[redacted]" },
          preview: { toolId: "drive.rename" },
        },
      });
      expect(response.body).not.toContain("hidden");
      expect(handler).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/tools/pending/${id}/approve`,
            headers: { authorization: "Bearer owner" },
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[1].actor.id).toBe(agent.id);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/tools/pending/${id}/approve`,
            headers: { authorization: "Bearer owner" },
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it("denies agent review/self-approval and hides the request from other people and tenants", async () => {
    const { app, id, handler } = await setup();
    try {
      for (const [token, status] of [
        ["agent", 403],
        ["outsider", 404],
        ["foreign", 404],
      ] as const) {
        const response = await app.inject({
          url: `/actions/${id}/review`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(status);
        expect(response.body).not.toContain("Exact email body");
      }
      const status = await app.inject({
        url: `/actions/${id}`,
        headers: { authorization: "Bearer agent" },
      });
      expect(status.statusCode).toBe(200);
      expect(status.body).not.toContain("Exact email body");
      const approval = await app.inject({
        method: "POST",
        url: `/api/tools/pending/${id}/approve`,
        headers: { authorization: "Bearer agent" },
        payload: {},
      });
      expect(approval.statusCode).toBe(404);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("executes as the agent only after its human owner approves", async () => {
    const { app, id, handler } = await setup();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/tools/pending/${id}/approve`,
        headers: { authorization: "Bearer owner" },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0]?.[1]).toMatchObject({ actor: { id: agent.id, type: "agent" } });
    } finally {
      await app.close();
    }
  });
});
