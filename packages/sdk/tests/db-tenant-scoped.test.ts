import { describe, expect, it } from "vitest";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { tenantScoped, type TenantScopedDrizzleDatabase } from "../src/db-tenant-scoped.js";

const orgId = "11111111-1111-4111-8111-111111111111";

const documents = pgTable("docs_documents", {
  id: uuid("id").primaryKey(),
  orgId: uuid("org_id").notNull(),
  title: text("title").notNull(),
});

interface RecordedCall {
  readonly operation: string;
  readonly value?: unknown;
  readonly predicate?: unknown;
}

function createRecordingDb(): {
  readonly db: TenantScopedDrizzleDatabase;
  readonly calls: readonly RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const where = (operation: string) => ({
    where(predicate: unknown) {
      calls.push({ operation, predicate });
      return { operation, predicate };
    },
  });

  return {
    calls,
    db: {
      select(fields?: Record<string, unknown>) {
        calls.push({ operation: "select", value: fields });
        return {
          from(table) {
            calls.push({ operation: "from", value: table });
            return where("where");
          },
        };
      },
      insert(table) {
        calls.push({ operation: "insert", value: table });
        return {
          values(value) {
            calls.push({ operation: "values", value });
            return value;
          },
        };
      },
      update(table) {
        calls.push({ operation: "update", value: table });
        return {
          set(value) {
            calls.push({ operation: "set", value });
            return where("where");
          },
        };
      },
      delete(table) {
        calls.push({ operation: "delete", value: table });
        return where("where");
      },
    },
  };
}

describe("tenantScoped", () => {
  it("injects the org predicate into Drizzle read and write builders", () => {
    const recording = createRecordingDb();
    const scoped = tenantScoped(recording.db, documents, orgId);

    scoped.select({ id: documents.id });
    scoped.update({ title: "Updated" });
    scoped.delete();

    expect(recording.calls.map((call) => call.operation)).toEqual([
      "select",
      "from",
      "where",
      "update",
      "set",
      "where",
      "delete",
      "where",
    ]);
    expect(recording.calls.filter((call) => call.operation === "where")).toHaveLength(3);
    expect(
      recording.calls.every((call) => call.operation !== "where" || call.predicate !== undefined),
    ).toBe(true);
  });

  it("stamps inserts with the scoped org id", () => {
    const recording = createRecordingDb();
    const scoped = tenantScoped(recording.db, documents, orgId);

    scoped.insert({ id: "doc-1", title: "Draft" });
    scoped.insert([
      { id: "doc-2", title: "Second" },
      { id: "doc-3", orgId: "wrong-org", title: "Third" },
    ]);

    expect(
      recording.calls.filter((call) => call.operation === "values").map((call) => call.value),
    ).toEqual([
      { id: "doc-1", title: "Draft", orgId },
      [
        { id: "doc-2", title: "Second", orgId },
        { id: "doc-3", orgId, title: "Third" },
      ],
    ]);
  });

  it("keeps raw Drizzle escapes explicit about db, table, and org", () => {
    const recording = createRecordingDb();
    const scoped = tenantScoped(recording.db, documents, orgId);

    expect(scoped.raw((db, table, scopedOrgId) => ({ db, table, scopedOrgId }))).toEqual({
      db: recording.db,
      table: documents,
      scopedOrgId: orgId,
    });
  });
});
