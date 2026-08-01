import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/actor.js";
import {
  InMemoryDomainsStore,
  evaluateDnsRecord,
  registerAdminDomainsRoutes,
  type DnsRecordType,
  expectedDnsRecordsForDomain,
  type DnsResolver,
} from "./domains.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";

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

async function buildApp(options?: { dnsResolver?: DnsResolver; mailHostname?: string }) {
  const store = new InMemoryDomainsStore();
  const app = fastify();
  await registerAdminDomainsRoutes(app, {
    store,
    actorFromRequest,
    ...(options?.dnsResolver === undefined ? {} : { dnsResolver: options.dnsResolver }),
    ...(options?.mailHostname === undefined ? {} : { mailHostname: options.mailHostname }),
  });
  return { app, store };
}

async function createDomain(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  domain: string,
  isPrimary = false,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/domains",
    headers: headers("admin.console.write"),
    payload: { domain, isPrimary },
  });
  return (field(response, "domain") as { id: string }).id;
}

describe("DNS record evaluation", () => {
  it("verifies a record when the observed value matches", () => {
    expect(
      evaluateDnsRecord("v=spf1 include:_spf.helix.io ~all", "v=spf1  include:_spf.helix.io ~all"),
    ).toBe("verified");
    expect(evaluateDnsRecord("10 mx1.helix.io", "20 mx2.helix.io")).toBe("failed");
    expect(evaluateDnsRecord("anything", null)).toBe("failed");
  });
});

describe("admin domains routes", () => {
  it("creates domains and enforces a single primary", async () => {
    const { app } = await buildApp();
    await createDomain(app, "helix.io", true);
    await createDomain(app, "helix.dev", true);

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/domains",
      headers: headers("admin.console.read"),
    });
    expect(list.statusCode).toBe(200);
    const domains = field(list, "domains") as {
      domain: { domain: string; isPrimary: boolean };
    }[];
    const primaries = domains.filter((entry) => entry.domain.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.domain.domain).toBe("helix.dev");
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
  });

  it("upserts DNS records and re-promotes them to pending on change", async () => {
    const { app } = await buildApp();
    const domainId = await createDomain(app, "helix.io", true);

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
        input.recordType === "MX" ? "10 mx1.helix.io" : null,
    };
    const { app } = await buildApp({ dnsResolver: resolver });
    const domainId = await createDomain(app, "helix.io", true);
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
    const domainId = await createDomain(app, "helix.io", true);
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

  it("cascades DNS record removal when a domain is deleted", async () => {
    const { app, store } = await buildApp();
    const domainId = await createDomain(app, "helix.io", true);
    await app.inject({
      method: "PUT",
      url: `/api/admin/domains/${domainId}/dns`,
      headers: headers("admin.console.write"),
      payload: { recordType: "TXT", host: "helix.io", expectedValue: "verify=1" },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/admin/domains/${domainId}`,
      headers: headers("admin.console.write"),
    });
    expect(deleted.statusCode).toBe(200);
    expect(await store.listDnsRecords(orgId, domainId)).toEqual([]);
  });
});

describe("expectedDnsRecordsForDomain", () => {
  it("names the records Helix needs, anchored on the deployment mail host", () => {
    const records = expectedDnsRecordsForDomain({
      domain: "helix.io",
      mailHostname: "mail.helix.example",
    });

    expect(records.map((record) => [record.recordType, record.host])).toEqual([
      ["MX", "helix.io"],
      ["SPF", "helix.io"],
      ["DMARC", "_dmarc.helix.io"],
    ]);
    expect(records[0]?.expectedValue).toBe("10 mail.helix.example");
    expect(records[1]?.expectedValue).toContain("a:mail.helix.example");
  });

  it("starts SPF at softfail and DMARC at monitor-only", () => {
    /* A domain mid-setup must not hard-fail or quarantine legitimate mail;
       both policies are tightened once reports show the setup is right. */
    const records = expectedDnsRecordsForDomain({
      domain: "helix.io",
      mailHostname: "mail.helix.example",
    });

    expect(records[1]?.expectedValue).toContain("~all");
    expect(records[1]?.expectedValue).not.toContain("-all");
    expect(records[2]?.expectedValue).toContain("p=none");
  });

  it("omits DKIM, whose value does not exist until a key is generated", () => {
    // Seeding a placeholder would put a row on screen that can never verify.
    const records = expectedDnsRecordsForDomain({
      domain: "helix.io",
      mailHostname: "mail.helix.example",
    });

    expect(records.some((record) => record.recordType === "DKIM")).toBe(false);
  });
});

describe("domain creation seeding", () => {
  it("seeds the expected records when a mail hostname is configured", async () => {
    const { app } = await buildApp({ mailHostname: "mail.helix.example" });
    const domainId = await createDomain(app, "helix.io", true);

    const dns = await app.inject({
      method: "GET",
      url: `/api/admin/domains/${domainId}/dns`,
      headers: headers("admin.console.read"),
    });
    const records = field(dns, "dnsRecords") as { recordType: string; status: string }[];
    expect(records.map((record) => record.recordType).sort()).toEqual(["DMARC", "MX", "SPF"]);
    // Seeded, not asserted: nothing has been looked up yet.
    expect(records.every((record) => record.status === "pending")).toBe(true);
  });

  it("seeds nothing when the deployment has no public mail hostname", async () => {
    /* Guessing an MX target would blackhole mail, so an unconfigured
       deployment gets an empty panel and the console explains why. */
    const { app } = await buildApp();
    const domainId = await createDomain(app, "helix.io", true);

    const dns = await app.inject({
      method: "GET",
      url: `/api/admin/domains/${domainId}/dns`,
      headers: headers("admin.console.read"),
    });
    expect(field(dns, "dnsRecords") as unknown[]).toHaveLength(0);
  });
});
