import axe from "axe-core";
import { expect, test, type Page } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

/* Admin → Mail → Spam filtering: the AI decision model card in a real browser
   against mocked admin routes shaped like the backend's
   (apps/helix/src/platform/mail/decision/admin-routes.ts). */

const accountId = "0123456789abcdef0123456789abcdef";

function view(overrides: Record<string, unknown> = {}) {
  return {
    mode: "off",
    provider: "cloudflare",
    model: "clef-flash",
    defaultModel: "clef-flash",
    baseUrl: null,
    cloudflareAccountId: null,
    spamThreshold: 0.9,
    phishingThreshold: 0.8,
    categoryThreshold: 0.75,
    applyCategories: false,
    dailyMessageCap: 5000,
    inputPricePerMillionTokensUsd: null,
    credentialConfigured: false,
    credentialUpdatedAt: null,
    providerLabel: "Cloudflare Workers AI",
    endpointHost: "api.cloudflare.com",
    notice:
      "Message content is sent to Cloudflare Workers AI for classification. Mail labelled confidential or restricted is never sent.",
    ...overrides,
  };
}

const emptyConfusion = {
  labelled: 0,
  truePositives: 0,
  falsePositives: 0,
  trueNegatives: 0,
  falseNegatives: 0,
  precision: null,
  recall: null,
  falsePositiveRate: null,
};

function report() {
  return {
    window: { days: 30, since: "2026-09-12T00:00:00.000Z", until: "2026-10-12T00:00:00.000Z" },
    totals: { recorded: 0, decided: 0, skipped: 0, error: 0 },
    outcomes: [],
    verdicts: { legitimate: 0, spam: 0, phishing: 0, scam: 0 },
    proposedActions: { none: 0, spam: 0, phishing: 0, category: 0 },
    actionsTaken: { none: 0, spam: 0, phishing: 0, category: 0 },
    spamAssassin: { compared: 0, agree: 0, agreementRate: null, modelOnly: 0, spamAssassinOnly: 0 },
    feedback: { model: emptyConfusion, spamAssassin: emptyConfusion },
    latency: { averageMs: null, p95Ms: null },
    tokens: { input: 0, output: 0, averageInputPerMessage: null },
    cost: { estimatedUsd: 0, priced: true },
    disagreements: [],
  };
}

async function openSpamFiltering(page: Page): Promise<{ puts: unknown[]; tests: unknown[] }> {
  const puts: unknown[] = [];
  const tests: unknown[] = [];
  let current = view();
  await page.addInitScript(() => {
    window.localStorage.setItem("helix.accessToken", "e2e-admin-token");
  });
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const reply = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/v1/api/admin/mail/spam") {
      await reply({
        enabled: true,
        threshold: 5,
        rejectThreshold: null,
        daemonStatus: "running",
        rulesetVersion: null,
        taggedLast24h: 3,
        betaSecondPass: { enabled: false, model: null },
        decisionModel: {
          mode: current.mode,
          provider: current.provider,
          model: current.model,
          credentialConfigured: current.credentialConfigured,
        },
      });
      return;
    }
    if (pathname === "/v1/api/admin/mail/decision-model/report") {
      await reply({
        report: report(),
        decisionModel: { mode: current.mode, provider: current.provider, model: current.model },
      });
      return;
    }
    if (pathname === "/v1/api/admin/mail/decision-model/test") {
      tests.push(request.postDataJSON());
      await reply({
        test: {
          ok: true,
          latencyMs: 318,
          model: "clef-flash",
          answer: "legitimate",
          confidence: 0.97,
          provider: "cloudflare",
        },
      });
      return;
    }
    if (pathname === "/v1/api/admin/mail/decision-model") {
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as { settings: Record<string, unknown> };
        puts.push(body);
        current = view({
          ...body.settings,
          credentialConfigured: true,
          credentialUpdatedAt: "2026-10-12T09:00:00.000Z",
        });
      }
      await reply({ decisionModel: current });
      return;
    }
    await reply({});
  });
  await page.goto("/admin/mail?tab=spam");
  await expect(page.getByRole("heading", { name: "AI decision model", exact: true })).toBeVisible();
  return { puts, tests };
}

test.describe("/admin/mail?tab=spam — AI decision model", () => {
  test("configures shadow mode with a write-only token after a connection test", async ({
    page,
  }) => {
    const backend = await openSpamFiltering(page);

    await page.getByLabel("Cloudflare account ID").fill(accountId);
    await page.getByLabel("Cloudflare API token").fill("cf-e2e-token-123");
    await expect(page.getByText("Message content is sent to")).toHaveCount(0);
    await page.getByRole("radio", { name: /Shadow — record only/ }).check();
    await expect(
      page.getByText("Message content is sent to Cloudflare Workers AI for classification."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByRole("status").filter({ hasText: "318 ms" })).toBeVisible();
    expect(backend.tests[0]).toMatchObject({ apiKey: "cf-e2e-token-123" });

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved. The AI decision model is shadow." }),
    ).toBeVisible();
    expect(backend.puts[0]).toEqual({
      settings: {
        mode: "shadow",
        provider: "cloudflare",
        model: "clef-flash",
        cloudflareAccountId: accountId,
        spamThreshold: 0.9,
        phishingThreshold: 0.8,
        categoryThreshold: 0.75,
        applyCategories: false,
        dailyMessageCap: 5000,
      },
      apiKey: "cf-e2e-token-123",
    });
    // Write-only: once stored, the key field is replaced by Replace / Remove.
    await expect(page.getByRole("button", { name: "Replace" })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });

  test("has no axe violations", async ({ page }) => {
    await openSpamFiltering(page);
    await page.getByRole("radio", { name: /Enforce/ }).check();
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => {
      const browser = window as typeof window & { axe: typeof axe };
      const result = await browser.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      });
      return result.violations.map((violation) => violation.id);
    });
    expect(violations).toEqual([]);
  });
});
