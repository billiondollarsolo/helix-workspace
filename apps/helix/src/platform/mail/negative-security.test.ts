import { describe, expect, it } from "vitest";
import { InMemoryReceivingDomainStore } from "./receiving-domains-store.js";

const orgId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000011";

describe("Mail V2 negative-security boundary", () => {
  it("rejects unknown receiving domains and unknown mailboxes without a catch-all", async () => {
    const store = new InMemoryReceivingDomainStore({
      actors: [{ id: actorId, orgId, email: "owner@example.test" }],
    });
    const domain = await store.createDomain({
      orgId,
      domain: "example.test",
    });
    await store.markVerified(orgId, domain.id);
    await store.enableDomain(orgId, domain.id);

    await expect(store.resolveMailbox("owner@unknown.test")).resolves.toBeNull();
    await expect(store.resolveMailbox("unknown@example.test")).resolves.toBeNull();
  });
});
