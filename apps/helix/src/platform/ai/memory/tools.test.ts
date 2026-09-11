import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { AllowAllToolAccessPolicy } from "../../permissions/tool-access.js";
import { createToolRegistry } from "../../tool-registry.js";
import { InMemoryMemoryStore } from "./in-memory.js";
import { registerMemoryTools } from "./tools.js";

const actor: Actor = {
  id: "actor",
  orgId: "org",
  type: "user",
  scopes: ["assistant.read", "assistant.memory"],
};

describe("native memory tools", () => {
  it("stores, lists, searches, updates, and deletes opted-in memories", async () => {
    const store = new InMemoryMemoryStore();
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    registerMemoryTools(tools, store);
    const addedResult = await tools.invoke(
      "memory.add",
      { content: "Lives in ZIP 20882" },
      { actor },
    );
    expect(addedResult.ok).toBe(true);
    if (!addedResult.ok) return;
    const added = addedResult.output as { id: string; content: string };
    expect(added.content).toContain("20882");
    const listed = await tools.invoke("memory.list", { limit: 10 }, { actor });
    expect(listed.ok && listed.output).toMatchObject({
      items: [{ content: expect.stringContaining("20882") }],
    });
    const found = await tools.invoke("memory.search", { query: "ZIP" }, { actor });
    expect(found.ok && (found.output as { items: { id: string }[] }).items[0]?.id).toBe(added.id);
    await tools.invoke(
      "memory.update",
      { id: added.id, content: "Lives in Gaithersburg MD" },
      {
        actor,
      },
    );
    const updated = await tools.invoke("memory.search", { query: "Gaithersburg" }, { actor });
    expect(updated.ok && updated.output).toMatchObject({
      items: [{ content: expect.stringContaining("Gaithersburg") }],
    });
    const deleted = await tools.invoke("memory.delete", { id: added.id }, { actor });
    expect(deleted.ok && deleted.output).toEqual({ deleted: 1 });
  });
});
