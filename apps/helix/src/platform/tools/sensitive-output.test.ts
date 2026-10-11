import type { Actor, ToolDefinition } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { registerAppPasswordTools } from "../auth/app-passwords.js";
import { registerAgentCredentialTools } from "../auth/tools.js";
import { tierDefaults } from "../config/tier.js";
import { registerDriveS3KeyTools, registerDriveTools } from "../drive/index.js";
import { createToolRegistry } from "../tool-registry.js";
import { InMemoryConfirmationGate, InMemoryPendingActionStore } from "./registry.js";
import { REDACTED_TOOL_OUTPUT, redactToolInvokeResult } from "./sensitive-output.js";

const schema = { parse: (value: unknown) => value, toJsonSchema: () => ({ type: "object" }) };
const actor: Actor = { id: "user-1", orgId: "org-1", type: "user", scopes: ["drive.write"] };

const mintTool: ToolDefinition = {
  id: "secret.mint",
  description: "Mint a credential.",
  inputSchema: schema,
  outputSchema: schema,
  permission: "drive.write",
  sideEffects: "write",
  confirmationRequired: true,
  sensitiveOutputKeys: ["secretAccessKey"],
  handler: async () => ({ accessKeyId: "HLXAAAAAAAAAAAAAAAAA", secretAccessKey: "s3cr3t" }),
};

describe("sensitive tool output", () => {
  it("returns the secret live but never persists it with the pending action", async () => {
    const store = new InMemoryPendingActionStore();
    const registry = createToolRegistry({
      confirmationGate: new InMemoryConfirmationGate(store),
      confirmationDefaults: tierDefaults.personal,
      resolvePendingPrincipal: async (record: { readonly requesterPrincipal: Actor }) => ({
        actor: record.requesterPrincipal,
      }),
    });
    registry.register(mintTool);
    const pending = await registry.invoke("secret.mint", {}, { actor, enforceConfirmation: true });
    if (!pending.ok || pending.status !== "pending_confirmation") {
      throw new Error("expected pending confirmation");
    }
    const approved = await registry.approvePending(pending.pending.id, { actor });
    expect(approved).toMatchObject({ ok: true, output: { secretAccessKey: "s3cr3t" } });

    const refetched = await registry.getPendingAction(pending.pending.id, { actor });
    expect(JSON.stringify(refetched)).not.toContain("s3cr3t");
    expect(refetched).toMatchObject({ ok: true, pending: { status: "executed" } });
    const stored = await store.get(pending.pending.id);
    expect(stored?.status).toBe("executed");
    expect(stored?.result).toEqual({
      accessKeyId: "HLXAAAAAAAAAAAAAAAAA",
      secretAccessKey: REDACTED_TOOL_OUTPUT,
    });
  });

  it("redacts cached idempotent results and leaves other tools untouched", () => {
    const result = { ok: true, status: "executed", output: { password: "pw", id: "1" } } as const;
    expect(redactToolInvokeResult({ sensitiveOutputKeys: ["password"] }, result)).toEqual({
      ...result,
      output: { password: REDACTED_TOOL_OUTPUT, id: "1" },
    });
    expect(redactToolInvokeResult({}, result)).toBe(result);
    expect(redactToolInvokeResult(undefined, { ok: false, error: "x" })).toEqual({
      ok: false,
      error: "x",
    });
  });

  it("marks every credential-minting tool's secret as sensitive", () => {
    const registry = createToolRegistry();
    const unused = {} as never;
    registerAppPasswordTools(registry, unused);
    registerAgentCredentialTools(registry, unused);
    registerDriveTools(registry, unused);
    registerDriveS3KeyTools(registry, unused);
    expect(registry.get("app.passwords.create")?.sensitiveOutputKeys).toEqual(["password"]);
    expect(registry.get("agent.credentials.create")?.sensitiveOutputKeys).toEqual(["secret"]);
    expect(registry.get("agent.credentials.rotate")?.sensitiveOutputKeys).toEqual(["secret"]);
    expect(registry.get("drive.link.create")?.sensitiveOutputKeys).toEqual(["token"]);
    expect(registry.get("drive.s3-keys.create")?.sensitiveOutputKeys).toEqual(["secretAccessKey"]);
  });
});
