import { describe, expect, it } from "vitest";
import {
  createSmtpRecipientResolver,
  PersonalSmtpRecipientResolver,
  ReceivingDomainSmtpRecipientResolver,
} from "./smtp-recipient-resolver.js";

describe("SMTP recipient resolver selection", () => {
  it("uses the M1 receiving-domain mailbox resolver when configured", async () => {
    const expected = {
      orgId: "org-1",
      receivingDomainId: "domain-1",
      domain: "example.com",
      normalizedAddress: "owner@example.com",
      actorId: "actor-1",
      match: "primary" as const,
    };
    const receivingDomains = {
      async resolveMailbox(address: string) {
        expect(address).toBe("Owner@Example.com");
        return expected;
      },
    };
    const resolver = new ReceivingDomainSmtpRecipientResolver(receivingDomains as never);
    await expect(resolver.resolveRecipient("Owner@Example.com")).resolves.toEqual(expected);
  });

  it("allows an exact known mailbox only in explicit Personal single-tenant fallback", async () => {
    const resolver = new PersonalSmtpRecipientResolver({
      deploymentMode: "single-tenant",
      securityTier: "personal",
      orgId: "org-personal",
      store: {
        async findActorByAddress(orgId, address) {
          expect(orgId).toBe("org-personal");
          return address === "owner@xn--bcher-kva.example"
            ? { actorId: "actor-1", email: address }
            : null;
        },
      },
    });
    await expect(resolver.resolveRecipient("Owner@BÜCHER.example")).resolves.toMatchObject({
      orgId: "org-personal",
      normalizedAddress: "owner@xn--bcher-kva.example",
      actorId: "actor-1",
    });
    await expect(resolver.resolveRecipient("unknown@example.com")).resolves.toBeNull();
  });

  it.each([
    ["multi-tenant-saas", "personal"],
    ["single-tenant", "business"],
    ["multi-tenant-saas", "business"],
  ] as const)("rejects fallback in %s / %s mode", (deploymentMode, securityTier) => {
    expect(
      () =>
        new PersonalSmtpRecipientResolver({
          deploymentMode,
          securityTier,
          orgId: "org-1",
          store: {
            async findActorByAddress() {
              return null;
            },
          },
        }),
    ).toThrow("forbidden");
  });

  it("fails closed when no routing source is configured", () => {
    expect(() => createSmtpRecipientResolver({})).toThrow("requires");
  });
});
