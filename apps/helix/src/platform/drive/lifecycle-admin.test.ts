/**
 * D11 — Quota + lifecycle operator store methods (admin path).
 */
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { DriveConflictError } from "./errors.js";
import { PostgresDriveStore } from "./store.js";
import { createDriveToolDefinitions } from "./tools.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-08-01T00:00:00.000Z");

function createAdminSql(options: {
  readonly policy?: {
    trash_retention_days: number;
    orphan_grace_hours: number;
  } | null;
  readonly usedBytes?: number;
  readonly limitJson?: unknown;
}): postgres.Sql {
  const calls: string[] = [];
  const tag = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join("?");
    calls.push(text);

    if (text.includes("from drive_lifecycle_policies") && text.includes("select")) {
      if (options.policy === null || options.policy === undefined) {
        return Promise.resolve([]);
      }
      return Promise.resolve([
        {
          org_id: orgId,
          trash_retention_days: options.policy.trash_retention_days,
          orphan_grace_hours: options.policy.orphan_grace_hours,
          updated_by_actor_id: actorId,
          updated_at: now,
        },
      ]);
    }

    if (text.includes("insert into drive_lifecycle_policies")) {
      return Promise.resolve([
        {
          org_id: orgId,
          trash_retention_days: 45,
          orphan_grace_hours: 48,
          updated_by_actor_id: actorId,
          updated_at: now,
        },
      ]);
    }

    if (text.includes("storage_bytes_limit") && text.includes("storage_used_bytes")) {
      return Promise.resolve([
        {
          storage_bytes_limit: options.limitJson ?? 5_000_000_000,
          storage_used_bytes: options.usedBytes ?? 1_000_000,
        },
      ]);
    }

    if (text.includes("from activity") || text.includes("insert into activity")) {
      return Promise.resolve([]);
    }

    return Promise.resolve([]);
  };
  const sql = tag as unknown as postgres.Sql & { calls: string[] };
  Object.assign(sql, {
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
      callback(sql as unknown as postgres.TransactionSql),
    json: (value: unknown) => value,
    calls,
  });
  return sql;
}

describe("D11 Drive lifecycle + quota operator store", () => {
  it("returns platform defaults when no lifecycle policy row exists", async () => {
    const store = new PostgresDriveStore(createAdminSql({ policy: null }));
    await expect(store.getLifecyclePolicy({ orgId })).resolves.toEqual({
      orgId,
      trashRetentionDays: 30,
      orphanGraceHours: 24,
      updatedByActorId: null,
      updatedAt: null,
      configured: false,
    });
  });

  it("reads a configured lifecycle policy", async () => {
    const store = new PostgresDriveStore(
      createAdminSql({ policy: { trash_retention_days: 60, orphan_grace_hours: 12 } }),
    );
    await expect(store.getLifecyclePolicy({ orgId })).resolves.toMatchObject({
      trashRetentionDays: 60,
      orphanGraceHours: 12,
      configured: true,
    });
  });

  it("upserts lifecycle policy and rejects out-of-range values", async () => {
    const store = new PostgresDriveStore(createAdminSql({ policy: null }));
    await expect(
      store.setLifecyclePolicy({
        orgId,
        actorId,
        trashRetentionDays: 45,
        orphanGraceHours: 48,
      }),
    ).resolves.toMatchObject({
      trashRetentionDays: 45,
      orphanGraceHours: 48,
      configured: true,
    });
    await expect(
      store.setLifecyclePolicy({
        orgId,
        actorId,
        trashRetentionDays: 0,
        orphanGraceHours: 24,
      }),
    ).rejects.toBeInstanceOf(DriveConflictError);
  });

  it("reports storage quota usage with percent used", async () => {
    const store = new PostgresDriveStore(
      createAdminSql({ usedBytes: 2_500_000_000, limitJson: 5_000_000_000 }),
    );
    await expect(store.getStorageQuotaUsage({ orgId })).resolves.toMatchObject({
      orgId,
      usedBytes: 2_500_000_000,
      limitBytes: 5_000_000_000,
      unlimited: false,
      percentUsed: 50,
    });
  });

  it("registers admin.drive tools for lifecycle and quota", () => {
    const store = {
      getStorageQuotaUsage: async () => ({
        orgId,
        usedBytes: 0,
        limitBytes: null,
        unlimited: true,
        percentUsed: null,
      }),
      getLifecyclePolicy: async () => ({
        orgId,
        trashRetentionDays: 30,
        orphanGraceHours: 24,
        updatedByActorId: null,
        updatedAt: null,
        configured: false,
      }),
      setLifecyclePolicy: async () => ({
        orgId,
        trashRetentionDays: 30,
        orphanGraceHours: 24,
        updatedByActorId: actorId,
        updatedAt: now,
        configured: true,
      }),
    };
    const tools = createDriveToolDefinitions({ store: store as never });
    const byId = Object.fromEntries(tools.map((tool) => [tool.id, tool]));
    expect(byId["drive.quota.usage"]?.permission).toBe("admin.drive");
    expect(byId["drive.lifecycle.get"]?.permission).toBe("admin.drive");
    expect(byId["drive.lifecycle.set"]?.permission).toBe("admin.drive");
    expect(byId["drive.lifecycle.set"]?.confirmationRequired).toBe(true);
  });
});
