import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InMemorySheetsStore,
  PostgresSheetsStore,
  SheetsNotFoundError,
  SheetsValidationError,
} from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const otherActorId = "33333333-3333-4333-8333-333333333333";

describe("InMemorySheetsStore", () => {
  it("creates a sheet with a default tab", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Renewals" });

    expect(sheet.title).toBe("Renewals");
    expect(sheet.ownerActorId).toBe(actorId);
    expect(sheet.deletedAt).toBeNull();
    expect(sheet.tabs).toHaveLength(1);
    expect(sheet.tabs[0]?.name).toBe("Sheet1");
    expect(sheet.tabs[0]?.position).toBe(0);
  });

  it("creates a sheet with named tabs in order", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({
      orgId,
      actorId,
      title: "Pipeline",
      tabNames: ["Customers", "Pipeline", "Lost"],
    });

    expect(sheet.tabs.map((tab) => tab.name)).toEqual(["Customers", "Pipeline", "Lost"]);
    expect(sheet.tabs.map((tab) => tab.position)).toEqual([0, 1, 2]);
  });

  it("rejects empty and overlong titles", async () => {
    const store = new InMemorySheetsStore();
    await expect(store.createSheet({ orgId, actorId, title: "   " })).rejects.toBeInstanceOf(
      SheetsValidationError,
    );
    await expect(
      store.createSheet({ orgId, actorId, title: "x".repeat(256) }),
    ).rejects.toBeInstanceOf(SheetsValidationError);
  });

  it("lists only sheets visible to the actor with pagination and search", async () => {
    const store = new InMemorySheetsStore();
    await store.createSheet({ orgId, actorId, title: "Alpha report" });
    await store.createSheet({ orgId, actorId, title: "Beta report" });
    await store.createSheet({ orgId, actorId: otherActorId, title: "Gamma" });

    const all = await store.listSheets({ orgId, actorId, limit: 50, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.sheets).toHaveLength(2);

    const searched = await store.listSheets({
      orgId,
      actorId,
      query: "beta",
      limit: 50,
      offset: 0,
    });
    expect(searched.total).toBe(1);
    expect(searched.sheets[0]?.title).toBe("Beta report");

    const paged = await store.listSheets({ orgId, actorId, limit: 1, offset: 1 });
    expect(paged.total).toBe(2);
    expect(paged.sheets).toHaveLength(1);
  });

  it("hides another actor's sheet from get/update/delete", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Private" });

    expect(
      await store.getSheet({ orgId, actorId: otherActorId, sheetId: sheet.id }),
    ).toBeNull();
    expect(
      await store.updateSheet({
        orgId,
        actorId: otherActorId,
        sheetId: sheet.id,
        title: "Hijacked",
      }),
    ).toBeNull();
    expect(
      await store.deleteSheet({ orgId, actorId: otherActorId, sheetId: sheet.id }),
    ).toBeNull();
  });

  it("soft-deletes a sheet so it no longer lists", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Temp" });

    const deleted = await store.deleteSheet({ orgId, actorId, sheetId: sheet.id });
    expect(deleted?.deletedAt).toBeInstanceOf(Date);

    const list = await store.listSheets({ orgId, actorId, limit: 50, offset: 0 });
    expect(list.total).toBe(0);
    expect(await store.getSheet({ orgId, actorId, sheetId: sheet.id })).toBeNull();
  });

  it("creates, updates, and reorders tabs", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Book" });

    const tab = await store.createTab({ orgId, actorId, sheetId: sheet.id, name: "Q3" });
    expect(tab.position).toBe(1);

    const updated = await store.updateTab({ orgId, actorId, tabId: tab.id, name: "Q4", position: 0 });
    expect(updated?.name).toBe("Q4");
    expect(updated?.position).toBe(0);
  });

  it("refuses to delete the last remaining tab", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Single" });
    const tabId = sheet.tabs[0]?.id ?? "";

    await expect(store.deleteTab({ orgId, actorId, tabId })).rejects.toBeInstanceOf(
      SheetsValidationError,
    );
  });

  it("deletes a non-last tab and drops its cells", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Book", tabNames: ["A", "B"] });
    const tabB = sheet.tabs[1];
    if (tabB === undefined) {
      throw new Error("expected two tabs");
    }
    await store.updateCells({
      orgId,
      actorId,
      tabId: tabB.id,
      edits: [{ row: 0, col: 0, value: "x" }],
    });

    const deleted = await store.deleteTab({ orgId, actorId, tabId: tabB.id });
    expect(deleted?.deletedAt).toBeInstanceOf(Date);
    expect(await store.getTabCells({ orgId, actorId, tabId: tabB.id })).toBeNull();
  });

  it("applies batch cell edits and clears empty cells", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";

    const written = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [
        { row: 0, col: 0, value: "Customer" },
        { row: 0, col: 1, value: "ARR" },
        { row: 1, col: 0, value: "Atlas", format: { bold: true } },
      ],
    });
    expect(written.cells).toHaveLength(3);
    expect(written.cells.find((cell) => cell.row === 1)?.format).toEqual({ bold: true });

    const cleared = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [{ row: 0, col: 0, value: "" }],
    });
    expect(cleared.cells).toHaveLength(2);
    expect(cleared.cells.some((cell) => cell.row === 0 && cell.col === 0)).toBe(false);
  });

  it("preserves format when an edit omits it", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";

    await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [{ row: 0, col: 0, value: "A", format: { bold: true } }],
    });
    const result = await store.updateCells({
      orgId,
      actorId,
      tabId,
      edits: [{ row: 0, col: 0, value: "B" }],
    });
    expect(result.cells[0]?.value).toBe("B");
    expect(result.cells[0]?.format).toEqual({ bold: true });
  });

  it("rejects negative coordinates and overlong cell values", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";

    await expect(
      store.updateCells({ orgId, actorId, tabId, edits: [{ row: -1, col: 0, value: "x" }] }),
    ).rejects.toBeInstanceOf(SheetsValidationError);
    await expect(
      store.updateCells({
        orgId,
        actorId,
        tabId,
        edits: [{ row: 0, col: 0, value: "x".repeat(32_769) }],
      }),
    ).rejects.toBeInstanceOf(SheetsValidationError);
  });

  it("throws when updating cells on an inaccessible tab", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Grid" });
    const tabId = sheet.tabs[0]?.id ?? "";

    await expect(
      store.updateCells({
        orgId,
        actorId: otherActorId,
        tabId,
        edits: [{ row: 0, col: 0, value: "x" }],
      }),
    ).rejects.toBeInstanceOf(SheetsNotFoundError);
  });

  it("stores folderId and app in metadata when folderId is provided", async () => {
    const store = new InMemorySheetsStore();
    const folderId = "44444444-4444-4444-8444-444444444444";
    const sheet = await store.createSheet({
      orgId,
      actorId,
      title: "Folder Sheet",
      folderId,
    });

    expect((sheet.metadata as Record<string, unknown>)["folderId"]).toBe(folderId);
    expect((sheet.metadata as Record<string, unknown>)["app"]).toBe("sheets");
  });
});

