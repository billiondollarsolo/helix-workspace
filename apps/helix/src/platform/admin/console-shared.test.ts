import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { auditAdminAction, canReadAdminConsole, canWriteAdminConsole } from "./console-shared.js";

const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user",
  scopes: [],
};

describe("delegated admin authorization", () => {
  it("matches exact resources and never widens to a peer", () => {
    const delegated: Actor = {
      ...actor,
      roleBindings: [
        {
          roleId: "33333333-3333-4333-8333-333333333333",
          allow: ["admin.domains"],
          deny: [],
          scope: { type: "resource", resourceType: "domain", id: "domain-a" },
        },
      ],
    };

    expect(
      canWriteAdminConsole(delegated, "admin.domains", {
        type: "domain",
        id: "domain-a",
        orgId: actor.orgId,
      }),
    ).toBe(true);
    expect(
      canWriteAdminConsole(delegated, "admin.domains", {
        type: "domain",
        id: "domain-b",
        orgId: actor.orgId,
      }),
    ).toBe(false);
  });

  it("makes an exact deny override direct and wildcard admin scopes", () => {
    const denied: Actor = {
      ...actor,
      scopes: ["admin.console.write", "admin.*"],
      roleBindings: [
        {
          roleId: "44444444-4444-4444-8444-444444444444",
          allow: [],
          deny: ["admin.groups"],
          scope: { type: "group", id: "group-a" },
        },
      ],
    };
    const resource = { type: "group", id: "group-a", orgId: actor.orgId } as const;

    expect(canReadAdminConsole(denied, "admin.groups", resource)).toBe(false);
    expect(canWriteAdminConsole(denied, "admin.groups", resource)).toBe(false);
  });
});

describe("privileged audit", () => {
  const record = {
    orgId: actor.orgId,
    actorId: actor.id,
    verb: "admin.test.updated",
    objectType: "test",
  };

  it("fails closed when durable audit is unavailable", async () => {
    await expect(
      auditAdminAction(
        { append: async () => Promise.reject(new Error("audit unavailable")) },
        record,
      ),
    ).rejects.toThrow("audit unavailable");
  });
});
