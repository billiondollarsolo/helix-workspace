/**
 * D12 — Agents/tools may only read clean (active) Drive objects.
 *
 * Asserts every agent-facing content projection path in the Drive tool registry
 * and store denies non-active upload states (scanning, quarantined, scan_failed).
 */
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { DriveNotFoundError } from "./errors.js";
import { PostgresDriveStore, type DriveStorageClient } from "./store.js";
import { createDriveToolDefinitions } from "./tools.js";
import { isDriveFileAvailable, userFacingDriveUploadState } from "./upload-state.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const objectId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-08-01T00:00:00.000Z");

const NON_ACTIVE = [
  "pending_upload",
  "uploaded",
  "scanning",
  "quarantined",
  "scan_failed",
] as const;

function objectRow(uploadState: string) {
  return {
    id: objectId,
    org_id: orgId,
    owner_actor_id: actorId,
    kind: "file",
    storage_key: "drive/agent.bin",
    mime_type: "text/plain",
    byte_size: 4,
    sha256: "c".repeat(64),
    upload_state: uploadState,
    metadata: { name: "agent.bin", status: uploadState },
    deleted_at: null,
    created_at: now,
    updated_at: now,
    version_number: 1,
    mine: true,
    shared_count: 0,
    owner_display_name: "Agent Owner",
    owner_email: "owner@example.test",
    folder_path: [],
  };
}

function createSql(uploadState: string): postgres.Sql {
  const row = objectRow(uploadState);
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("objects.owner_actor_id") || text.includes("drive_folders.owner_actor_id")) {
      return { text, values };
    }
    if (text.includes("from drive_share_links")) {
      return Promise.resolve([{ org_id: orgId, object_id: objectId, role: "reader" }]);
    }
    if (text.includes("with recursive target as")) {
      return Promise.resolve([row]);
    }
    if (text.includes("from drive_folders")) {
      return Promise.resolve([]);
    }
    // requireObjectAccess: only returns row when SQL allows active (or trashed).
    if (text.includes("from objects") && text.includes("kind in")) {
      if (uploadState === "active" || (text.includes("trashed") && uploadState === "trashed")) {
        return Promise.resolve([row]);
      }
      // Emulate the SQL filter: non-active states never match the active clause.
      if (text.includes("upload_state = 'active'") && uploadState !== "active") {
        return Promise.resolve([]);
      }
      return Promise.resolve([row]);
    }
    if (text.includes("from objects")) {
      return Promise.resolve(uploadState === "active" ? [row] : []);
    }
    if (text.includes("from drive_versions")) {
      return Promise.resolve([{ version_number: 1 }]);
    }
    return Promise.resolve([]);
  };
  const sql = tag as unknown as postgres.Sql;
  Object.assign(sql, {
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
      callback(sql as unknown as postgres.TransactionSql),
    json: (value: unknown) => value,
  });
  return sql;
}

describe("D12 agent reads only clean objects", () => {
  it("marks only active as available for agent tool surfaces", () => {
    for (const state of NON_ACTIVE) {
      expect(isDriveFileAvailable(state)).toBe(false);
      expect(userFacingDriveUploadState(state).available).toBe(false);
    }
    expect(isDriveFileAvailable("active")).toBe(true);
  });

  it.each([...NON_ACTIVE])(
    "denies store.readFile for upload_state=%s (agent content path)",
    async (state) => {
      const get = vi.fn<DriveStorageClient["get"]>();
      const store = new PostgresDriveStore(createSql(state), {
        async put() {},
        get,
        async delete() {},
      });
      await expect(store.readFile({ orgId, actorId, objectId })).rejects.toBeInstanceOf(
        DriveNotFoundError,
      );
      expect(get).not.toHaveBeenCalled();
    },
  );

  it("omits non-active objects from search and indexing (agent discovery)", async () => {
    const store = new PostgresDriveStore(createSql("quarantined"));
    await expect(store.search({ orgId, actorId, query: "agent" })).resolves.toEqual([]);
    await expect(store.getDriveSearchRecord(objectId)).resolves.toBeNull();
  });

  it("registers no unrestricted content-read tool — list/search are metadata-only", () => {
    const store = {
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
      getUploadStatus: vi.fn(async () => null),
      readFile: vi.fn(async () => {
        throw new Error("agents must not call raw readFile via tools");
      }),
    };
    const tools = createDriveToolDefinitions({ store: store as never });
    const ids = tools.map((tool) => tool.id);
    // Agent-facing registry: metadata tools exist; no drive.content / drive.read blob tool.
    expect(ids).toContain("drive.list");
    expect(ids).toContain("drive.search");
    expect(ids).toContain("drive.upload.status");
    expect(ids.some((id) => /content|download|bytes|blob|readFile/i.test(id))).toBe(false);
    // Write/share tools require confirmation where mutating.
    const share = tools.find((tool) => tool.id === "drive.share");
    expect(share?.confirmationRequired).toBe(true);
  });

  it("drive.list handler surfaces owner processing as unavailable metadata only", async () => {
    const store = {
      list: vi.fn(async () => [
        {
          id: objectId,
          type: "file" as const,
          name: "pending.bin",
          folderId: null,
          ownerActorId: actorId,
          app: null,
          mimeType: "application/octet-stream",
          byteSize: 3,
          sha256: "a".repeat(64),
          uploadState: "scanning" as const,
          uploadStatusLabel: "Scanning for malware",
          available: false,
          metadata: {},
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ]),
    };
    const tools = createDriveToolDefinitions({ store: store as never });
    const list = tools.find((tool) => tool.id === "drive.list");
    expect(list).toBeDefined();
    const result = (await list!.handler({ folderId: null, includeTrashed: false, limit: 100 }, {
      actor: { id: actorId, orgId, type: "user", scopes: ["drive.read"] },
    } as never)) as { entries: readonly { available?: boolean; uploadState?: string }[] };
    expect(result.entries[0]?.available).toBe(false);
    expect(result.entries[0]?.uploadState).toBe("scanning");
  });
});
