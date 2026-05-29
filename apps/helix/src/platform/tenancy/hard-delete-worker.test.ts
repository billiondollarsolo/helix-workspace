import { describe, expect, it } from "vitest";
import { TenantHardDeleteWorker, type TenantHardDeleteWorkerStore } from "./hard-delete-worker.js";
import type { OrgRecord } from "./orgs.js";

describe("TenantHardDeleteWorker", () => {
  it("marks due soft-deleted tenants as hard-deleted after running purge hooks", async () => {
    const org = orgRecord({
      id: "org-1",
      slug: "acme",
      status: "soft_deleted",
      softDeletedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const store = new InMemoryHardDeleteStore([org]);
    const purged: string[] = [];
    const hardDeleted: unknown[] = [];
    const worker = new TenantHardDeleteWorker({
      store,
      now: () => new Date("2026-05-24T00:00:00.000Z"),
      steps: [
        {
          name: "postgres-tombstone-checkpoint",
          async run(record) {
            purged.push(record.id);
          },
        },
      ],
      onHardDeleted(input) {
        hardDeleted.push(input);
      },
    });

    await expect(worker.runOnce()).resolves.toEqual({ checked: 1, purged: 1, failed: 0 });

    expect(store.listCalls).toEqual([
      {
        before: new Date("2026-04-24T00:00:00.000Z"),
        limit: 10,
      },
    ]);
    expect(purged).toEqual(["org-1"]);
    expect(store.marked).toEqual(["org-1"]);
    expect(hardDeleted).toHaveLength(1);
    const hardDeletedEvent = hardDeleted[0] as {
      readonly previous: OrgRecord;
      readonly updated: OrgRecord;
    };
    expect(hardDeletedEvent.previous).toBe(org);
    expect(hardDeletedEvent.updated).toMatchObject({ id: "org-1", status: "hard_deleted" });
  });

  it("continues after a per-tenant purge failure", async () => {
    const failed: unknown[] = [];
    const store = new InMemoryHardDeleteStore([
      orgRecord({
        id: "org-1",
        slug: "acme",
        status: "soft_deleted",
        softDeletedAt: new Date("2026-04-01T00:00:00.000Z"),
      }),
      orgRecord({
        id: "org-2",
        slug: "beta",
        status: "soft_deleted",
        softDeletedAt: new Date("2026-04-01T00:00:00.000Z"),
      }),
    ]);
    const worker = new TenantHardDeleteWorker({
      store,
      now: () => new Date("2026-05-24T00:00:00.000Z"),
      onError(error) {
        failed.push(error);
      },
      steps: [
        {
          name: "fail-first",
          async run(org) {
            if (org.id === "org-1") {
              throw new Error("object purge failed");
            }
          },
        },
      ],
    });

    await expect(worker.runOnce()).resolves.toEqual({ checked: 2, purged: 1, failed: 1 });
    expect(store.marked).toEqual(["org-2"]);
    expect(failed).toHaveLength(1);
  });

  it("counts a lost tombstone transition as failed", async () => {
    const store = new InMemoryHardDeleteStore([
      orgRecord({
        id: "org-1",
        slug: "acme",
        status: "soft_deleted",
        softDeletedAt: new Date("2026-04-01T00:00:00.000Z"),
      }),
    ]);
    store.failMarks.add("org-1");
    const worker = new TenantHardDeleteWorker({
      store,
      now: () => new Date("2026-05-24T00:00:00.000Z"),
      steps: [],
    });

    await expect(worker.runOnce()).resolves.toEqual({ checked: 1, purged: 0, failed: 1 });
  });
});

class InMemoryHardDeleteStore implements TenantHardDeleteWorkerStore {
  readonly listCalls: { readonly before: Date; readonly limit?: number | undefined }[] = [];
  readonly marked: string[] = [];
  readonly failMarks = new Set<string>();

  constructor(private readonly orgs: readonly OrgRecord[]) {}

  async listSoftDeletedTenantsDueForHardDelete(input: {
    readonly before: Date;
    readonly limit?: number | undefined;
  }): Promise<readonly OrgRecord[]> {
    this.listCalls.push(input);
    return this.orgs.filter(
      (org) =>
        org.status === "soft_deleted" &&
        org.softDeletedAt !== null &&
        org.softDeletedAt.getTime() <= input.before.getTime(),
    );
  }

  async markTenantHardDeleted(input: { readonly orgId: string }): Promise<OrgRecord | null> {
    if (this.failMarks.has(input.orgId)) {
      return null;
    }
    const org = this.orgs.find((record) => record.id === input.orgId);
    if (org === undefined) {
      return null;
    }
    this.marked.push(input.orgId);
    return orgRecord({
      ...org,
      status: "hard_deleted",
      hardDeletedAt: new Date("2026-05-24T00:00:00.000Z"),
    });
  }
}

function orgRecord(overrides: Partial<OrgRecord> = {}): OrgRecord {
  return {
    id: "org-1",
    slug: "acme",
    displayName: "Acme",
    status: "active",
    tier: "personal",
    planId: "personal",
    region: "default",
    byoConfig: {},
    featureFlags: {},
    quotas: {},
    branding: {},
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
    ...overrides,
  };
}
