import { randomUUID } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import postgres from "postgres";
import { expect, it, vi } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { InMemoryConfirmationGate, InMemoryPendingActionStore } from "../tools/registry.js";
import { LiveStore } from "./store.js";
import { registerLiveTools } from "./tools.js";

it("renews only the scoped agent's lease without approval and honors explicit confirmation policy", async () => {
  const sql = postgres({ host: "127.0.0.1", port: 1 });
  const store = new LiveStore(sql);
  const heartbeat = vi.spyOn(store, "heartbeat").mockResolvedValue(undefined);
  const tools = createToolRegistry({
    confirmationGate: new InMemoryConfirmationGate(new InMemoryPendingActionStore()),
  });
  registerLiveTools(tools, store);
  const actor: Actor = {
    id: randomUUID(),
    orgId: randomUUID(),
    type: "agent",
    scopes: ["notifications.write"],
  };
  const input = { connectionId: randomUUID(), state: "working" };
  try {
    const result = await tools.invoke("presence.heartbeat", input, {
      actor,
      enforceConfirmation: true,
    });
    expect(result).toMatchObject({ ok: true, output: { ok: true } });
    expect(result).not.toHaveProperty("status", "pending_confirmation");
    expect(heartbeat).toHaveBeenCalledExactlyOnceWith(actor, input.connectionId, "working", false);
    expect(
      await tools.get("presence.heartbeat")?.standingAuthorization?.(input, actor),
    ).toMatchObject({ requestsPerDay: 6000 });
    expect(
      await tools.invoke("presence.heartbeat", input, {
        actor: { ...actor, scopes: [] },
        enforceConfirmation: true,
      }),
    ).toMatchObject({ ok: false, statusCode: 403 });
    expect(
      await tools.invoke("presence.heartbeat", { ...input, connectionId: "invalid" }, { actor }),
    ).toMatchObject({ ok: false, statusCode: 400 });
    expect(
      await tools.invoke("presence.heartbeat", input, {
        actor,
        enforceConfirmation: true,
        credentialPolicy: { confirmationOverride: "always" },
      }),
    ).toMatchObject({ ok: true, status: "pending_confirmation" });
    expect(heartbeat).toHaveBeenCalledTimes(1);
  } finally {
    await sql.end();
  }
});
