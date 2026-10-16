import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { InMemoryConfirmationGate, InMemoryPendingActionStore } from "../tools/registry.js";
import type { DriveStore } from "./store.js";
import { registerDriveTools } from "./tools.js";
const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const objectId = "33333333-3333-4333-8333-333333333333";
describe("drive collaboration authorization", () => {
  it("allows ordinary scoped collaboration, preserving explicit confirmation and destructive gates", async () => {
    const registry = createToolRegistry({
      confirmationGate: new InMemoryConfirmationGate(new InMemoryPendingActionStore()),
    });
    registerDriveTools(registry, { store: {} as DriveStore });
    const actor = {
      id: actorId,
      orgId,
      type: "agent" as const,
      scopes: ["drive.read", "drive.write"],
    };
    const options = { actor, credentialId: "credential", enforceConfirmation: true };
    for (const [id, input] of [
      ["drive.create", { kind: "folder", name: "Shared work" }],
      ["drive.upload", { name: "notes.txt", byteSize: 4 }],
      ["drive.share", { objectId, actorIds: [actorId], role: "reader" }],
    ] as const) {
      const result = await registry.explainPolicy(id, input, options);
      expect(result).toMatchObject({ decision: { outcome: "allow-automation" } });
    }
    expect(
      await registry.invoke(
        "drive.create",
        { kind: "folder", name: "Review" },
        { ...options, credentialPolicy: { confirmationOverride: "always" } },
      ),
    ).toMatchObject({ ok: true, status: "pending_confirmation" });
    expect(
      await registry.invoke(
        "drive.upload",
        { name: "No access", byteSize: 0 },
        { ...options, actor: { ...actor, scopes: ["drive.read"] } },
      ),
    ).toMatchObject({ ok: false, statusCode: 403 });
    for (const id of ["drive.link.create", "drive.delete"])
      expect(registry.get(id)?.standingAuthorization).toBeUndefined();
  });
});
