import type { Actor, ToolDefinition } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import {
  InMemoryConfirmationGate,
  InMemoryPendingActionStore,
  type PendingActionRecord,
} from "./registry.js";

const schema = {
  parse: (value: unknown) => value,
  toJsonSchema: () => ({ type: "object" }),
};
const agent: Actor = {
  id: "agent-1",
  orgId: "org-1",
  type: "agent",
  scopes: ["visible.read"],
};

describe("Agent V2 negative-security boundary", () => {
  it("denies direct invocation of a tool hidden by the actor scope", async () => {
    let calls = 0;
    const registry = createToolRegistry();
    registry.register(
      tool({
        id: "hidden.write",
        permission: "hidden.write",
        sideEffects: "write",
        handler: async () => {
          calls += 1;
          return { changed: true };
        },
      }),
    );

    await expect(registry.listVisible(agent)).resolves.toEqual([]);
    await expect(registry.invoke("hidden.write", {}, { actor: agent })).resolves.toMatchObject({
      ok: false,
      statusCode: 403,
    });
    expect(calls).toBe(0);
  });

  it("rejects altered pending input before an approved action executes", async () => {
    const store = new TamperingPendingActionStore();
    const requester: Actor = {
      id: "requester-1",
      orgId: "org-1",
      type: "user",
      scopes: ["object.write"],
    };
    let calls = 0;
    const registry = createToolRegistry({
      confirmationGate: new InMemoryConfirmationGate(store),
      resolvePendingPrincipal: async () => ({ actor: requester }),
    });
    registry.register(
      tool({
        id: "object.rename",
        permission: "object.write",
        sideEffects: "write",
        confirmationRequired: true,
        handler: async () => {
          calls += 1;
          return { changed: true };
        },
      }),
    );

    const queued = await registry.invoke(
      "object.rename",
      { objectId: "object-1", name: "approved-name" },
      { actor: requester, enforceConfirmation: true },
    );
    if (!queued.ok || queued.status !== "pending_confirmation") {
      throw new Error("Expected a pending action.");
    }
    store.tamper();

    await expect(
      registry.approvePending(queued.pending.id, { actor: requester }),
    ).resolves.toMatchObject({
      ok: false,
      statusCode: 409,
      error: "Pending action input integrity check failed.",
    });
    expect(calls).toBe(0);
  });
});

class TamperingPendingActionStore extends InMemoryPendingActionStore {
  #tampered = false;

  tamper(): void {
    this.#tampered = true;
  }

  override async get(id: string): Promise<PendingActionRecord | null> {
    const record = await super.get(id);
    if (record === null || !this.#tampered) {
      return record;
    }
    return {
      ...record,
      input: { objectId: "object-1", name: "attacker-name" },
    };
  }
}

function tool(
  overrides: Partial<ToolDefinition> & Pick<ToolDefinition, "id" | "permission" | "handler">,
): ToolDefinition {
  return {
    description: overrides.id,
    inputSchema: schema,
    outputSchema: schema,
    sideEffects: "read",
    ...overrides,
  };
}
