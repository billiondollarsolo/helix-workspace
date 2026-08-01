import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { registerMailDeliveryAdminRoutes } from "./admin-routes.js";
import {
  InMemoryMailDkimKeyStore,
  InMemoryMailDmarcReportStore,
  InMemoryMailRoutingRuleStore,
  InMemoryOutboundProviderStore,
  InMemorySendingDomainStore,
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

  it("rejects an invalid DMARC XML payload with 400", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/admin/mail/dmarc/reports",
      payload: { report: "<not-a-feedback/>" },
    });
    expect(response.statusCode).toBe(400);
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
});
