import { describe, expect, it } from "vitest";
import {
  TenantProvisioningWorker,
  type TenantProvisioningStep,
  type TenantProvisioningWorkerStore,
} from "./provisioning-worker.js";
import type { TenantProvisioningRecord } from "./provisioning.js";

const baseRecord: TenantProvisioningRecord = {
  orgId: "11111111-1111-4111-8111-111111111111",
  status: "running",
  requestedOwnerEmail: "owner@example.com",
  currentStep: "claimed",
  completedSteps: [],
  attemptCount: 1,
  lastError: null,
  metadata: {},
  createdAt: new Date("2026-05-24T00:00:00.000Z"),
  updatedAt: new Date("2026-05-24T00:00:00.000Z"),
  completedAt: null,
};

describe("TenantProvisioningWorker", () => {
  it("runs configured steps and waits for email verification", async () => {
    const store = new InMemoryTenantProvisioningWorkerStore([baseRecord]);
    const executed: string[] = [];
    const steps: readonly TenantProvisioningStep[] = [
      {
        name: "object_store_prefix",
        run: async () => {
          executed.push("object_store_prefix");
        },
      },
      {
        name: "vault_path",
        run: async () => {
          executed.push("vault_path");
        },
      },
    ];
    const worker = new TenantProvisioningWorker({ store, steps, batchSize: 5 });

    const result = await worker.runOnce();

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(executed).toEqual(["object_store_prefix", "vault_path"]);
    expect(store.waiting).toEqual([
      {
        orgId: baseRecord.orgId,
        currentStep: "waiting_for_verification",
        completedSteps: ["object_store_prefix", "vault_path"],
      },
    ]);
    expect(store.failed).toEqual([]);
  });

  it("skips already completed steps when retrying a failed provisioning record", async () => {
    const store = new InMemoryTenantProvisioningWorkerStore([
      { ...baseRecord, completedSteps: ["object_store_prefix"] },
    ]);
    const executed: string[] = [];
    const worker = new TenantProvisioningWorker({
      store,
      steps: [
        {
          name: "object_store_prefix",
          run: async () => {
            executed.push("object_store_prefix");
          },
        },
        {
          name: "initial_owner_actor_created",
          run: async () => {
            executed.push("initial_owner_actor_created");
          },
        },
      ],
    });

    const result = await worker.runOnce();

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(executed).toEqual(["initial_owner_actor_created"]);
    expect(store.waiting).toEqual([
      {
        orgId: baseRecord.orgId,
        currentStep: "waiting_for_verification",
        completedSteps: ["object_store_prefix", "initial_owner_actor_created"],
      },
    ]);
  });

  it("marks the provisioning record failed at the current step", async () => {
    const store = new InMemoryTenantProvisioningWorkerStore([baseRecord]);
    const worker = new TenantProvisioningWorker({
      store,
      steps: [
        { name: "object_store_prefix", run: async () => undefined },
        {
          name: "vault_path",
          run: async () => {
            throw new Error("vault unavailable");
          },
        },
      ],
    });

    const result = await worker.runOnce();

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
    expect(store.failed).toEqual([
      {
        orgId: baseRecord.orgId,
        currentStep: "vault_path",
        completedSteps: ["object_store_prefix"],
        error: "vault unavailable",
      },
    ]);
    expect(store.waiting).toEqual([]);
  });

  it("marks owner actor creation failures at the owner actor step", async () => {
    const store = new InMemoryTenantProvisioningWorkerStore([baseRecord]);
    const worker = new TenantProvisioningWorker({
      store,
      steps: [
        {
          name: "initial_owner_actor_created",
          run: async () => {
            throw new Error("actor insert failed");
          },
        },
      ],
    });

    const result = await worker.runOnce();

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
    expect(store.failed).toEqual([
      {
        orgId: baseRecord.orgId,
        currentStep: "initial_owner_actor_created",
        completedSteps: [],
        error: "actor insert failed",
      },
    ]);
    expect(store.waiting).toEqual([]);
  });
});

class InMemoryTenantProvisioningWorkerStore implements TenantProvisioningWorkerStore {
  readonly waiting: {
    readonly orgId: string;
    readonly currentStep: string;
    readonly completedSteps: readonly string[];
  }[] = [];

  readonly failed: {
    readonly orgId: string;
    readonly currentStep: string;
    readonly completedSteps: readonly string[];
    readonly error: string;
  }[] = [];

  constructor(private readonly records: readonly TenantProvisioningRecord[]) {}

  async claimPending(): Promise<readonly TenantProvisioningRecord[]> {
    return this.records;
  }

  async markWaitingForVerification(input: {
    readonly orgId: string;
    readonly currentStep: string;
    readonly completedSteps: readonly string[];
  }): Promise<TenantProvisioningRecord> {
    this.waiting.push(input);
    return { ...baseRecord, status: "waiting_for_verification", ...input };
  }

  async markFailed(input: {
    readonly orgId: string;
    readonly currentStep: string;
    readonly completedSteps: readonly string[];
    readonly error: string;
  }): Promise<TenantProvisioningRecord> {
    this.failed.push(input);
    return { ...baseRecord, status: "failed", lastError: input.error, ...input };
  }
}
