import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresDriveStore } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const objectId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-09-02T00:00:00.000Z");
const mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function version(versionNumber: number, metadata: Record<string, unknown>) {
  return {
    id: `00000000-0000-4000-8000-${String(versionNumber).padStart(12, "0")}`,
    org_id: orgId,
    object_id: objectId,
    version_number: versionNumber,
    storage_key: `drive/${orgId}/${objectId}/v1/report.docx`,
    mime_type: mimeType,
    byte_size: 10,
    sha256: "a".repeat(64),
    metadata,
    created_by_actor_id: actorId,
    created_at: now,
  };
}

function versioningSql() {
  const original = {
    ...version(1, {
      preview: {
        kind: "pdf",
        status: "available",
        storageKey: "drive-previews/stale-version.pdf",
      },
    }),
    idempotency_key: null as string | null,
  };
  const versions = [original];
  let object = {
    id: objectId,
    org_id: orgId,
    owner_actor_id: actorId,
    kind: "file",
    storage_key: original.storage_key,
    mime_type: mimeType,
    byte_size: 10,
    sha256: "a".repeat(64),
    metadata: { name: "report.docx", status: "ready", preview: original.metadata.preview },
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
  let tail = Promise.resolve();

  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("objects.owner_actor_id")) return { text, values };
    if (text.includes("select set_config")) return Promise.resolve([]);
    if (text.includes("with candidates as") && text.includes("drive_preview_jobs")) {
      return Promise.resolve([]);
    }
    if (text.includes("select *") && text.includes("from objects")) {
      return Promise.resolve([object]);
    }
    if (text.includes("select id from objects") && text.includes("for update")) {
      return Promise.resolve([{ id: objectId }]);
    }
    if (text.includes("idempotency_key =")) {
      const key = values.find(
        (value): value is string => typeof value === "string" && value.startsWith("request-"),
      );
      return Promise.resolve(versions.filter((row) => row.idempotency_key === key));
    }
    if (text.includes("select *") && text.includes("from drive_versions")) {
      return Promise.resolve([versions[0]]);
    }
    if (text.includes("coalesce(max(version_number), 0)::int as max_version")) {
      return Promise.resolve([
        { max_version: Math.max(...versions.map((row) => row.version_number)) },
      ]);
    }
    if (text.includes("insert into drive_versions")) {
      const versionNumber = values.find((value): value is number => typeof value === "number");
      const metadata = values.find(
        (value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null && "revertedFromVersion" in value,
      );
      const idempotencyKey = values.find(
        (value): value is string => typeof value === "string" && value.startsWith("request-"),
      );
      if (versionNumber === undefined || metadata === undefined) throw new Error("invalid insert");
      const row = {
        ...version(versionNumber, metadata),
        idempotency_key: idempotencyKey ?? null,
      };
      versions.push(row);
      return Promise.resolve([row]);
    }
    if (text.includes("update objects") && text.includes("metadata - 'preview'")) {
      const metadata = values.find(
        (value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null && "latestVersionId" in value,
      );
      object = { ...object, metadata: { ...object.metadata, ...(metadata ?? {}) } };
      return Promise.resolve([{ id: objectId }]);
    }
    if (text.includes("from activity") || text.includes("insert into activity")) {
      return Promise.resolve([{ this_hash: "0".repeat(64) }]);
    }
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    begin: <T>(callback: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> => {
      const result = tail.then(() => callback(sql as unknown as postgres.TransactionSql));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  }) as unknown as postgres.Sql;
  return { sql, versions, currentObject: () => object };
}

describe("Drive version allocation", () => {
  it("serializes 100 writes, replays idempotency, and never carries a stale preview", async () => {
    const state = versioningSql();
    const store = new PostgresDriveStore(state.sql);

    const writes = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        store.revertToVersion({
          orgId,
          actorId,
          objectId,
          versionNumber: 1,
          idempotencyKey: `request-${String(index)}`,
        }),
      ),
    );

    expect(writes.map((row) => row.versionNumber)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 2),
    );
    expect(new Set(writes.map((row) => row.versionNumber)).size).toBe(100);
    expect(
      writes.every((row) => {
        const preview = row.metadata.preview;
        return (
          typeof preview === "object" &&
          preview !== null &&
          "status" in preview &&
          preview.status === "pending"
        );
      }),
    ).toBe(true);
    expect(JSON.stringify(writes)).not.toContain("stale-version.pdf");
    await expect(
      store.revertToVersion({
        orgId,
        actorId,
        objectId,
        versionNumber: 1,
        idempotencyKey: "request-0",
      }),
    ).resolves.toEqual(writes[0]);
    expect(state.versions).toHaveLength(101);
    expect(state.currentObject().metadata.preview).toMatchObject({ status: "pending" });
  });
});
