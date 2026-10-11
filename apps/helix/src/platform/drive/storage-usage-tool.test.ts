import { describe, expect, it, vi } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { createDriveStorageUsageTool } from "./storage-usage-tool.js";

const orgId = "00000000-0000-4000-8000-000000000100";
const actorId = "00000000-0000-4000-8000-000000000201";

describe("drive.storage.usage", () => {
  it("lets any Drive reader see their own usage and the organization limit", async () => {
    const getMemberStorageUsage = vi.fn(() =>
      Promise.resolve({ usedBytes: 2048, limitBytes: 10_000, organizationUsedBytes: 4096 }),
    );
    const registry = createToolRegistry();
    registry.register(createDriveStorageUsageTool({ getMemberStorageUsage }));
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["drive.read"] };

    await expect(registry.invoke("drive.storage.usage", {}, { actor })).resolves.toMatchObject({
      ok: true,
      output: { usedBytes: 2048, limitBytes: 10_000, organizationUsedBytes: 4096 },
    });
    expect(getMemberStorageUsage).toHaveBeenCalledWith({ orgId, actorId });
  });

  it("reports unlimited storage without organization usage", async () => {
    const registry = createToolRegistry();
    registry.register(
      createDriveStorageUsageTool({
        getMemberStorageUsage: () =>
          Promise.resolve({ usedBytes: 0, limitBytes: null, organizationUsedBytes: null }),
      }),
    );
    const actor = { id: actorId, orgId, type: "user" as const, scopes: ["drive.read"] };
    await expect(registry.invoke("drive.storage.usage", {}, { actor })).resolves.toMatchObject({
      ok: true,
      output: { usedBytes: 0, limitBytes: null, organizationUsedBytes: null },
    });
  });
});
