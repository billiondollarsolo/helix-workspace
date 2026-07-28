import { describe, expect, it } from "vitest";
import { InMemoryConfirmationGate, InMemoryPendingActionStore } from "./registry.js";

describe("InMemoryConfirmationGate", () => {
  it("permits only the credential owner or a same-org human admin and never self-approval", async () => {
    const gate = new InMemoryConfirmationGate();
    const requester = {
      id: "agent-1",
      orgId: "org-1",
      type: "agent" as const,
      scopes: ["platform.write"],
    };
    const pending = await gate.queue({
      tool: {
        id: "platform.write",
        description: "Write",
        permission: "platform.write",
        sideEffects: "write",
        inputSchema: { parse: (value) => value, toJsonSchema: () => ({}) },
        outputSchema: { parse: (value) => value, toJsonSchema: () => ({}) },
        handler: async () => ({}),
      },
      actor: requester,
      requesterCredentialId: "credential-1",
      approvalOwnerActorId: "owner-1",
      input: { objectId: "object-1", secret: "not-public" },
    });

    expect(pending).not.toHaveProperty("input");
    await expect(gate.approve({ id: pending.id, actor: requester })).resolves.toBeNull();
    await expect(
      gate.approve({
        id: pending.id,
        actor: { id: "user-2", orgId: "org-1", type: "user" },
      }),
    ).resolves.toBeNull();
    await expect(
      gate.approve({
        id: pending.id,
        actor: {
          id: "audit-admin",
          orgId: "org-1",
          type: "user",
          scopes: ["admin.audit"],
        },
      }),
    ).resolves.toBeNull();
    await expect(
      gate.approve({
        id: pending.id,
        actor: { id: "owner-1", orgId: "org-2", type: "user" },
      }),
    ).resolves.toBeNull();
    await expect(
      gate.approve({
        id: pending.id,
        actor: { id: "owner-1", orgId: "org-1", type: "user" },
      }),
    ).resolves.toMatchObject({ status: "approved", approverActorId: "owner-1" });
  });

  it("persists pending actions using pending_actions fields and supports approval", async () => {
    const store = new InMemoryPendingActionStore();
    const gate = new InMemoryConfirmationGate(store);
    const pending = await gate.queue({
      tool: {
        id: "platform.test",
        description: "Test tool",
        permission: "platform.write",
        sideEffects: "write",
        inputSchema: {
          parse: () => ({ value: true }),
          toJsonSchema: () => ({ type: "object" }),
        },
        outputSchema: {
          parse: (value) => value,
          toJsonSchema: () => ({ type: "object" }),
        },
        handler: async () => ({}),
      },
      actor: {
        id: "actor-1",
        orgId: "org-1",
        type: "user",
      },
      input: { value: true },
      traceId: "trace-create-1",
    });

    expect(pending.status).toBe("pending_confirmation");
    expect(pending.traceId).toBe("trace-create-1");
    await expect(
      gate.get({
        id: pending.id,
        actor: {
          id: "actor-1",
          orgId: "org-1",
          type: "user",
        },
      }),
    ).resolves.toMatchObject({
      preview: { toolId: "platform.test", action: "platform.write" },
    });
    expect(await store.get(pending.id)).toMatchObject({
      traceId: "trace-create-1",
      result: null,
      error: null,
    });

    const approved = await gate.approve({
      id: pending.id,
      actor: {
        id: "actor-1",
        orgId: "org-1",
        type: "user",
      },
    });

    expect(approved?.status).toBe("approved");

    await gate.claimExecution({
      id: pending.id,
      approver: {
        id: "actor-1",
        orgId: "org-1",
        type: "user",
      },
      executionActorId: "actor-1",
    });
    await gate.completeExecution({
      id: pending.id,
      executionActorId: "actor-1",
      traceId: "trace-run-1",
      result: { ok: true },
    });

    expect(await store.get(pending.id)).toMatchObject({
      traceId: "trace-run-1",
      result: { ok: true },
      error: null,
    });
  });

  it("persists approved execution errors", async () => {
    const store = new InMemoryPendingActionStore();
    const gate = new InMemoryConfirmationGate(store);
    const actor = {
      id: "actor-1",
      orgId: "org-1",
      type: "user" as const,
    };
    const pending = await gate.queue({
      tool: {
        id: "platform.test",
        description: "Test tool",
        permission: "platform.write",
        sideEffects: "write",
        inputSchema: {
          parse: () => ({ value: true }),
          toJsonSchema: () => ({ type: "object" }),
        },
        outputSchema: {
          parse: (value) => value,
          toJsonSchema: () => ({ type: "object" }),
        },
        handler: async () => ({}),
      },
      actor,
      input: { value: true },
    });
    await gate.approve({ id: pending.id, actor });
    await gate.claimExecution({
      id: pending.id,
      approver: actor,
      executionActorId: actor.id,
    });

    await gate.completeExecution({
      id: pending.id,
      executionActorId: actor.id,
      error: "Tool invocation failed",
    });

    expect(await store.get(pending.id)).toMatchObject({
      result: null,
      error: "Tool invocation failed",
    });
  });

  it("only returns pending actions to the owning actor and org", async () => {
    const store = new InMemoryPendingActionStore();
    const gate = new InMemoryConfirmationGate(store);
    const actor = {
      id: "actor-1",
      orgId: "org-1",
      type: "agent" as const,
    };
    const pending = await gate.queue({
      tool: {
        id: "platform.write",
        description: "Write tool",
        permission: "platform.write",
        sideEffects: "write",
        inputSchema: {
          parse: () => ({ value: true }),
          toJsonSchema: () => ({ type: "object" }),
        },
        outputSchema: {
          parse: (value) => value,
          toJsonSchema: () => ({ type: "object" }),
        },
        handler: async () => ({}),
      },
      actor,
      input: { value: true },
    });

    await expect(gate.get({ id: pending.id, actor })).resolves.toMatchObject({
      id: pending.id,
      status: "pending_confirmation",
    });
    await expect(
      gate.get({
        id: pending.id,
        actor: { ...actor, id: "actor-2" },
      }),
    ).resolves.toBeNull();
    await expect(
      gate.get({
        id: pending.id,
        actor: { ...actor, orgId: "org-2" },
      }),
    ).resolves.toBeNull();
  });
});
