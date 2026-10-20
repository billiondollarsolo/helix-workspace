import axe from "axe-core";
import { expect, test, type Page } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

async function expectContainedFields(page: Page) {
  const overflow = await page.locator(".admin-field").evaluateAll((fields) =>
    fields.flatMap((field) => {
      const bounds = field.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return [];
      return [...field.querySelectorAll("input, select, textarea")].flatMap((control) => {
        const box = control.getBoundingClientRect();
        return box.left < bounds.left - 1 || box.right > bounds.right + 1
          ? [field.textContent?.trim().slice(0, 120)]
          : [];
      });
    }),
  );
  expect(overflow).toEqual([]);
}

for (const width of [320, 390, 768, 1440]) {
  for (const theme of ["light", "dark"]) {
    for (const app of ["assistant", "mail"]) {
      test(`${app} provider list and panel are accessible at ${width}px ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((theme) => {
          localStorage.setItem("helix.accessToken", "e2e-admin");
          localStorage.setItem("helix-appearance", JSON.stringify({ theme }));
        }, theme);
        await page.route("**/api/**", async (route) => {
          if (await fulfillCoreAppsRoute(route)) return;
          const path = new URL(route.request().url()).pathname;
          if (path.endsWith("/platform-config")) {
            await route.fulfill({
              json: {
                config: {
                  security: { tier: "business" },
                  ai: {
                    providers: [
                      {
                        id: "chat",
                        plugin: "openai-compat",
                        config: {
                          displayName: "Chat provider",
                          baseUrl: "https://llm.example/v1",
                          defaultModel: "model",
                          models: ["model"],
                          apiKeyConfigured: true,
                        },
                      },
                    ],
                  },
                },
                readiness: { ready: true, requirements: [] },
              },
            });
          } else if (path.endsWith("/mail/providers")) {
            await route.fulfill({
              json: {
                providers: [
                  {
                    id: "ses",
                    orgId: "00000000-0000-0000-0000-000000000000",
                    name: "SES relay",
                    kind: "ses",
                    enabled: true,
                    isDefault: true,
                    config: {
                      host: "email-smtp.us-east-2.amazonaws.com",
                      port: 587,
                      secure: false,
                    },
                    secretRef: "smtp-secret",
                    webhookSecretRef: null,
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                  },
                ],
              },
            });
          } else await route.fulfill({ json: {} });
        });
        await page.goto(`/admin/${app}?tab=${app === "mail" ? "providers" : "models"}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(
          page.getByRole("table", {
            name: app === "mail" ? "Outbound providers" : "AI providers",
            exact: true,
          }),
        ).toBeVisible();
        await page
          .getByRole("button", {
            name: app === "mail" ? "Edit SES relay" : "Edit provider chat",
            exact: true,
          })
          .click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.addScriptTag({ content: axe.source });
        const result = await page.evaluate(async () => ({
          violations: (
            await (window as typeof window & { axe: typeof axe }).axe.run(document, {
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
            })
          ).violations.map((item) => item.id),
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
        }));
        expect(result).toEqual({ violations: [], overflow: false });
        await expectContainedFields(page);
        if (app === "mail") {
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
          await page.getByRole("button", { name: "Add provider", exact: true }).click();
          for (const kind of [
            "ses",
            "smtp",
            "cloudflare",
            "resend",
            "sendgrid",
            "mailgun",
            "postmark",
          ]) {
            await page.getByLabel("Provider kind", { exact: true }).selectOption(kind);
            await expectContainedFields(page);
          }
        }
        await page.screenshot({ path: test.info().outputPath("provider-panel.png") });
      });
    }
    test(`long mail domains and DKIM selectors fit at ${width}px ${theme}`, async ({ page }) => {
      const domain = `${"a".repeat(63)}.${"b".repeat(63)}.example.test`;
      const selector = "s".repeat(63);
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((theme) => {
        localStorage.setItem("helix.accessToken", "e2e-admin");
        localStorage.setItem("helix-appearance", JSON.stringify({ theme }));
      }, theme);
      await page.route("**/api/**", async (route) => {
        if (await fulfillCoreAppsRoute(route)) return;
        return route.fulfill({
          json: new URL(route.request().url()).pathname.endsWith("/mail/domains")
            ? {
                domains: [
                  {
                    id: "long",
                    domain,
                    status: "verified",
                    isPrimary: true,
                    mailEnabled: true,
                    providerId: null,
                    dkimKeys: [{ id: "key", selector, status: "active" }],
                  },
                ],
              }
            : {},
        });
      });
      await page.goto("/admin/mail?tab=domains");
      const domainText = page.getByText(domain, { exact: true });
      const selectorText = page.getByText(selector, { exact: true });
      await expect(domainText).toBeVisible();
      await expect(selectorText).toBeVisible();
      for (const item of [domainText, selectorText]) {
        expect(
          await item.evaluate((element) => {
            const panel = element.closest(".panel")?.getBoundingClientRect();
            if (!panel) return false;
            const box = element.getBoundingClientRect();
            return (
              box.left >= panel.left &&
              box.right <= panel.right &&
              element.scrollWidth <= element.clientWidth + 1
            );
          }),
        ).toBe(true);
      }
      const keyRow = selectorText.locator("..");
      const selectorBounds = await selectorText.boundingBox();
      const statusBounds = await keyRow.getByText("active", { exact: true }).boundingBox();
      if (!selectorBounds || !statusBounds) throw new Error("Missing DKIM row bounds");
      expect(selectorBounds.x + selectorBounds.width).toBeLessThanOrEqual(statusBounds.x);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await page.screenshot({ path: test.info().outputPath("long-mail-domain.png") });
    });
    test(`mail routing, reports and operations fit at ${width}px ${theme}`, async ({ page }) => {
      const long = "a".repeat(63);
      const address = `${long}@${long}.example.test`;
      const timestamp = "2026-10-20T12:00:00Z";
      const responses: Record<string, unknown> = {
        config: {
          generatedAt: timestamp,
          inboundReceiver: {
            enabled: true,
            status: "ready",
            host: "0.0.0.0",
            port: 2525,
            orgId: "00000000-0000-0000-0000-000000000000",
            evidence: "Receiver enabled.",
          },
          outboundRelay: {
            configured: true,
            status: "configured",
            provider: "smtp",
            host: `${long}.${long}.example.test`,
            port: 587,
            secure: false,
            authConfigured: true,
            evidence: "Deployment-managed system mail. Inbox delivery is unverified.",
          },
          domains: [
            {
              domain: `${long}.test`,
              defaultFrom: true,
              records: [
                {
                  type: "DKIM",
                  status: "unknown",
                  expected: `v=DKIM1; p=${long.repeat(6)}`,
                  evidence: "Publish the signing key.",
                },
              ],
            },
          ],
          quotas: { maxMessageBytes: null, evidence: "Managed in Limits." },
          deliveryHealth: {
            since: timestamp,
            counts: {
              queued: 0,
              cancelled: 0,
              sending: 0,
              accepted: 0,
              delivered: 0,
              deferred: 0,
              bounced: 0,
              complained: 0,
              failed: 0,
            },
            failedLast24h: 0,
            lastFailureAt: null,
            lastError: null,
          },
        },
        check: {
          message:
            "System relay connection verified. No email was sent; inbox delivery is unverified.",
        },
        "routing-rules": {
          rules: [
            {
              id: "r1",
              name: "Forward",
              isEnabled: true,
              priority: 100,
              match: { recipientPattern: `*@${long}.example.test` },
              actionKind: "forward",
              action: { forwardTo: address },
            },
          ],
        },
        dmarc: {
          summary: {
            dmarcPassRate: 0.98,
            spfPassRate: 0.99,
            dkimPassRate: 0.99,
            messagesEvaluated: 1000000,
            windowDays: 30,
          },
          reports: [
            {
              id: "d1",
              reporter: `${long}.example.test`,
              domain: `${long}.test`,
              rangeStart: timestamp,
              rangeEnd: timestamp,
              total: 1000000,
              passCount: 980000,
              failCount: 20000,
            },
          ],
        },
        "dead-letters": {
          messages: [
            {
              id: "o1",
              actorId: "a1",
              messageId: long.repeat(3),
              attemptCount: 4,
              lastError: long.repeat(3),
              deadLetteredAt: timestamp,
            },
          ],
        },
        "delivery-events": {
          events: [
            {
              id: "e1",
              outboundId: "o1",
              kind: "bounced",
              recipient: address,
              diagnostic: long.repeat(3),
              occurredAt: timestamp,
            },
          ],
        },
        suppressions: {
          suppressions: [{ id: "s1", address, reason: "hard_bounce", createdAt: timestamp }],
        },
        journal: {
          journal: {
            enabled: false,
            retentionDays: 365,
            entryCount: 1000,
            lastJournaledAt: timestamp,
            updatedAt: timestamp,
          },
        },
      };
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((theme) => {
        localStorage.setItem("helix.accessToken", "e2e-admin");
        localStorage.setItem("helix-appearance", JSON.stringify({ theme }));
      }, theme);
      await page.route("**/api/**", async (route) => {
        if (await fulfillCoreAppsRoute(route)) return;
        const name = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
        return route.fulfill({ json: responses[name] ?? {} });
      });
      for (const tab of ["general", "routing", "deliverability", "operations"]) {
        await page.goto(`/admin/mail?tab=${tab}`);
        if (tab === "general") {
          await page.getByText("System mail and delivery status", { exact: true }).click();
          await expect(
            page.getByRole("heading", { name: "System mail relay", exact: true }),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Check system mail connection", exact: true })
            .click();
          await expect(
            page.getByRole("status").filter({ hasText: "System relay connection verified." }),
          ).toBeVisible();
        } else if (tab === "routing") {
          await expect(page.getByRole("table", { name: "Inbound routing rules" })).toContainText(
            address,
          );
          await page.getByRole("button", { name: "Add rule", exact: true }).click();
          await page.getByLabel("Routing action").selectOption("alias");
          await expectContainedFields(page);
          await page.getByLabel("Routing action").selectOption("forward");
          await expectContainedFields(page);
        } else if (tab === "deliverability") {
          await expect(page.getByRole("table", { name: "DMARC reports" })).toContainText(long);
        } else {
          await expect(
            page.getByRole("switch", { name: "Immutable compliance journal", exact: true }),
          ).toBeVisible();
          await expect(page.getByRole("button", { name: "Replay", exact: true })).toBeVisible();
        }
        expect(
          await page
            .locator(".panel")
            .evaluateAll((panels) =>
              panels
                .filter(
                  (panel) =>
                    panel.getBoundingClientRect().width &&
                    panel.scrollWidth > panel.clientWidth + 1,
                )
                .map((panel) => panel.textContent?.slice(0, 100)),
            ),
        ).toEqual([]);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        ).toBe(false);
        await page.addScriptTag({ content: axe.source });
        expect(
          await page.evaluate(async () =>
            (
              await (window as typeof window & { axe: typeof axe }).axe.run(document, {
                runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
              })
            ).violations.map((item) => item.id),
          ),
        ).toEqual([]);
        await page.screenshot({ path: test.info().outputPath(`${tab}.png`) });
      }
    });
  }
}
