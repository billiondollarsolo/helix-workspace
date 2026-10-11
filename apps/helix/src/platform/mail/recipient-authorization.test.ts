import type { ToolContext } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { MailExternalRecipientForbiddenError } from "./errors.js";
import { requireTenantMailRecipients } from "./recipient-authorization.js";

describe("tenant Mail recipient authorization", () => {
  const actor = { id: "sender", orgId: "tenant", type: "user" as const, scopes: ["mail.send"] };
  const resolve = vi.fn(async () => ["HELIX.LOCAL"]);

  it("allows verified tenant domains and requires mail.external for To, Cc and Bcc elsewhere", async () => {
    const ctx = { actor } as unknown as ToolContext;
    await requireTenantMailRecipients({ to: ["theo@helix.local"] }, ctx, resolve);
    expect(resolve).toHaveBeenCalledWith("tenant");
    for (const field of ["to", "cc", "bcc"]) {
      await expect(
        requireTenantMailRecipients({ [field]: [{ address: "other@foreign.test" }] }, ctx, resolve),
      ).rejects.toBeInstanceOf(MailExternalRecipientForbiddenError);
    }
  });

  it("checks the composite scope against the actor's grants, never the tool PDP", async () => {
    // The tool PDP only has rules for a tool's base permission, so routing the
    // composite scope there denied every external send under Cerbos.
    const requirePermission = vi.fn(async () => {
      throw new Error("tool PDP must not be consulted for mail.external");
    });
    const ctx = {
      actor: { ...actor, scopes: ["mail.send", "mail.external"] },
      requirePermission,
    } as unknown as ToolContext;
    await expect(
      requireTenantMailRecipients({ to: ["bob@peer.test"] }, ctx, resolve),
    ).resolves.toBeUndefined();
    expect(requirePermission).not.toHaveBeenCalled();
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
