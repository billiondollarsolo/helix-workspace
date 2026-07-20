import { describe, expect, it, vi } from "vitest";
import {
  createDefaultTrashSyncRegistry,
  createTrashSyncRegistry,
  type TrashSyncInput,
} from "./trash-sync.js";

describe("trash-sync registry", () => {
  it("runs a registered handler for the matching app", async () => {
    const docs = vi.fn(async (_input: TrashSyncInput) => undefined);
    const registry = createTrashSyncRegistry({ docs });
    const input: TrashSyncInput = {
      sql: (() => Promise.resolve([])) as TrashSyncInput["sql"],
      orgId: "org",
      objectId: "obj",
      deletedAt: new Date("2026-07-18T00:00:00.000Z"),
    };
    await registry.run("docs", input);
    expect(docs).toHaveBeenCalledOnce();
    expect(docs).toHaveBeenCalledWith(input);
  });

  it("is a no-op for an unregistered app", async () => {
    const docs = vi.fn(async () => undefined);
    const registry = createTrashSyncRegistry({ docs });
    await registry.run("unknown", {
      sql: (() => Promise.resolve([])) as TrashSyncInput["sql"],
      orgId: "org",
      objectId: "obj",
      deletedAt: new Date(),
    });
    expect(docs).not.toHaveBeenCalled();
  });

  it("passes null deletedAt for restore and a Date for trash", async () => {
    const seen: Array<Date | null> = [];
    const registry = createTrashSyncRegistry({
      sheets: async ({ deletedAt }) => {
        seen.push(deletedAt);
      },
    });
    await registry.run("sheets", {
      sql: (() => Promise.resolve([])) as TrashSyncInput["sql"],
      orgId: "o",
      objectId: "x",
      deletedAt: null,
    });
    const trashAt = new Date("2026-01-01T00:00:00.000Z");
    await registry.run("sheets", {
      sql: (() => Promise.resolve([])) as TrashSyncInput["sql"],
      orgId: "o",
      objectId: "x",
      deletedAt: trashAt,
    });
    expect(seen).toEqual([null, trashAt]);
  });

  it("default registry registers docs/sheets/slides", () => {
    const registry = createDefaultTrashSyncRegistry();
    expect(registry.has("docs")).toBe(true);
    expect(registry.has("sheets")).toBe(true);
    expect(registry.has("slides")).toBe(true);
    expect(registry.has("unknown")).toBe(false);
  });
});
