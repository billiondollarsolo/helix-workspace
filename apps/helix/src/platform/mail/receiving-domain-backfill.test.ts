import { describe, expect, it } from "vitest";
import { backfillSingleTenantReceivingDomain } from "./receiving-domain-backfill.js";
import { InMemoryReceivingDomainStore } from "./receiving-domains-store.js";

const orgId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000011";

describe("backfillSingleTenantReceivingDomain", () => {
  it("requires exact single-tenant mode and ownership attestation before writing", async () => {
    const store = new InMemoryReceivingDomainStore();
    await expect(
      backfillSingleTenantReceivingDomain(store, {
        deploymentMode: "saas",
        orgId,
        domain: "example.com",
        createdBy: actorId,
        ownershipAttested: true,
      }),
    ).rejects.toThrow("forbidden");
    await expect(
      backfillSingleTenantReceivingDomain(store, {
        deploymentMode: "single-tenant",
        orgId,
        domain: "example.com",
        createdBy: actorId,
        ownershipAttested: false,
      }),
    ).rejects.toThrow("attestation");
    await expect(store.listDomains(orgId)).resolves.toEqual([]);
  });

  it("creates one active record and is idempotent", async () => {
    const store = new InMemoryReceivingDomainStore();
    const input = {
      deploymentMode: "single-tenant",
      orgId,
      domain: "EXAMPLE.com",
      createdBy: actorId,
      ownershipAttested: true,
    };
    const first = await backfillSingleTenantReceivingDomain(store, input);
    const second = await backfillSingleTenantReceivingDomain(store, input);
    expect(first).toMatchObject({ domain: "example.com", status: "active" });
    expect(second.id).toBe(first.id);
    await expect(store.listDomains(orgId)).resolves.toHaveLength(1);
  });
});
