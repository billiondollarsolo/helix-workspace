import { describe, expect, it, vi } from "vitest";
import { InMemoryOutboundProviderStore, InMemorySendingDomainStore } from "./admin-store.js";
import {
  DispatchTimeTransportResolver,
  withOutboundRoutingInvalidation,
} from "./outbound-routing.js";
import type { FetchLike } from "./providers.js";

const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "22222222-2222-4222-8222-222222222222";
const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fakeFetch(): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => "ok",
    json: async () => ({ id: "provider-message-id" }),
  });
}

describe("DispatchTimeTransportResolver", () => {
  it("resolves different organization defaults in one worker", async () => {
    const providers = new InMemoryOutboundProviderStore();
    const domains = new InMemorySendingDomainStore();
    await createMailgun(providers, orgA, "org-a", true, "SECRET_A");
    await createMailgun(providers, orgB, "org-b", true, "SECRET_B");
    const secretCalls: string[] = [];
    const resolver = new DispatchTimeTransportResolver({
      providerStore: providers,
      domainStore: domains,
      secrets: {
        resolveSecret: async (ref) => {
          secretCalls.push(ref);
          return `value-for-${ref}`;
        },
      },
      fetch: fakeFetch(),
    });

    const [decisionA, decisionB] = await Promise.all([
      resolver.transportFor(orgA, "a.example"),
      resolver.transportFor(orgB, "b.example"),
    ]);

    expect(decisionA.providerId).not.toBe(decisionB.providerId);
    expect(decisionA.source).toBe("org_default");
    expect(decisionB.source).toBe("org_default");
    expect(secretCalls.sort()).toEqual(["SECRET_A", "SECRET_B"]);
  });

  it("prefers a verified sending-domain provider over the org default", async () => {
    const providers = new InMemoryOutboundProviderStore();
    const domains = new InMemorySendingDomainStore();
    await createMailgun(providers, orgA, "default", true, "DEFAULT_SECRET");
    const dedicated = await createMailgun(providers, orgA, "dedicated", false, "DOMAIN_SECRET");
    const domain = await domains.createDomain({
      orgId: orgA,
      domain: "MÜNICH.example",
      isDefault: false,
      providerId: dedicated.id,
      createdBy: actor,
    });
    await domains.setDomainVerified(orgA, domain.id, true);
    const resolver = new DispatchTimeTransportResolver({
      providerStore: providers,
      domainStore: domains,
      secrets: { resolveSecret: async () => "secret" },
      fetch: fakeFetch(),
    });

    const decision = await resolver.transportFor(orgA, "xn--mnich-kva.example");
    expect(decision.providerId).toBe(dedicated.id);
    expect(decision.source).toBe("sending_domain");
  });

  it("invalidates cached configuration after an admin mutation", async () => {
    const baseProviders = new InMemoryOutboundProviderStore();
    const baseDomains = new InMemorySendingDomainStore();
    const resolverRef: { current?: DispatchTimeTransportResolver } = {};
    const stores = withOutboundRoutingInvalidation(baseProviders, baseDomains, (orgId) =>
      resolverRef.current?.invalidateOrg(orgId),
    );
    const original = await stores.providerStore.createProvider({
      orgId: orgA,
      name: "default",
      kind: "mailgun",
      enabled: true,
      isDefault: true,
      config: { domain: "mg.example" },
      secretRef: "SECRET",
      createdBy: actor,
    });
    const resolver = new DispatchTimeTransportResolver({
      providerStore: stores.providerStore,
      domainStore: stores.domainStore,
      secrets: { resolveSecret: async () => "secret" },
      fetch: fakeFetch(),
      cacheTtlMs: 60_000,
    });
    resolverRef.current = resolver;
    expect((await resolver.transportFor(orgA, "example.com")).providerId).toBe(original.id);

    await stores.providerStore.updateProvider({
      orgId: orgA,
      id: original.id,
      enabled: false,
    });
    await expect(resolver.transportFor(orgA, "example.com")).rejects.toThrow(
      /MAIL_PROVIDER_DISABLED/u,
    );
  });

  it("fetches secrets at call time and never places them in the decision", async () => {
    const providers = new InMemoryOutboundProviderStore();
    const domains = new InMemorySendingDomainStore();
    await createMailgun(providers, orgA, "default", true, "ROTATING_SECRET");
    const resolveSecret = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first-secret")
      .mockResolvedValueOnce("second-secret");
    const resolver = new DispatchTimeTransportResolver({
      providerStore: providers,
      domainStore: domains,
      secrets: { resolveSecret },
      fetch: fakeFetch(),
    });

    const first = await resolver.transportFor(orgA, "example.com");
    const second = await resolver.transportFor(orgA, "example.com", first.providerId);
    expect(resolveSecret).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([first, second])).not.toContain("first-secret");
    expect(JSON.stringify([first, second])).not.toContain("second-secret");
  });
});

async function createMailgun(
  store: InMemoryOutboundProviderStore,
  orgId: string,
  name: string,
  isDefault: boolean,
  secretRef: string,
) {
  return store.createProvider({
    orgId,
    name,
    kind: "mailgun",
    enabled: true,
    isDefault,
    config: { domain: `${name}.example` },
    secretRef,
    createdBy: actor,
  });
}
