import { describe, expect, it } from "vitest";
import {
  createReceivingDomainVerificationChallenge,
  InMemoryReceivingDomainStore,
} from "./receiving-domains-store.js";
import { DnsTxtReceivingDomainOwnershipVerifier } from "./receiving-domain-ownership.js";

const orgId = "10000000-0000-4000-8000-000000000001";

async function record() {
  const challenge = createReceivingDomainVerificationChallenge("example.com");
  const store = new InMemoryReceivingDomainStore();
  const domain = await store.createDomain({
    orgId,
    domain: "example.com",
    verificationTokenHash: challenge.tokenHash,
  });
  return { challenge, domain };
}

describe("DnsTxtReceivingDomainOwnershipVerifier", () => {
  it("accepts a split TXT answer containing the exact challenge", async () => {
    const fixture = await record();
    const verifier = new DnsTxtReceivingDomainOwnershipVerifier(async (name) => {
      expect(name).toBe("_helix-verification.example.com");
      return [
        [
          "helix-domain-verification=",
          fixture.challenge.token.slice(0, 10),
          fixture.challenge.token.slice(10),
        ],
      ];
    });
    await expect(verifier.verify(fixture.domain)).resolves.toBe(true);
  });

  it("rejects unrelated, missing, and forged TXT answers", async () => {
    const fixture = await record();
    const unrelated = new DnsTxtReceivingDomainOwnershipVerifier(async () => [
      ["google-site-verification=abc"],
      ["helix-domain-verification=forged"],
    ]);
    await expect(unrelated.verify(fixture.domain)).resolves.toBe(false);

    const missing = new DnsTxtReceivingDomainOwnershipVerifier(async () => {
      throw Object.assign(new Error("not found"), { code: "ENODATA" });
    });
    await expect(missing.verify(fixture.domain)).resolves.toBe(false);
  });

  it("does not hide temporary resolver failures", async () => {
    const fixture = await record();
    const verifier = new DnsTxtReceivingDomainOwnershipVerifier(async () => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    });
    await expect(verifier.verify(fixture.domain)).rejects.toThrow("timeout");
  });
});
