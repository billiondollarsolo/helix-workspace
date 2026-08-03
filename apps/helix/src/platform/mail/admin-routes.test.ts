import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import {
  buildMailSpamAdminSettings,
  registerMailDeliveryAdminRoutes,
  summarizeDmarcReports,
} from "./admin-routes.js";
import {
  InMemoryMailDkimKeyStore,
  InMemoryMailDmarcReportStore,
  InMemoryMailRoutingRuleStore,
  InMemoryOutboundProviderStore,
  InMemorySendingDomainStore,
  type MailDmarcReportRecord,
} from "./admin-store.js";
import { parseDmarcAggregateReport, DmarcReportParseError } from "./dmarc.js";

const orgId = "22222222-2222-4222-8222-222222222222";

const adminActor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId,
  type: "user",
  displayName: "Admin",
  scopes: ["admin.console.write"],
};

const readerActor: Actor = { ...adminActor, scopes: ["admin.console.read"] };
const unprivilegedActor: Actor = { ...adminActor, scopes: ["mail.read"] };

let app: FastifyInstance;
let currentActor: Actor;
let domainStore: InMemorySendingDomainStore;
const audited: { verb: string; objectType: string }[] = [];

/** A Fastify inject response narrowed to a status code and a JSON payload. */
function readResponse(response: { statusCode: number; json: () => unknown }): {
  statusCode: number;
  payload: unknown;
} {
  return {
    statusCode: response.statusCode,
    payload: response.statusCode === 204 ? undefined : response.json(),
  };
}

/** A view over an inject response: a status code and a JSON body accessor. */
class InjectResponse {
  constructor(
    readonly statusCode: number,
    private readonly payload: unknown,
  ) {}

