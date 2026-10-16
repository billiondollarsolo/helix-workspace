import type { Actor } from "@helix/sdk-types";
import { BOT_ACCOUNT_SCOPES } from "@helix/contracts";
import { describe, expect, it, vi } from "vitest";
import { tierDefaults } from "../config/tier.js";
import { createToolRegistry } from "../tool-registry.js";
import { InMemoryConfirmationGate, InMemoryPendingActionStore } from "../tools/registry.js";
import type { BotAccountStore } from "./store.js";
import { createBotAccountTools } from "./tools.js";
import type { BotWorkspaceReader } from "./workspace.js";

const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "agent",
  scopes: ["platform.read", "agent.accounts.request"],
};
const manifest = {
  externalBotId: "juniper",
  displayName: "Juniper",
  purpose: "Everyday planning",
  email: "juniper@helix.local",
  scopes: [...BOT_ACCOUNT_SCOPES],
  apiKeyHash: "a".repeat(64),
};
function fixture() {
  const request = vi.fn(async () => ({ status: "pending", actorId: null, credentialId: null }));
  const approve = vi.fn();
  const registry = createToolRegistry({
    auditSink: { append: vi.fn(async () => undefined) },
    confirmationDefaults: tierDefaults.enterprise,
    confirmationGate: new InMemoryConfirmationGate(new InMemoryPendingActionStore()),
  });
  for (const tool of createBotAccountTools(
    { request, approve } as unknown as BotAccountStore,
    {} as BotWorkspaceReader,
  ))
    registry.register(tool);
  return { registry, request, approve };
}

describe("trusted installation enrollment", () => {
  it.each(["rest", "mcp"] as const)(
    "submits requests over %s without approving the account, even at enterprise tier",
    async (requestChannel) => {
      for (const type of ["agent", "service_account"] as const) {
        const f = fixture();
        const installation = { ...actor, type };
        const result = await f.registry.invoke("agent.account.request", manifest, {
          actor: installation,
          credentialId: "installation-credential",
          enforceConfirmation: true,
          policyContext: {
            requestChannel,
            effectiveClassification: "standard",
            sourceIds: [],
            containsUntrustedContext: true,
          },
        });
        expect(result).toMatchObject({
          ok: true,
          output: { request: { status: "pending", actorId: null, credentialId: null } },
        });
        expect(f.request).toHaveBeenCalledWith(installation, manifest);
        expect(f.approve).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["agent", "service_account"] as const)(
    "preserves an explicit always-confirm override for a %s credential",
    async (type) => {
      const f = fixture();
      expect(
        await f.registry.invoke("agent.account.request", manifest, {
          actor: { ...actor, type },
          credentialId: "installation-credential",
          credentialPolicy: { confirmationOverride: "always" },
          enforceConfirmation: true,
        }),
      ).toMatchObject({ ok: true, status: "pending_confirmation" });
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("denies ordinary bot credentials and invalid permission requests", async () => {
    const f = fixture();
    for (const [caller, input] of [
      [{ ...actor, scopes: [...BOT_ACCOUNT_SCOPES] }, manifest],
      [actor, { ...manifest, scopes: ["agent.accounts.request"] }],
      [actor, { ...manifest, scopes: ["admin.agents"] }],
    ] as const) {
      expect(
        await f.registry.invoke("agent.account.request", input, {
          actor: caller,
          credentialId: "credential",
          enforceConfirmation: true,
        }),
      ).toMatchObject({ ok: false });
    }
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does not let the installation approve accounts or gain standing administrative authority", async () => {
    const f = fixture();
    const result = await f.registry.invoke(
      "agent.account.approve",
      {
        requestId: actor.id,
        ownerActorId: actor.id,
        scopes: [...BOT_ACCOUNT_SCOPES],
        email: manifest.email,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
      {
        actor: { ...actor, scopes: ["platform.read", "agent.accounts.request", "admin.agents"] },
        credentialId: "installation-credential",
        enforceConfirmation: true,
      },
    );
    expect(result).toMatchObject({ ok: false, statusCode: 403 });
    expect(f.approve).not.toHaveBeenCalled();
    for (const id of [
      "agent.account.approve",
      "agent.account.reject",
      "agent.workspace.access.set",
    ]) {
      expect(f.registry.get(id)?.standingAuthorization).toBeUndefined();
    }
  });
});
