import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/actor.js";
import {
  InMemoryBillingStore,
  buildBillingAccountView,
  buildBillingUsageSummary,
  meterFraction,
  registerAdminBillingRoutes,
  type BillingAccountRecord,
  type InvoiceRecord,
  type UsageRollupRecord,
} from "./billing.js";

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

function account(overrides: Partial<BillingAccountRecord> = {}): BillingAccountRecord {
  return {
    orgId,
    planName: "Business Plus",
    pricePerSeatCents: 2800,
    billingCycle: "annual",
    currency: "USD",
    licensesTotal: 124,
    licensesUsed: 118,
    storageUsedBytes: 2_400_000_000_000,
    storageLimitBytes: 5_000_000_000_000,
    aiCreditsUsed: 184_000,
    aiCreditsLimit: 250_000,
    nextInvoiceCents: 4_166_400,
    nextInvoiceAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function invoice(number: string, issuedAt: string, id: string): InvoiceRecord {
  return {
    id,
    orgId,
    invoiceNumber: number,
    amountCents: 4_144_000,
    currency: "USD",
    status: "paid",
    periodStart: issuedAt,
    periodEnd: issuedAt,
    issuedAt,
    createdAt: issuedAt,
  };
}

function usageRollup(overrides: Partial<UsageRollupRecord> = {}): UsageRollupRecord {
  return {
    orgId,
    periodStart: "2026-05-23",
    periodEnd: "2026-05-24",
    metricKey: "ai_tokens",
    quantity: 42,
    computedAt: "2026-05-24T00:05:00.000Z",
    ...overrides,
  };
}

async function buildApp(store: InMemoryBillingStore) {
  const app = fastify();
  await registerAdminBillingRoutes(app, { store, actorFromRequest });
  return app;
}

describe("billing usage meters", () => {
  it("computes a clamped fill fraction", () => {
    expect(meterFraction(50, 100)).toBe(0.5);
    expect(meterFraction(200, 100)).toBe(1);
    expect(meterFraction(10, 0)).toBe(0);
  });

  it("builds an account view with three meters", () => {
    const view = buildBillingAccountView(account());
    expect(view.meters.map((meter) => meter.id)).toEqual(["licenses", "storage", "ai_credits"]);
    expect(view.meters[0]?.fraction).toBeCloseTo(118 / 124);
  });
});

describe("billing usage summary", () => {
  it("sums additive metrics, averages storage, and takes max seats", () => {
    const summary = buildBillingUsageSummary([
      usageRollup({ periodStart: "2026-05-01", periodEnd: "2026-05-02", quantity: 100 }),
      usageRollup({ periodStart: "2026-05-02", periodEnd: "2026-05-03", quantity: 50 }),
      usageRollup({
        periodStart: "2026-05-01",
        periodEnd: "2026-05-02",
        metricKey: "storage_avg_bytes",
        quantity: 2000,
      }),
      usageRollup({
        periodStart: "2026-05-02",
        periodEnd: "2026-05-03",
        metricKey: "storage_avg_bytes",
        quantity: 4000,
      }),
      usageRollup({
        periodStart: "2026-05-01",
        periodEnd: "2026-05-02",
        metricKey: "seats_max",
        quantity: 12,
      }),
      usageRollup({
        periodStart: "2026-05-02",
        periodEnd: "2026-05-03",
        metricKey: "seats_max",
        quantity: 9,
      }),
    ]);

    expect(summary).toEqual({
      periodStart: "2026-05-01",
      periodEnd: "2026-05-03",
      metrics: [
        { metricKey: "ai_tokens", quantity: 150, aggregation: "sum", sampleCount: 2 },
        {
          metricKey: "seats_max",
          quantity: 12,
          aggregation: "max",
          sampleCount: 2,
        },
        {
          metricKey: "storage_avg_bytes",
          quantity: 3000,
          aggregation: "average",
          sampleCount: 2,
        },
      ],
    });
  });
});

describe("admin billing routes", () => {
  it("returns the account with usage meters", async () => {
    const store = new InMemoryBillingStore();
    store.setAccount(account());
    const app = await buildApp(store);

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/billing/account",
      headers: headers("admin.console.read"),
    });
    expect(response.statusCode).toBe(200);
    expect((field(response, "account") as { planName: string }).planName).toBe("Business Plus");
    expect(field(response, "meters") as unknown[]).toHaveLength(3);
  });

  it("404s when no account is provisioned", async () => {
    const app = await buildApp(new InMemoryBillingStore());
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/billing/account",
      headers: headers("admin.console.read"),
    });
    expect(response.statusCode).toBe(404);
    expect(body(response).code).toBe("not_found");
  });

  it("lists invoices newest-first with cursor pagination", async () => {
    const store = new InMemoryBillingStore();
    store.addInvoice(
      invoice("INV-1", "2026-03-01T00:00:00.000Z", "33333333-3333-4333-8333-333333333333"),
    );
    store.addInvoice(
      invoice("INV-2", "2026-04-01T00:00:00.000Z", "44444444-4444-4444-8444-444444444444"),
    );
    store.addInvoice(
      invoice("INV-3", "2026-05-01T00:00:00.000Z", "55555555-5555-4555-8555-555555555555"),
    );
    const app = await buildApp(store);

    const first = await app.inject({
      method: "GET",
      url: "/api/admin/billing/invoices?limit=2",
      headers: headers("admin.console.read"),
    });
    expect((field(first, "invoices") as InvoiceRecord[]).map((inv) => inv.invoiceNumber)).toEqual([
      "INV-3",
      "INV-2",
    ]);
    const cursor = field(first, "nextCursor") as string;
    expect(cursor).not.toBeNull();

    const second = await app.inject({
      method: "GET",
      url: `/api/admin/billing/invoices?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: headers("admin.console.read"),
    });
    expect((field(second, "invoices") as InvoiceRecord[]).map((inv) => inv.invoiceNumber)).toEqual([
      "INV-1",
    ]);
    expect(body(second).nextCursor).toBeNull();
  });

  it("lists usage rollups with date and metric filters", async () => {
    const store = new InMemoryBillingStore();
    store.addUsageRollup(usageRollup());
    store.addUsageRollup(
      usageRollup({
        periodStart: "2026-05-22",
        periodEnd: "2026-05-23",
        metricKey: "storage_avg_bytes",
        quantity: 2048,
      }),
    );
    const app = await buildApp(store);

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/billing/usage?from=2026-05-23&to=2026-05-24&metricKey=ai_tokens",
      headers: headers("admin.console.read"),
    });

    expect(response.statusCode).toBe(200);
    expect(field(response, "rollups") as UsageRollupRecord[]).toEqual([usageRollup()]);
    expect(body(response).summary).toMatchObject({
      metrics: [{ metricKey: "ai_tokens", quantity: 42, aggregation: "sum", sampleCount: 1 }],
    });
  });

  it("accepts billing-grade storage average and seat max usage filters", async () => {
    const store = new InMemoryBillingStore();
    store.addUsageRollup(
      usageRollup({
        metricKey: "storage_avg_bytes",
        quantity: 2048,
      }),
    );
    store.addUsageRollup(
      usageRollup({
        metricKey: "seats_max",
        quantity: 12,
      }),
    );
    const app = await buildApp(store);

    const storage = await app.inject({
      method: "GET",
      url: "/api/admin/billing/usage?metricKey=storage_avg_bytes",
      headers: headers("admin.console.read"),
    });
    const seats = await app.inject({
      method: "GET",
      url: "/api/admin/billing/usage?metricKey=seats_max",
      headers: headers("admin.console.read"),
    });

    expect(storage.statusCode).toBe(200);
    expect((field(storage, "rollups") as UsageRollupRecord[])[0]?.metricKey).toBe(
      "storage_avg_bytes",
    );
    expect(seats.statusCode).toBe(200);
    expect((field(seats, "rollups") as UsageRollupRecord[])[0]?.metricKey).toBe("seats_max");
  });

  it("rejects invalid usage date ranges", async () => {
    const app = await buildApp(new InMemoryBillingStore());
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/billing/usage?from=2026-05-24&to=2026-05-23",
      headers: headers("admin.console.read"),
    });

    expect(response.statusCode).toBe(400);
    expect(body(response).code).toBe("invalid_request");
  });

  it("rejects unknown usage rollup metric keys", async () => {
    const app = await buildApp(new InMemoryBillingStore());
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/billing/usage?metricKey=custom_metric",
      headers: headers("admin.console.read"),
    });

    expect(response.statusCode).toBe(400);
    expect(body(response).code).toBe("invalid_request");
  });

  it("requires a read scope", async () => {
    const app = await buildApp(new InMemoryBillingStore());
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/billing/account",
      headers: headers("drive.read"),
    });
    expect(response.statusCode).toBe(403);
  });
});