// ---------------------------------------------------------------------------
// PostgresSheetsStore — shared-PK objects row integration tests
// ---------------------------------------------------------------------------

function createSql(): postgres.Sql {
  const url =
    process.env.DATABASE_URL ?? "postgres://helix:helix_dev_password@localhost:28432/helix";
  return postgres(url, { max: 2, prepare: false });
}

// Deterministic UUIDs in the f200… range to avoid collision with other tests.
const PG_ORG_ID = "f2000000-0000-4000-8000-000000000001";
const PG_ACTOR_ID = "f2000000-0000-4000-8000-000000000002";
const PG_FOLDER_ID = "f2000000-0000-4000-8000-000000000003";

describe(
  "PostgresSheetsStore — createSheet creates shared-PK objects row",
  {
    skip: !process.env.DATABASE_URL,
  },
  () => {
    let sql: postgres.Sql;
    let store: PostgresSheetsStore;
    const createdSheetIds: string[] = [];

    beforeAll(async () => {
      sql = createSql();
      store = new PostgresSheetsStore(sql);

      // Seed a test actor so FK constraints are satisfied.
      await sql`
        insert into actors (id, org_id, type, display_name, scopes)
        values (${PG_ACTOR_ID}, ${PG_ORG_ID}, 'user', 'Sheets Store Test Actor', '{}')
        on conflict (id) do nothing
      `;
    });

    afterAll(async () => {
      // Clean up created sheets and their objects rows.
      if (createdSheetIds.length > 0) {
        await sql`delete from permissions where resource_id = any(${createdSheetIds}::uuid[])`;
        await sql`delete from objects where id = any(${createdSheetIds}::uuid[])`;
        await sql`delete from sheet_tabs where sheet_id = any(${createdSheetIds}::uuid[])`;
        await sql`delete from sheets where id = any(${createdSheetIds}::uuid[])`;
      }
      await sql.end();
    });

    it("inserts an objects row with kind=file, app=sheets, name, sheetId on create", async () => {
      const sheet = await store.createSheet({
        orgId: PG_ORG_ID,
        actorId: PG_ACTOR_ID,
        title: "Q3 Forecast",
      });
      createdSheetIds.push(sheet.id);

      const rows = (await sql`
        select id, org_id, owner_actor_id, kind, storage_key, mime_type, metadata
        from objects
        where id = ${sheet.id}
      `) as unknown as ReadonlyArray<{
        id: string;
        org_id: string;
        owner_actor_id: string;
        kind: string;
        storage_key: string;
        mime_type: string;
        metadata: Record<string, unknown>;
      }>;

      expect(rows).toHaveLength(1);
      const obj = rows[0];
      expect(obj?.id).toBe(sheet.id);
      expect(obj?.kind).toBe("file");
      expect(obj?.storage_key).toBe(`sheets/${PG_ORG_ID}/${sheet.id}`);
      expect(obj?.mime_type).toBe("application/vnd.helix.spreadsheet");
      expect(obj?.metadata["app"]).toBe("sheets");
      expect(obj?.metadata["name"]).toBe("Q3 Forecast");
      expect(obj?.metadata["sheetId"]).toBe(sheet.id);
      expect(obj?.metadata["folderId"]).toBeNull();
    });

    it("stores folderId in objects metadata when provided", async () => {
      const sheet = await store.createSheet({
        orgId: PG_ORG_ID,
        actorId: PG_ACTOR_ID,
        title: "Budget 2025",
        folderId: PG_FOLDER_ID,
      });
      createdSheetIds.push(sheet.id);

      const rows = (await sql`
        select metadata from objects where id = ${sheet.id}
      `) as unknown as ReadonlyArray<{ metadata: Record<string, unknown> }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata["folderId"]).toBe(PG_FOLDER_ID);
      expect(rows[0]?.metadata["app"]).toBe("sheets");
      expect(rows[0]?.metadata["name"]).toBe("Budget 2025");
    });

    it("grants owner permission on the objects row", async () => {
      const sheet = await store.createSheet({
        orgId: PG_ORG_ID,
        actorId: PG_ACTOR_ID,
        title: "Permissions Test",
      });
      createdSheetIds.push(sheet.id);

      const rows = (await sql`
        select role from permissions
        where resource_type = 'object'
          and resource_id = ${sheet.id}
          and actor_id = ${PG_ACTOR_ID}
      `) as unknown as ReadonlyArray<{ role: string }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.role).toBe("owner");
    });
  },
);
