import { describe, expect, it } from "vitest";
import { createDomainOwnershipChallenge } from "../admin/domain-identity.js";
import { InMemoryReceivingDomainStore } from "./receiving-domains-store.js";
import {
  DnsTxtReceivingDomainOwnershipVerifier,
  type DomainOwnershipTokenSource,
} from "./receiving-domain-ownership.js";

const orgId = "10000000-0000-4000-8000-000000000001";

/** The parent's ownership digest, which is where the proof lives since 0087. */
function tokens(tokenHash: string | null): DomainOwnershipTokenSource {
  return {
    async getOwnershipTokenHash() {
      return tokenHash;
    },
  };
}

/** A receiving capability plus the challenge issued against its parent. */
async function fixture() {
  const challenge = createDomainOwnershipChallenge("example.com");
  const store = new InMemoryReceivingDomainStore();
  const domain = await store.createDomain({ orgId, domain: "example.com" });
  return { challenge, domain };
}

describe("DnsTxtReceivingDomainOwnershipVerifier", () => {
  it("accepts a split TXT answer containing the exact challenge", async () => {
    // A TXT value over 255 bytes arrives chunked; the record is their join.
    const { challenge, domain } = await fixture();
    const verifier = new DnsTxtReceivingDomainOwnershipVerifier(
      tokens(challenge.tokenHash),
      async (name) => {
        expect(name).toBe("_helix-verification.example.com");
        return [
          ["helix-domain-verification=", challenge.token.slice(0, 10), challenge.token.slice(10)],
        ];
      },
    );

    await expect(verifier.verify(domain)).resolves.toBe(true);
  });

  it("rejects unrelated, missing, and forged TXT answers", async () => {
    const { challenge, domain } = await fixture();

    const unrelated = new DnsTxtReceivingDomainOwnershipVerifier(
      tokens(challenge.tokenHash),
      async () => [["google-site-verification=abc"], ["helix-domain-verification=forged"]],
    );
    await expect(unrelated.verify(domain)).resolves.toBe(false);

    const missing = new DnsTxtReceivingDomainOwnershipVerifier(
      tokens(challenge.tokenHash),
      async () => {
        throw Object.assign(new Error("not found"), { code: "ENODATA" });
      },
    );
    await expect(missing.verify(domain)).resolves.toBe(false);
  });

  it("does not hide temporary resolver failures", async () => {
    /* Could-not-look is not the same as not-published: collapsing it to false
       tells an operator their DNS is wrong when the fault is ours. */
    const { challenge, domain } = await fixture();
    const verifier = new DnsTxtReceivingDomainOwnershipVerifier(
      tokens(challenge.tokenHash),
      async () => {
        throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
      },
    );

    await expect(verifier.verify(domain)).rejects.toThrow("timeout");
  });

  it("refuses when the parent domain has no challenge issued", async () => {
    /* Nothing to compare against. Returning true here would let a capability
       claim ownership of a domain nobody ever proved. */
    const { domain } = await fixture();
    const verifier = new DnsTxtReceivingDomainOwnershipVerifier(tokens(null), async () => [
      ["helix-domain-verification=anything"],
    ]);

    await expect(verifier.verify(domain)).resolves.toBe(false);
  });

  it("reads the proof from the parent, not from the capability", async () => {
    /* The point of 0087: proving example.com once serves every capability on
       it. This asserts the verifier consults the identity it was given. */
    const { challenge, domain } = await fixture();
    const seen: string[] = [];
    const verifier = new DnsTxtReceivingDomainOwnershipVerifier(
      {
        async getOwnershipTokenHash(_orgId: string, adminDomainId: string) {
          seen.push(adminDomainId);
          return challenge.tokenHash;
        },
      },
      async () => [[`helix-domain-verification=${challenge.token}`]],
    );

    await expect(verifier.verify(domain)).resolves.toBe(true);
    expect(seen).toEqual([domain.adminDomainId]);
  });
});
