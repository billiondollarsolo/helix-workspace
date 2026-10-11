import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import type { PendingActionRecord } from "../platform/tools/registry.js";
import { createPendingPrincipalResolver } from "./pending-principal.js";

const memberRole = "d2080000-0000-4000-8000-0000000000c1";

function fakeSql(rows: readonly unknown[]) {
  return vi.fn(() => Promise.resolve(rows)) as unknown as postgres.Sql;
}

const record = {
  requesterActorId: "d2080000-0000-4000-8000-0000000000a1",
  requesterCredentialId: null,
  orgId: "d2080000-0000-4000-8000-00000000000a",
  requesterIp: null,
} as unknown as PendingActionRecord;

describe("pending principal", () => {
  it("runs an approved call as the person with their role bindings", async () => {
    const resolve = createPendingPrincipalResolver(
      fakeSql([
        {
          id: record.requesterActorId,
          org_id: record.orgId,
          type: "user",
          display_name: "Person",
          email: "person@example.test",
          scopes: ["smtp"],
          role_bindings: [
            {
              roleId: memberRole,
              allow: ["profile.read", "profile.write"],
              deny: [],
              scopeType: "org",
              scopeId: null,
              resourceType: null,
            },
          ],
        },
      ]),
      { findById: vi.fn() },
    );
    const principal = await resolve(record, { actor: {} as never });
    expect(principal?.actor).toMatchObject({
      id: record.requesterActorId,
      scopes: ["smtp"],
      roleBindings: [
        { roleId: memberRole, allow: ["profile.read", "profile.write"], scope: { type: "org" } },
      ],
    });
  });

  it("returns nothing when the person is gone", async () => {
    const resolve = createPendingPrincipalResolver(fakeSql([]), { findById: vi.fn() });
    await expect(resolve(record, { actor: {} as never })).resolves.toBeNull();
  });
});
