import axe from "axe-core";
import { expect, test } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

for (const width of [390, 768, 1440]) {
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
        await page.screenshot({ path: test.info().outputPath("provider-panel.png") });
      });
    }
  }
}
