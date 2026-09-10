import type { Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/test-actor.js";
import {
  InMemoryDomainsStore,
  evaluateDnsRecord,
  normalizeDomain,
  registerAdminDomainsRoutes,
  type DnsRecordType,
  type DnsResolver,
} from "./domains.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const auditSink = { append: async () => ({ id: "audit", thisHash: "hash" }) };

function headers(scopes: string): Record<string, string> {
  return {
    "x-helix-actor-id": actorId,
    "x-helix-org-id": orgId,
    "x-helix-scopes": scopes,
  };
}

function body(response: { json: () => unknown }): Record<string, unknown> {
  return response.json() as Record<string, unknown>;
}

function field(response: { json: () => unknown }, key: string): unknown {
  return body(response)[key];
}

async function buildApp(options?: {
  dnsResolver?: DnsResolver;
  now?: () => Date;
  challengeToken?: () => string;
}) {
  const now = options?.now ?? (() => new Date("2026-09-02T12:00:00.000Z"));
  const store = new InMemoryDomainsStore({ now });
  const app = fastify();
  await registerAdminDomainsRoutes(app, {
    store,
    actorFromRequest,
    auditSink,
    now,
    challengeToken: options?.challengeToken ?? (() => "test-generated-challenge"),
    ...(options?.dnsResolver === undefined ? {} : { dnsResolver: options.dnsResolver }),
  });
  return { app, store };
}

async function createDomain(app: Awaited<ReturnType<typeof buildApp>>["app"], domain: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/domains",
    headers: headers("admin.console.write"),
    payload: { domain },
  });
  return (field(response, "domain") as { id: string }).id;
}

describe("DNS record evaluation", () => {
  it("verifies a record when the observed value matches", () => {
    expect(
      evaluateDnsRecord("SPF", "v=spf1 include:_spf.helix.io ~all", [
        "v=spf1  include:_spf.helix.io ~all",
      ]),
    ).toBe("verified");
    expect(evaluateDnsRecord("MX", "10 mx1.helix.io", ["20 mx2.helix.io"])).toBe("failed");
    expect(evaluateDnsRecord("TXT", "anything", [])).toBe("failed");
    expect(evaluateDnsRecord("TXT", "case-sensitive", ["CASE-SENSITIVE"])).toBe("failed");
  });

  it("normalizes case and rejects ambiguous, public-suffix, and confusable hostnames", () => {
    expect(normalizeDomain("HELIX.IO")).toBe("helix.io");
    for (const invalid of [
      "localhost",
      "127.0.0.1",
      "bad..example",
      "-bad.example",
      "x.test.",
      "co.uk",
      "bücher.de",
      "xn--bcher-kva.de",
    ]) {
      expect(() => normalizeDomain(invalid)).toThrow();
    }
  });
});

