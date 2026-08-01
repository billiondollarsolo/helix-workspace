import { describe, expect, it } from "vitest";
import { createDomainOwnershipChallenge } from "../admin/domain-identity.js";
import {
  InMemoryReceivingDomainStore,
  ReceivingDomainCatchAllError,
  ReceivingDomainConflictError,
  ReceivingDomainTransitionError,
} from "./receiving-domains-store.js";

const orgOne = "10000000-0000-4000-8000-000000000001";
const orgTwo = "20000000-0000-4000-8000-000000000002";
const actorOne = "10000000-0000-4000-8000-000000000011";
const actorTwo = "20000000-0000-4000-8000-000000000022";

/** The ownership challenge now belongs to the admin_domains parent; kept here
 *  for the few assertions that still need a well-formed digest. */
function challenge(domain = "example.com") {
  return createDomainOwnershipChallenge(domain);
}

describe("receiving-domain lifecycle", () => {
  it("requires ownership verification before activation and ignores inactive domains", async () => {
    const store = new InMemoryReceivingDomainStore();
    const created = await store.createDomain({
      orgId: orgOne,
      domain: "EXAMPLE.com",
    });

    expect(created.status).toBe("pending");
    expect(created.domain).toBe("example.com");
    await expect(store.resolveReceivingDomain("example.com")).resolves.toBeNull();
    await expect(store.enableDomain(orgOne, created.id)).rejects.toBeInstanceOf(
      ReceivingDomainTransitionError,
    );

    const verified = await store.markVerified(orgOne, created.id);
    expect(verified?.status).toBe("verified");
    await expect(store.resolveReceivingDomain("example.com")).resolves.toBeNull();

    const active = await store.enableDomain(orgOne, created.id);
    expect(active?.status).toBe("active");
    await expect(store.resolveReceivingDomain("EXAMPLE.COM")).resolves.toMatchObject({
      id: created.id,
      orgId: orgOne,
    });

    expect((await store.disableDomain(orgOne, created.id))?.status).toBe("disabled");
    await expect(store.resolveReceivingDomain("example.com")).resolves.toBeNull();
  });

  it("allows only one organization to activate a domain under a race", async () => {
    const store = new InMemoryReceivingDomainStore();
    const first = await store.createDomain({
      orgId: orgOne,
      domain: "shared.example",
    });
    const second = await store.createDomain({
      orgId: orgTwo,
      domain: "shared.example",
    });
    await Promise.all([
      store.markVerified(orgOne, first.id),
      store.markVerified(orgTwo, second.id),
    ]);

    const results = await Promise.allSettled([
      store.enableDomain(orgOne, first.id),
      store.enableDomain(orgTwo, second.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(ReceivingDomainConflictError),
    });
    await expect(store.resolveReceivingDomain("shared.example")).resolves.toMatchObject({
      status: "active",
    });
  });

  it("rejects duplicate records within one organization", async () => {
    const store = new InMemoryReceivingDomainStore();
    await store.createDomain({
      orgId: orgOne,
      domain: "bücher.example",
    });
    await expect(
      store.createDomain({
        orgId: orgOne,
        domain: "xn--bcher-kva.example",
      }),
    ).rejects.toBeInstanceOf(ReceivingDomainConflictError);
  });

  it("rejects a catch-all actor outside the organization or disabled", async () => {
    const store = new InMemoryReceivingDomainStore({
      actors: [
        { id: actorOne, orgId: orgOne },
        { id: actorTwo, orgId: orgTwo },
        { id: "10000000-0000-4000-8000-000000000099", orgId: orgOne, disabled: true },
      ],
    });
    await expect(
      store.createDomain({
        orgId: orgOne,
        domain: "example.com",
        catchAllActorId: actorTwo,
      }),
    ).rejects.toBeInstanceOf(ReceivingDomainCatchAllError);
    await expect(
      store.createDomain({
        orgId: orgOne,
        domain: "example.com",
        catchAllActorId: "10000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toBeInstanceOf(ReceivingDomainCatchAllError);
  });
});

describe("mailbox resolution", () => {
  it("resolves active primary and alias addresses, then an optional catch-all", async () => {
    const store = new InMemoryReceivingDomainStore({
      actors: [
        { id: actorOne, orgId: orgOne, email: "Owner@Example.com" },
        { id: actorTwo, orgId: orgTwo, email: "other@other.example" },
      ],
      aliases: [
        {
          orgId: orgOne,
          actorId: actorOne,
          address: "Support@Example.com",
        },
      ],
    });
    const created = await store.createDomain({
      orgId: orgOne,
      domain: "example.com",
      catchAllActorId: actorOne,
    });
    await store.markVerified(orgOne, created.id);
    await store.enableDomain(orgOne, created.id);

    await expect(store.resolveMailbox("OWNER@example.com")).resolves.toMatchObject({
      orgId: orgOne,
      actorId: actorOne,
      normalizedAddress: "owner@example.com",
      match: "primary",
    });
    await expect(store.resolveMailbox("support@example.com")).resolves.toMatchObject({
      actorId: actorOne,
      match: "alias",
    });
    await expect(store.resolveMailbox("unknown@example.com")).resolves.toMatchObject({
      actorId: actorOne,
      match: "catch_all",
    });
    await expect(store.resolveMailbox("owner@other.example")).resolves.toBeNull();
  });

  it("returns no mailbox for an unknown local part when catch-all is absent", async () => {
    const store = new InMemoryReceivingDomainStore({
      actors: [{ id: actorOne, orgId: orgOne, email: "owner@example.com" }],
    });
    const created = await store.createDomain({
      orgId: orgOne,
      domain: "example.com",
    });
    await store.markVerified(orgOne, created.id);
    await store.enableDomain(orgOne, created.id);
    await expect(store.resolveMailbox("unknown@example.com")).resolves.toBeNull();
  });
});

describe("receiving-domain verification challenges", () => {
  it("returns a one-time DNS token while retaining only its SHA-256 hash", () => {
    const proof = challenge("BÜCHER.example");
    expect(proof.dnsName).toBe("_helix-verification.xn--bcher-kva.example");
    expect(proof.dnsValue).toBe(`helix-domain-verification=${proof.token}`);
    expect(proof.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(proof.tokenHash).not.toContain(proof.token);
  });
});
