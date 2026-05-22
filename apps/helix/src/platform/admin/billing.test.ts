import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/actor.js";
import {
  InMemoryBillingStore,
  buildBillingAccountView,
  meterFraction,
  registerAdminBillingRoutes,
  type BillingAccountRecord,
  type InvoiceRecord,
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
    expect(view.meters.map((meter) => meter.id)).toEqual([
      "licenses",
      "storage",
      "ai_credits",
    ]);
    expect(view.meters[0]?.fraction).toBeCloseTo(118 / 124);
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
    expect((field(response, "meters") as unknown[])).toHaveLength(3);
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
    store.addInvoice(invoice("INV-1", "2026-03-01T00:00:00.000Z", "33333333-3333-4333-8333-333333333333"));
    store.addInvoice(invoice("INV-2", "2026-04-01T00:00:00.000Z", "44444444-4444-4444-8444-444444444444"));
    store.addInvoice(invoice("INV-3", "2026-05-01T00:00:00.000Z", "55555555-5555-4555-8555-555555555555"));
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
    const cursor = (field(first, "nextCursor") as string);
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
