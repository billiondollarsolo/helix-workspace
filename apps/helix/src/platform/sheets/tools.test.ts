import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { InMemorySheetsStore } from "./store.js";
import { registerSheetsTools } from "./tools.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";

function readerActor(): Actor {
  return { id: actorId, orgId, type: "user", scopes: ["sheets.read"] };
}

function writerActor(): Actor {
  return { id: actorId, orgId, type: "user", scopes: ["sheets.read", "sheets.write"] };
}

function setup(): { registry: ReturnType<typeof createToolRegistry>; store: InMemorySheetsStore } {
  const store = new InMemorySheetsStore();
  const registry = createToolRegistry();
  registerSheetsTools(registry, { store });
  return { registry, store };
}

describe("sheets tools", () => {
  it("registers read tools as read-safe and write tools as write", () => {
    const { registry } = setup();
    expect(registry.get("sheets.list")).toMatchObject({
      id: "sheets.list",
      permission: "sheets.read",
      sideEffects: "read",
    });
    expect(registry.get("sheets.create")).toMatchObject({
      permission: "sheets.write",
      sideEffects: "write",
    });
    expect(registry.get("sheets.delete")?.confirmationRequired).toBe(true);
    expect(registry.get("sheets.tab.delete")?.confirmationRequired).toBe(true);
  });

  it("denies write tools to an actor without the sheets.write scope", async () => {
    const { registry } = setup();
    const result = await registry.invoke(
      "sheets.create",
      { title: "Blocked" },
      { actor: readerActor() },
    );
    expect(result.ok).toBe(false);
  });

  it("creates, gets, updates, and lists a spreadsheet", async () => {
    const { registry } = setup();
    const actor = writerActor();

    const created = await registry.invoke<{ readonly id: string; readonly tabs: unknown[] }>(
      "sheets.create",
      { title: "Renewals", tabNames: ["Customers", "Pipeline"] },
      { actor },
    );
    expect(created.ok).toBe(true);
    const sheetId = created.ok ? created.output.id : "";
    expect(created.ok ? created.output.tabs : []).toHaveLength(2);

    const fetched = await registry.invoke<{ readonly title: string }>(
      "sheets.get",
      { sheetId },
      { actor },
    );
    expect(fetched.ok && fetched.output.title).toBe("Renewals");

    const updated = await registry.invoke<{ readonly title: string }>(
      "sheets.update",
      { sheetId, title: "Renewals 2026" },
      { actor },
    );
    expect(updated.ok && updated.output.title).toBe("Renewals 2026");

    const listed = await registry.invoke<{ readonly total: number; readonly sheets: unknown[] }>(
      "sheets.list",
      {},
      { actor },
    );
    expect(listed.ok && listed.output.total).toBe(1);
  });

  it("manages tabs and batch cell edits through the tools", async () => {
    const { registry } = setup();
    const actor = writerActor();

    const created = await registry.invoke<{
      readonly id: string;
      readonly tabs: { readonly id: string }[];
    }>("sheets.create", { title: "Grid" }, { actor });
    const sheetId = created.ok ? created.output.id : "";
    const firstTabId = created.ok ? (created.output.tabs[0]?.id ?? "") : "";

    const newTab = await registry.invoke<{ readonly id: string; readonly name: string }>(
      "sheets.tab.create",
      { sheetId, name: "Q3" },
      { actor },
    );
    expect(newTab.ok && newTab.output.name).toBe("Q3");

    const cells = await registry.invoke<{ readonly cells: unknown[] }>(
      "sheets.cells.update",
      {
        tabId: firstTabId,
        edits: [
          { row: 0, col: 0, value: "Customer" },
          { row: 0, col: 1, value: "ARR" },
        ],
      },
      { actor },
    );
    expect(cells.ok && cells.output.cells).toHaveLength(2);

    const tabRead = await registry.invoke<{ readonly cells: unknown[] }>(
      "sheets.tab.get",
      { tabId: firstTabId },
      { actor },
    );
    expect(tabRead.ok && tabRead.output.cells).toHaveLength(2);

    const deleted = await registry.invoke<{ readonly tabId: string }>(
      "sheets.tab.delete",
      { tabId: firstTabId },
      { actor },
    );
    expect(deleted.ok && deleted.output.tabId).toBe(firstTabId);
  });

  it("soft-deletes a spreadsheet", async () => {
    const { registry } = setup();
    const actor = writerActor();
    const created = await registry.invoke<{ readonly id: string }>(
      "sheets.create",
      { title: "Temp" },
      { actor },
    );
    const sheetId = created.ok ? created.output.id : "";

    const deleted = await registry.invoke<{ readonly deletedAt: string | null }>(
      "sheets.delete",
      { sheetId },
      { actor },
    );
    expect(deleted.ok && deleted.output.deletedAt).not.toBeNull();

    const fetch = await registry.invoke("sheets.get", { sheetId }, { actor });
    expect(fetch.ok).toBe(false);
  });

  it("rejects invalid input via the zod schema", async () => {
    const { registry } = setup();
    const result = await registry.invoke(
      "sheets.create",
      { title: "" },
      { actor: writerActor() },
    );
    expect(result.ok).toBe(false);
  });
});
