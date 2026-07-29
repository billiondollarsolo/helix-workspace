import { describe, expect, it, vi } from "vitest";
import { ChatRetentionWorker } from "./retention-worker.js";

describe("ChatRetentionWorker", () => {
  it("runs bounded batches for each organization and reports saturation", async () => {
    const applyRetention = vi
      .fn()
      .mockResolvedValueOnce({ tombstonedMessageIds: ["a", "b"] })
      .mockResolvedValueOnce({ tombstonedMessageIds: ["c"] })
      .mockResolvedValueOnce({ tombstonedMessageIds: ["d", "e"] })
      .mockResolvedValueOnce({ tombstonedMessageIds: ["f", "g"] });
    const worker = new ChatRetentionWorker({
      store: { applyRetention },
      organizations: { listOrganizationIds: vi.fn().mockResolvedValue(["org-a", "org-b"]) },
      batchSize: 2,
      maxBatchesPerOrganization: 2,
      now: () => new Date("2026-07-28T12:00:00.000Z"),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      organizationsChecked: 2,
      tombstonedMessages: 7,
      saturatedOrganizations: ["org-b"],
    });
    expect(applyRetention).toHaveBeenCalledTimes(4);
    expect(applyRetention).toHaveBeenCalledWith({
      orgId: "org-a",
      actorId: "system",
      now: new Date("2026-07-28T12:00:00.000Z"),
      limit: 2,
    });
  });

  it("rejects unbounded or invalid worker limits", () => {
    expect(
      () =>
        new ChatRetentionWorker({
          store: { applyRetention: vi.fn() },
          organizations: { listOrganizationIds: vi.fn() },
          batchSize: 0,
        }),
    ).toThrow("batchSize must be a positive integer");
  });
});
