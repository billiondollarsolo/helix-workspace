import type { ToolContext } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { requireTenantMailRecipients } from "./recipient-authorization.js";

describe("tenant Mail recipient authorization", () => {
  const actor = { id: "sender", orgId: "tenant", type: "user" as const, scopes: ["mail.send"] };
  it("allows verified tenant domains and requires external permission for To, Cc and Bcc elsewhere", async () => {
    const requirePermission = vi.fn(async () => {
      throw new Error("mail.external denied");
    });
    const ctx = { actor, requirePermission } as unknown as ToolContext;
    const resolve = vi.fn(async () => ["HELIX.LOCAL"]);
    await requireTenantMailRecipients({ to: ["theo@helix.local"] }, ctx, resolve);
    expect(resolve).toHaveBeenCalledWith("tenant");
    expect(requirePermission).not.toHaveBeenCalled();
    for (const field of ["to", "cc", "bcc"]) {
      await expect(
        requireTenantMailRecipients({ [field]: [{ address: "other@foreign.test" }] }, ctx, resolve),
      ).rejects.toThrow("mail.external denied");
    }
    expect(requirePermission).toHaveBeenCalledTimes(3);
  });
  it("fails closed when domain lookup fails", async () => {
    await expect(
      requireTenantMailRecipients(
        { to: ["theo@helix.local"] },
        { actor } as unknown as ToolContext,
        async () => {
          throw new Error("offline");
        },
      ),
    ).rejects.toThrow("offline");
  });
});