  /** The JSON body, narrowed to the caller-supplied shape `T`. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  body<T>(): T {
    return this.payload as T;
  }
}

/** A request descriptor accepted by Fastify's `inject` test helper. */
interface InjectRequest {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly url: string;
  readonly payload?: Record<string, unknown>;
}

/** Inject a request and return its status plus a JSON body accessor. */
async function inject(options: InjectRequest): Promise<InjectResponse> {
  const response = await app.inject(options);
  const { statusCode, payload } = readResponse(response);
  return new InjectResponse(statusCode, payload);
}

beforeEach(async () => {
  currentActor = adminActor;
  audited.length = 0;
  app = fastify();
  domainStore = new InMemorySendingDomainStore();
  await registerMailDeliveryAdminRoutes(app, {
    providerStore: new InMemoryOutboundProviderStore(),
    domainStore,
    dkimStore: new InMemoryMailDkimKeyStore(),
    dmarcStore: new InMemoryMailDmarcReportStore(),
    routingStore: new InMemoryMailRoutingRuleStore(),
    actorFromRequest: () => currentActor,
    auditSink: {
      async append(record) {
        audited.push({ verb: record.verb, objectType: record.objectType });
        return { id: "audit-1", thisHash: "hash" };
      },
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

interface ProviderView {
  readonly id: string;
  readonly kind: string;
  readonly enabled: boolean;
  readonly hasSecret: boolean;
  readonly secretRef: string | null;
}
interface DomainView {
  readonly id: string;
  readonly domain: string;
  readonly verifiedAt: string | null;
}
interface DkimKeyView {
  readonly id: string;
  readonly selector: string;
  readonly status: string;
  readonly dnsRecord: string;
  readonly dnsHost: string;
  readonly privateKeyStored: boolean;
}
interface RuleView {
  readonly id: string;
  readonly actionKind: string;
  readonly isEnabled: boolean;
}
interface DmarcReportView {
  readonly totalMessages: number;
  readonly passMessages: number;
}
interface DmarcSummaryView {
  readonly passRate: number;
  readonly topFailingSources: readonly { readonly sourceIp: string }[];
}

/* The half of the client/server route contract that lives on the server.
 *
 * This list is duplicated verbatim in the web app's
 * mail-admin-api.contract.test.ts, which asserts the admin console issues
 * exactly these method/path pairs. Two of them used to exist on only one side —
 * the console called `POST /providers/:id/set-default` and `GET /dmarc`, neither
 * of which was ever registered, so Deliverability was a permanent 404 and
 * "Make default" failed on every click while both sides' own tests stayed green.
 * Delete or rename a route here and the pair stops matching. */
const CONSOLE_ROUTES = [
  { method: "GET", url: "/api/admin/mail/providers" },
  { method: "POST", url: "/api/admin/mail/providers" },
  { method: "PATCH", url: "/api/admin/mail/providers/:id" },
  { method: "GET", url: "/api/admin/mail/sending-domains" },
  { method: "POST", url: "/api/admin/mail/sending-domains" },
  { method: "DELETE", url: "/api/admin/mail/sending-domains/:id" },
  { method: "POST", url: "/api/admin/mail/sending-domains/:id/dkim" },
  { method: "POST", url: "/api/admin/mail/sending-domains/:id/dkim/rotate" },
  { method: "GET", url: "/api/admin/mail/dmarc" },
  { method: "GET", url: "/api/admin/mail/routing-rules" },
  { method: "POST", url: "/api/admin/mail/routing-rules" },
  { method: "PATCH", url: "/api/admin/mail/routing-rules/:id" },
  { method: "DELETE", url: "/api/admin/mail/routing-rules/:id" },
  { method: "GET", url: "/api/admin/mail/spam" },
] as const;

describe("admin console route contract", () => {
  for (const route of CONSOLE_ROUTES) {
    it(`registers ${route.method} ${route.url}`, () => {
      expect(app.hasRoute({ method: route.method, url: route.url })).toBe(true);
    });
  }
});

describe("outbound provider admin routes", () => {
  it("creates, lists, updates, and deletes a provider; secrets are never echoed", async () => {
    const created = await inject({
      method: "POST",
      url: "/api/admin/mail/providers",
      payload: {
        name: "Primary Mailgun",
        kind: "mailgun",
        isDefault: true,
        config: { domain: "mg.helix.test" },
        secretRef: "MAILGUN_API_KEY",
      },
    });
    expect(created.statusCode).toBe(201);
    const provider = created.body<{ provider: ProviderView }>().provider;
    expect(provider.kind).toBe("mailgun");
    expect(provider.hasSecret).toBe(true);
    expect(provider.secretRef).toBe("MAILGUN_API_KEY");
    expect(JSON.stringify(provider)).not.toContain("secret-value");

    const list = await inject({
      method: "GET",
      url: "/api/admin/mail/providers",
    });
    expect(list.body<{ providers: readonly ProviderView[] }>().providers).toHaveLength(1);

    const updated = await inject({
      method: "PATCH",
      url: `/api/admin/mail/providers/${provider.id}`,
      payload: { enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body<{ provider: ProviderView }>().provider.enabled).toBe(false);

    const removed = await inject({
      method: "DELETE",
      url: `/api/admin/mail/providers/${provider.id}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(audited.map((entry) => entry.verb)).toEqual([
      "mail.provider.created",
      "mail.provider.updated",
      "mail.provider.deleted",
    ]);
  });

  it("rejects a duplicate provider name with 409", async () => {
    const payload = { name: "Dup", kind: "smtp", config: { host: "relay.test" } };
    await inject({ method: "POST", url: "/api/admin/mail/providers", payload });
    const second = await inject({
      method: "POST",
      url: "/api/admin/mail/providers",
      payload,
    });
    expect(second.statusCode).toBe(409);
  });

  it("rejects an unknown provider kind with 400", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/admin/mail/providers",
      payload: { name: "Bad", kind: "carrier-pigeon", config: {} },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects arbitrary application secret references on create and update", async () => {
    const rejectedCreate = await inject({
      method: "POST",
      url: "/api/admin/mail/providers",
      payload: {
        name: "Unsafe",
        kind: "postmark",
        config: { baseUrl: "https://attacker.invalid" },
        secretRef: "BETTER_AUTH_SECRET",
      },
    });
    expect(rejectedCreate.statusCode).toBe(400);

    const created = await inject({
      method: "POST",
      url: "/api/admin/mail/providers",
      payload: {
        name: "Safe",
        kind: "postmark",
        secretRef: "POSTMARK_SERVER_TOKEN",
      },
    });
    const provider = created.body<{ provider: ProviderView }>().provider;
    const rejectedUpdate = await inject({
      method: "PATCH",
      url: `/api/admin/mail/providers/${provider.id}`,
      payload: { webhookSecretRef: "HELIX_DATA_ENCRYPTION_KEY" },
    });
    expect(rejectedUpdate.statusCode).toBe(400);
  });

  it("denies a read-only actor a write and an unprivileged actor a read", async () => {
    currentActor = readerActor;
    const write = await inject({
      method: "POST",
      url: "/api/admin/mail/providers",
      payload: { name: "X", kind: "smtp", config: { host: "h" } },
    });
    expect(write.statusCode).toBe(403);

    currentActor = unprivilegedActor;
    const read = await inject({ method: "GET", url: "/api/admin/mail/providers" });
    expect(read.statusCode).toBe(403);
  });
});

describe("sending domain and DKIM admin routes", () => {
  it("ignores a client that asserts its own verification", async () => {
    /* The route used to take `{ verified: boolean }` and write it straight to
       `verified_at`. Outbound routing selects a domain's dedicated transport on
       that column, so asserting the boolean was enough to route mail as a
       domain you had not proven you control. */
    const created = await inject({
      method: "POST",
      url: "/api/admin/mail/sending-domains",
      payload: { domain: "spoof.test", isDefault: false },
    });
    const domain = created.body<{ domain: DomainView }>().domain;

    const response = await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/verify`,
      payload: { verified: true },
    });

    expect(response.body<{ verified: boolean }>().verified).toBe(false);
    expect(response.body<{ domain: DomainView }>().domain.verifiedAt).toBeNull();
  });

  it("registers a domain, generates and rotates DKIM keys", async () => {
    const domainResponse = await inject({
      method: "POST",
      url: "/api/admin/mail/sending-domains",
      payload: { domain: "Helix.Test", isDefault: true },
    });
    expect(domainResponse.statusCode).toBe(201);
    const domain = domainResponse.body<{ domain: DomainView }>().domain;
    expect(domain.domain).toBe("helix.test");

    /* Verification reflects the DNS Helix has observed, so a freshly added
       domain is not verified and says which record is outstanding. */
    const unverified = await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/verify`,
    });
    expect(unverified.body<{ verified: boolean; spf: string; dkim: string }>()).toMatchObject({
      verified: false,
      spf: "pending",
      dkim: "pending",
    });
    expect(unverified.body<{ domain: DomainView }>().domain.verifiedAt).toBeNull();

    domainStore.setDnsPosture(domain.id, { spf: "verified", dkim: "verified" });
    const verify = await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/verify`,
    });
    expect(verify.body<{ domain: DomainView }>().domain.verifiedAt).not.toBeNull();

    const firstKey = await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/dkim`,
      payload: { selector: "s1", keyBits: 1024 },
    });
    expect(firstKey.statusCode).toBe(201);
    const key1 = firstKey.body<{ key: DkimKeyView }>().key;
    expect(key1.status).toBe("active");
    expect(key1.dnsRecord).toMatch(/^v=DKIM1; k=rsa; p=/u);
    expect(key1.dnsHost).toBe("s1._domainkey");
    // The private key must never leave the host.
    expect(JSON.stringify(key1)).not.toContain("PRIVATE KEY");
    expect(key1.privateKeyStored).toBe(true);

    // Rotation: a second key becomes active, the first is demoted to retiring.
    const secondKey = await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/dkim`,
      payload: { selector: "s2", keyBits: 1024 },
    });
    expect(secondKey.statusCode).toBe(201);

    const keys = await inject({
      method: "GET",
      url: `/api/admin/mail/sending-domains/${domain.id}/dkim`,
    });
    const byStatus = Object.fromEntries(
      keys.body<{ keys: readonly DkimKeyView[] }>().keys.map((key) => [key.selector, key.status]),
    );
    expect(byStatus).toEqual({ s1: "retiring", s2: "active" });

    const retiring = keys
      .body<{ keys: readonly DkimKeyView[] }>()
      .keys.find((key) => key.status === "retiring");
    const retired = await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/dkim/${retiring?.id ?? ""}/retire`,
    });
    expect(retired.statusCode).toBe(200);
    expect(retired.body<{ key: DkimKeyView }>().key.status).toBe("retired");
  });

  it("rotates a DKIM key in one call, demoting the incumbent to retiring", async () => {
    const created = await inject({
      method: "POST",
      url: "/api/admin/mail/sending-domains",
      payload: { domain: "rotate.helix.test" },
    });
    const domain = created.body<{ domain: DomainView }>().domain;
    await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/dkim`,
      payload: { selector: "s1", keyBits: 1024 },
    });

    const rotated = await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/dkim/rotate`,
      payload: { keyBits: 1024 },
    });
    expect(rotated.statusCode).toBe(201);
    const rotatedBody = rotated.body<{ key: DkimKeyView; keys: readonly DkimKeyView[] }>();
    expect(rotatedBody.key.status).toBe("active");
    // The selector is the server's to choose; the console never invents one.
    expect(rotatedBody.key.selector).toMatch(/^helix\d{8}(-\d+)?$/u);
    expect(JSON.stringify(rotatedBody)).not.toContain("PRIVATE KEY");

    /* The outgoing key must stay published in DNS while mail signed with it is
       still in flight — a rotation that retired it would break DKIM on those
       messages. Retiring is the separate `/retire` step. */
    const byStatus = Object.fromEntries(rotatedBody.keys.map((key) => [key.selector, key.status]));
    expect(byStatus.s1).toBe("retiring");
    expect(audited.map((entry) => entry.verb)).toContain("mail.dkim_key.rotated");
  });

  it("rotates without a request body", async () => {
    const created = await inject({
      method: "POST",
      url: "/api/admin/mail/sending-domains",
      payload: { domain: "bodyless.helix.test" },
    });
    const domain = created.body<{ domain: DomainView }>().domain;

    const rotated = await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/dkim/rotate`,
      payload: {},
    });
    expect(rotated.statusCode).toBe(201);
  });

  it("gives same-day rotations distinct selectors", async () => {
    const created = await inject({
      method: "POST",
      url: "/api/admin/mail/sending-domains",
      payload: { domain: "twice.helix.test" },
    });
    const domain = created.body<{ domain: DomainView }>().domain;

    const first = await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/dkim/rotate`,
      payload: { keyBits: 1024 },
    });
    const second = await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/dkim/rotate`,
      payload: { keyBits: 1024 },
    });
    expect(second.statusCode).toBe(201);
    expect(second.body<{ key: DkimKeyView }>().key.selector).not.toBe(
      first.body<{ key: DkimKeyView }>().key.selector,
    );
  });

  it("returns 404 rotating DKIM for an unknown domain", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/admin/mail/sending-domains/00000000-0000-4000-8000-000000000999/dkim/rotate",
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it("forbids DKIM rotation without admin console write", async () => {
    currentActor = readerActor;
    const response = await inject({
      method: "POST",
      url: "/api/admin/mail/sending-domains/00000000-0000-4000-8000-000000000999/dkim/rotate",
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });

  /* The console sends no selector: picking one requires reading the domain's
     existing selectors, and doing that from the browser is a list-then-generate
     pair that races other admins. The route used to demand it, so every
     "Generate DKIM key" click was a 400. */
  it("generates a DKIM key with a server-chosen selector when none is named", async () => {
    const created = await inject({
      method: "POST",
      url: "/api/admin/mail/sending-domains",
      payload: { domain: "selectorless.helix.test" },
    });
    const domain = created.body<{ domain: DomainView }>().domain;

    const generated = await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/dkim`,
      payload: {},
    });
    expect(generated.statusCode).toBe(201);
    const key = generated.body<{ key: DkimKeyView }>().key;
    expect(key.selector).toMatch(/^helix\d{8}(-\d+)?$/u);
    expect(key.status).toBe("active");
    expect(key.dnsHost).toBe(`${key.selector}._domainkey`);
    expect(JSON.stringify(key)).not.toContain("PRIVATE KEY");
  });

  it("gives same-day selector-less generations distinct selectors", async () => {
    const created = await inject({
      method: "POST",
      url: "/api/admin/mail/sending-domains",
      payload: { domain: "twiceselectorless.helix.test" },
    });
    const domain = created.body<{ domain: DomainView }>().domain;

    const first = await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/dkim`,
      payload: {},
    });
    const second = await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/dkim`,
      payload: {},
    });
    expect(second.statusCode).toBe(201);
    expect(second.body<{ key: DkimKeyView }>().key.selector).not.toBe(
      first.body<{ key: DkimKeyView }>().key.selector,
    );
  });

  it("still honours an explicitly named selector", async () => {
    const created = await inject({
      method: "POST",
      url: "/api/admin/mail/sending-domains",
      payload: { domain: "named.helix.test" },
    });
    const domain = created.body<{ domain: DomainView }>().domain;

    const generated = await inject({
      method: "POST",
      url: `/api/admin/mail/sending-domains/${domain.id}/dkim`,
      payload: { selector: "custom1", keyBits: 1024 },
    });
    expect(generated.statusCode).toBe(201);
    expect(generated.body<{ key: DkimKeyView }>().key.selector).toBe("custom1");
  });

  it("returns 404 generating a DKIM key for an unknown domain", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/admin/mail/sending-domains/00000000-0000-4000-8000-000000000999/dkim",
      payload: { selector: "s1" },
    });
    expect(response.statusCode).toBe(404);
  });
});

const SAMPLE_DMARC_REPORT = `<?xml version="1.0"?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <report_id>abc-123</report_id>
    <date_range><begin>1747699200</begin><end>1747785600</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>helix.test</domain>
    <p>quarantine</p>
    <sp>reject</sp>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.10</source_ip>
      <count>40</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>helix.test</header_from></identifiers>
  </record>
  <record>
    <row>
      <source_ip>198.51.100.7</source_ip>
      <count>10</count>
      <policy_evaluated><disposition>quarantine</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>helix.test</header_from></identifiers>
  </record>
</feedback>`;

describe("DMARC report parsing", () => {
  it("parses a DMARC aggregate report into structured records", () => {
    const parsed = parseDmarcAggregateReport(orgId, SAMPLE_DMARC_REPORT);
    expect(parsed.domain).toBe("helix.test");
    expect(parsed.reportId).toBe("abc-123");
    expect(parsed.policyP).toBe("quarantine");
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]?.messageCount).toBe(40);
  });

  it("rejects a malformed DMARC report", () => {
    expect(() => parseDmarcAggregateReport(orgId, "<notxml>")).toThrow(DmarcReportParseError);
  });
});

describe("DMARC admin routes", () => {
  it("ingests a report and summarizes deliverability", async () => {
    const ingestResponse = await inject({
      method: "POST",
      url: "/api/admin/mail/dmarc/reports",
      payload: { report: SAMPLE_DMARC_REPORT },
    });
    expect(ingestResponse.statusCode).toBe(201);
    expect(ingestResponse.body<{ report: DmarcReportView }>().report.totalMessages).toBe(50);
    expect(ingestResponse.body<{ report: DmarcReportView }>().report.passMessages).toBe(40);

    const summary = await inject({
      method: "GET",
      url: "/api/admin/mail/dmarc/summary?domain=helix.test",
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.body<{ summary: DmarcSummaryView }>().summary.passRate).toBeCloseTo(0.8);
    expect(
      summary.body<{ summary: DmarcSummaryView }>().summary.topFailingSources[0]?.sourceIp,
    ).toBe("198.51.100.7");

    const reports = await inject({
      method: "GET",
      url: "/api/admin/mail/dmarc/reports",
    });
    expect(reports.body<{ reports: readonly DmarcReportView[] }>().reports).toHaveLength(1);
  });

  /* One request serves the whole Deliverability tab: the header rates and the
     per-reporter rows are the same reports at two zoom levels, and the tenant
     budget is 5 rps. */
  it("serves the console aggregate from GET /api/admin/mail/dmarc", async () => {
    await inject({
      method: "POST",
      url: "/api/admin/mail/dmarc/reports",
      payload: { report: SAMPLE_DMARC_REPORT },
    });
    currentActor = readerActor;

    const aggregate = await inject({ method: "GET", url: "/api/admin/mail/dmarc" });
    expect(aggregate.statusCode).toBe(200);
    const body = aggregate.body<{
      summary: { dmarcPassRate: number; messagesEvaluated: number; windowDays: number };
      reports: readonly {
        id: string;
        reporter: string;
        domain: string;
        rangeStart: string;
        rangeEnd: string;
        total: number;
        passCount: number;
        failCount: number;
      }[];
    }>();
    expect(body.summary.dmarcPassRate).toBeCloseTo(0.8);
    expect(body.summary.messagesEvaluated).toBe(50);
    expect(body.summary.windowDays).toBeGreaterThanOrEqual(1);
    /* Field-for-field the shape the console's zod schema demands; anything
       missing here renders as "malformed response", not as a partial table. */
    expect(body.reports[0]).toMatchObject({
      domain: "helix.test",
      total: 50,
      passCount: 40,
      failCount: 10,
    });
    expect(typeof body.reports[0]?.reporter).toBe("string");
    expect(typeof body.reports[0]?.rangeStart).toBe("string");
    expect(typeof body.reports[0]?.rangeEnd).toBe("string");
  });

  /* A pass rate over zero measured messages is a number about nothing; the
     console drops the header rather than render a reassuring 100%. */
  it("reports no summary when no DMARC reports have arrived", async () => {
    const aggregate = await inject({ method: "GET", url: "/api/admin/mail/dmarc" });
    expect(aggregate.statusCode).toBe(200);
    expect(aggregate.body<{ summary: unknown; reports: readonly unknown[] }>()).toEqual({
      summary: null,
      reports: [],
    });
  });

  it("forbids the DMARC aggregate without admin console read", async () => {
    currentActor = unprivilegedActor;
    const response = await inject({ method: "GET", url: "/api/admin/mail/dmarc" });
    expect(response.statusCode).toBe(403);
  });

  it("rejects an invalid DMARC XML payload with 400", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/admin/mail/dmarc/reports",
      payload: { report: "<not-a-feedback/>" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("summarizeDmarcReports", () => {
  function report(overrides: Partial<MailDmarcReportRecord>): MailDmarcReportRecord {
    return {
      id: "r-1",
      orgId,
      domain: "helix.test",
      orgName: "google.com",
      reportId: "abc-123",
      dateRangeBegin: "2026-05-20T00:00:00.000Z",
      dateRangeEnd: "2026-05-21T00:00:00.000Z",
      policyP: "none",
      policySp: null,
      policyPct: 100,
      totalMessages: 100,
      passMessages: 80,
      failMessages: 20,
      createdAt: "2026-05-21T00:00:00.000Z",
      ...overrides,
    };
  }

  /* One unreadable range used to be folded straight into the running min/max,
     turning the window NaN and making the guard discard the whole org's summary —
     including a message count and pass rate that were measured and real. */
  it("skips an unreadable range instead of poisoning the aggregate", () => {
    const summary = summarizeDmarcReports([
      report({ id: "r-1" }),
      report({ id: "r-2", dateRangeBegin: "not-a-date", dateRangeEnd: "also-not-a-date" }),
    ]);
    expect(summary).not.toBeNull();
    expect(summary?.messagesEvaluated).toBe(200);
    expect(summary?.dmarcPassRate).toBeCloseTo(0.8);
    expect(summary?.windowDays).toBe(1);
    expect(summary?.reportCount).toBe(2);
  });

  it("keeps the window bound it can read when only the other end is unreadable", () => {
    const summary = summarizeDmarcReports([
      report({ id: "r-1", dateRangeBegin: "2026-05-14T00:00:00.000Z" }),
      report({ id: "r-2", dateRangeBegin: "garbage" }),
    ]);
    expect(summary?.windowDays).toBe(7);
  });

  /* No readable bound anywhere leaves the window unstated, and a summary whose
     rates describe an unknown period is worse than none. */
  it("reports nothing when no report carries a readable range", () => {
    expect(
      summarizeDmarcReports([report({ dateRangeBegin: "garbage", dateRangeEnd: "garbage" })]),
    ).toBeNull();
  });

  it("reports nothing when the reports cover no messages", () => {
    expect(
      summarizeDmarcReports([report({ totalMessages: 0, passMessages: 0, failMessages: 0 })]),
    ).toBeNull();
  });
});

describe("inbound routing rule admin routes", () => {
  it("creates, lists, updates, and deletes a routing rule", async () => {
    const created = await inject({
      method: "POST",
      url: "/api/admin/mail/routing-rules",
      payload: {
        name: "Support forwarding",
        actionKind: "forward",
        priority: 10,
        match: { recipientPattern: "support@helix.test" },
        action: { forwardTo: "team@helix.test", stopProcessing: true },
      },
    });
    expect(created.statusCode).toBe(201);
    const rule = created.body<{ rule: RuleView }>().rule;
    expect(rule.actionKind).toBe("forward");

    const list = await inject({
      method: "GET",
      url: "/api/admin/mail/routing-rules",
    });
    expect(list.body<{ rules: readonly RuleView[] }>().rules).toHaveLength(1);

    const updated = await inject({
      method: "PATCH",
      url: `/api/admin/mail/routing-rules/${rule.id}`,
      payload: { isEnabled: false },
    });
    expect(updated.body<{ rule: RuleView }>().rule.isEnabled).toBe(false);

    const removed = await inject({
      method: "DELETE",
      url: `/api/admin/mail/routing-rules/${rule.id}`,
    });
    expect(removed.statusCode).toBe(200);
  });

  it("rejects a routing rule whose action does not match the action kind", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/admin/mail/routing-rules",
      payload: {
        name: "Bad rule",
        actionKind: "forward",
        action: { tag: "oops" },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("exposes GET /api/admin/mail/spam with env-backed spamd posture", async () => {
    currentActor = readerActor;
    const previous = {
      enabled: process.env.MAIL_SPAMD_ENABLED,
      host: process.env.MAIL_SPAMD_HOST,
      threshold: process.env.MAIL_SPAMD_THRESHOLD,
    };
    try {
      delete process.env.MAIL_SPAMD_ENABLED;
      delete process.env.MAIL_SPAMD_HOST;
      delete process.env.MAIL_SPAMD_THRESHOLD;

      const off = await inject({ method: "GET", url: "/api/admin/mail/spam" });
      expect(off.statusCode).toBe(200);
      expect(off.body<{ enabled: boolean; daemonStatus: string }>()).toMatchObject({
        enabled: false,
        daemonStatus: "stopped",
      });

      process.env.MAIL_SPAMD_ENABLED = "true";
      process.env.MAIL_SPAMD_HOST = "127.0.0.1";
      process.env.MAIL_SPAMD_THRESHOLD = "6.5";
      const on = await inject({ method: "GET", url: "/api/admin/mail/spam" });
      expect(on.statusCode).toBe(200);
      expect(
        on.body<{ enabled: boolean; threshold: number; spamd: { host: string } }>(),
      ).toMatchObject({
        enabled: true,
        threshold: 6.5,
        spamd: { enabled: true, host: "127.0.0.1" },
      });
    } finally {
      if (previous.enabled === undefined) delete process.env.MAIL_SPAMD_ENABLED;
      else process.env.MAIL_SPAMD_ENABLED = previous.enabled;
      if (previous.host === undefined) delete process.env.MAIL_SPAMD_HOST;
      else process.env.MAIL_SPAMD_HOST = previous.host;
      if (previous.threshold === undefined) delete process.env.MAIL_SPAMD_THRESHOLD;
      else process.env.MAIL_SPAMD_THRESHOLD = previous.threshold;
    }
  });

  it("forbids spam settings without admin console read", async () => {
    currentActor = unprivilegedActor;
    const response = await inject({ method: "GET", url: "/api/admin/mail/spam" });
    expect(response.statusCode).toBe(403);
  });
});

describe("buildMailSpamAdminSettings", () => {
  it("reports filtering off when MAIL_SPAMD_ENABLED is unset", () => {
    expect(buildMailSpamAdminSettings({}).enabled).toBe(false);
    expect(buildMailSpamAdminSettings({}).daemonStatus).toBe("stopped");
  });

  it("reports filtering on when spamd is configured", () => {
    const settings = buildMailSpamAdminSettings({
      MAIL_SPAMD_ENABLED: "true",
      MAIL_SPAMD_HOST: "spamd",
      MAIL_SPAMD_THRESHOLD: "5",
    });
    expect(settings.enabled).toBe(true);
    expect(settings.threshold).toBe(5);
    expect(settings.daemonStatus).toBe("unknown");
  });
});