describe("admin domains routes", () => {
  it("creates domains pending and refuses an unverified primary", async () => {
    const { app } = await buildApp();
    await createDomain(app, "helix.io");
    const secondId = await createDomain(app, "helix.dev");

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/domains",
      headers: headers("admin.console.read"),
    });
    expect(list.statusCode).toBe(200);
    const domains = field(list, "domains") as {
      domain: { domain: string; isPrimary: boolean };
    }[];
    expect(domains.filter((entry) => entry.domain.isPrimary)).toHaveLength(0);
    const promote = await app.inject({
      method: "POST",
      url: `/api/admin/domains/${secondId}/primary`,
      headers: headers("admin.console.write"),
    });
    expect(promote.statusCode).toBe(409);
  });

  it("creates a server-owned expiring challenge and verifies only that TXT value", async () => {
    const resolver: DnsResolver = {
      lookup: async ({ host }) =>
        host === "_helix-verification.helix.io"
          ? ["unrelated=old", "helix-domain-verification=test-generated-challenge"]
          : [],
    };
    const { app } = await buildApp({ dnsResolver: resolver });
    const domainId = await createDomain(app, "helix.io");

    const before = await app.inject({
      method: "GET",
      url: "/api/admin/domains",
      headers: headers("admin.console.read"),
    });
    const entry = (field(before, "domains") as Array<Record<string, Record<string, unknown>>>)[0]
      ?.domain;
    expect(entry?.verificationHost).toBe("_helix-verification.helix.io");
    expect(entry?.verificationValue).toBe("helix-domain-verification=test-generated-challenge");
    expect(entry?.verificationExpiresAt).toBe("2026-09-05T12:00:00.000Z");

    const verify = await app.inject({
      method: "POST",
      url: `/api/admin/domains/${domainId}/verify`,
      headers: headers("admin.console.write"),
    });
    expect(verify.statusCode).toBe(200);
    const verified = field(verify, "domain") as {
      status: string;
      verificationAttempts: number;
      identityEnabled: boolean;
    };
    expect(verified).toMatchObject({
      status: "verified",
      verificationAttempts: 1,
      identityEnabled: false,
    });

    const enabled = await app.inject({
      method: "PATCH",
      url: `/api/admin/domains/${domainId}/capabilities`,
      headers: headers("admin.console.write"),
      payload: { identityEnabled: true },
    });
    expect((field(enabled, "domain") as { isPrimary: boolean }).isPrimary).toBe(true);

    const primary = await app.inject({
      method: "POST",
      url: `/api/admin/domains/${domainId}/primary`,
      headers: headers("admin.console.write"),
    });
    expect((field(primary, "domain") as { isPrimary: boolean }).isPrimary).toBe(true);
    const blockedDelete = await app.inject({
      method: "DELETE",
      url: `/api/admin/domains/${domainId}`,
      headers: headers("admin.console.write"),
    });
    expect(blockedDelete.statusCode).toBe(409);
  });

  it("does not let a caller-selected DNS record prove ownership", async () => {
    const resolver: DnsResolver = { lookup: async () => ["caller-controlled"] };
    const { app } = await buildApp({ dnsResolver: resolver });
    const domainId = await createDomain(app, "helix.io");
    const created = await app.inject({
      method: "PUT",
      url: `/api/admin/domains/${domainId}/dns`,
      headers: headers("admin.console.write"),
      payload: { recordType: "TXT", host: "helix.io", expectedValue: "caller-controlled" },
    });
    const recordId = (field(created, "dnsRecord") as { id: string }).id;
    await app.inject({
      method: "POST",
      url: `/api/admin/domains/${domainId}/dns/${recordId}/verify`,
      headers: headers("admin.console.write"),
    });
    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/domains",
      headers: headers("admin.console.read"),
    });
    const domain = (field(listed, "domains") as Array<{ domain: { status: string } }>)[0]?.domain;
    expect(domain?.status).toBe("pending");
  });

  it("expires challenges, rotates them, and rate-limits failed retries", async () => {
    let currentTime = new Date("2026-09-02T12:00:00.000Z");
    let sequence = 0;
    const resolver: DnsResolver = { lookup: async () => [] };
    const { app } = await buildApp({
      dnsResolver: resolver,
      now: () => currentTime,
      challengeToken: () => `challenge-${String(++sequence)}`,
    });
    const domainId = await createDomain(app, "helix.io");

    const failed = await app.inject({
      method: "POST",
      url: `/api/admin/domains/${domainId}/verify`,
      headers: headers("admin.console.write"),
    });
    expect((field(failed, "domain") as { status: string }).status).toBe("pending");
    const throttled = await app.inject({
      method: "POST",
      url: `/api/admin/domains/${domainId}/verify`,
      headers: headers("admin.console.write"),
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBe("30");

    currentTime = new Date("2026-09-06T12:00:00.000Z");
    const expired = await app.inject({
      method: "POST",
      url: `/api/admin/domains/${domainId}/verify`,
      headers: headers("admin.console.write"),
    });
    expect(expired.statusCode).toBe(410);
    const rotated = await app.inject({
      method: "POST",
      url: `/api/admin/domains/${domainId}/challenge`,
      headers: headers("admin.console.write"),
    });
    const domain = field(rotated, "domain") as {
      verificationValue: string;
      verificationAttempts: number;
      status: string;
    };
    expect(domain).toMatchObject({
      verificationValue: "helix-domain-verification=challenge-2",
      verificationAttempts: 0,
      status: "pending",
    });
  });

  it("rejects a duplicate domain with 409", async () => {
    const { app } = await buildApp();
    await createDomain(app, "helix.io");
    const dup = await app.inject({
      method: "POST",
      url: "/api/admin/domains",
      headers: headers("admin.console.write"),
      payload: { domain: "HELIX.IO" },
    });
    expect(dup.statusCode).toBe(409);
    expect(body(dup).code).toBe("conflict");

    const otherOrg = await app.inject({
      method: "POST",
      url: "/api/admin/domains",
      headers: {
        ...headers("admin.console.write"),
        "x-helix-org-id": "33333333-3333-4333-8333-333333333333",
      },
      payload: { domain: "helix.io" },
    });
    expect(otherOrg.statusCode).toBe(409);
  });

  it("upserts DNS records and re-promotes them to pending on change", async () => {
    const { app } = await buildApp();
    const domainId = await createDomain(app, "helix.io");

    const created = await app.inject({
      method: "PUT",
      url: `/api/admin/domains/${domainId}/dns`,
      headers: headers("admin.console.write"),
      payload: { recordType: "SPF", host: "helix.io", expectedValue: "v=spf1 ~all" },
    });
    expect(created.statusCode).toBe(200);
    expect((field(created, "dnsRecord") as { status: string }).status).toBe("pending");

    const dns = await app.inject({
      method: "GET",
      url: `/api/admin/domains/${domainId}/dns`,
      headers: headers("admin.console.read"),
    });
    expect(field(dns, "dnsRecords") as unknown[]).toHaveLength(1);
  });

  it("verifies a DNS record against the resolver", async () => {
    const resolver: DnsResolver = {
      lookup: async (input: { recordType: DnsRecordType; host: string }) =>
        input.recordType === "MX" ? ["10 mx1.helix.io"] : [],
    };
    const { app } = await buildApp({ dnsResolver: resolver });
    const domainId = await createDomain(app, "helix.io");
    const created = await app.inject({
      method: "PUT",
      url: `/api/admin/domains/${domainId}/dns`,
      headers: headers("admin.console.write"),
      payload: { recordType: "MX", host: "helix.io", expectedValue: "10 mx1.helix.io" },
    });
    const recordId = (field(created, "dnsRecord") as { id: string }).id;

    const verify = await app.inject({
      method: "POST",
      url: `/api/admin/domains/${domainId}/dns/${recordId}/verify`,
      headers: headers("admin.console.write"),
    });
    expect(verify.statusCode).toBe(200);
    const verifiedRecord = field(verify, "dnsRecord") as { status: string; observedValue: string };
    expect(verifiedRecord.status).toBe("verified");
    expect(verifiedRecord.observedValue).toBe("10 mx1.helix.io");
  });

  it("returns 503 for verify when no resolver is configured", async () => {
    const { app } = await buildApp();
    const domainId = await createDomain(app, "helix.io");
    const created = await app.inject({
      method: "PUT",
      url: `/api/admin/domains/${domainId}/dns`,
      headers: headers("admin.console.write"),
      payload: { recordType: "DKIM", host: "helix._domainkey", expectedValue: "v=DKIM1; p=abc" },
    });
    const recordId = (field(created, "dnsRecord") as { id: string }).id;
    const verify = await app.inject({
      method: "POST",
      url: `/api/admin/domains/${domainId}/dns/${recordId}/verify`,
      headers: headers("admin.console.write"),
    });
    expect(verify.statusCode).toBe(503);
  });

  it("requires the write scope to register a domain", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/domains",
      headers: headers("admin.console.read"),
      payload: { domain: "helix.io" },
    });
    expect(response.statusCode).toBe(403);
    expect(body(response).requiredScope).toBe("admin.console.write");
  });

  it("releases a domain without deleting its DNS history", async () => {
    const { app, store } = await buildApp();
    const domainId = await createDomain(app, "helix.io");
    await app.inject({
      method: "PUT",
      url: `/api/admin/domains/${domainId}/dns`,
      headers: headers("admin.console.write"),
      payload: { recordType: "TXT", host: "helix.io", expectedValue: "verify=1" },
    });
    const released = await app.inject({
      method: "DELETE",
      url: `/api/admin/domains/${domainId}`,
      headers: headers("admin.console.write"),
    });
    expect(released.statusCode).toBe(200);
    expect(body(released).status).toBe("released");
    expect(await store.listDnsRecords(orgId, domainId)).toHaveLength(1);
    const rotate = await app.inject({
      method: "POST",
      url: `/api/admin/domains/${domainId}/challenge`,
      headers: headers("admin.console.write"),
    });
    expect(rotate.statusCode).toBe(409);
  });

  it("keeps a delegated domain admin off peer and organization-wide operations", async () => {
    const now = () => new Date("2026-09-02T12:00:00.000Z");
    const store = new InMemoryDomainsStore({ now });
    const create = (domain: string) =>
      store.createDomain({
        orgId,
        domain,
        createdBy: actorId,
        verificationHost: `_helix-verification.${domain}`,
        verificationValue: "challenge",
        verificationExpiresAt: "2026-09-05T12:00:00.000Z",
      });
    const scopedDomain = await create("scoped.example");
    const peerDomain = await create("peer.example");
    const delegated: Actor = {
      id: actorId,
      orgId,
      type: "user",
      scopes: [],
      roleBindings: [
        {
          roleId: "00000000-0000-4000-8000-000000000051",
          allow: ["admin.domains"],
          deny: [],
          scope: { type: "resource", resourceType: "domain", id: scopedDomain.id },
        },
      ],
    };
    const app = fastify();
    await registerAdminDomainsRoutes(app, {
      store,
      actorFromRequest: async () => delegated,
      auditSink,
      now,
    });

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/domains/${scopedDomain.id}/challenge`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/domains/${peerDomain.id}/challenge`,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/domains/${scopedDomain.id}/primary`,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/domains",
          payload: { domain: "widened.example" },
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });
});
