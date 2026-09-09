import { expect, test } from "@playwright/test";

const coldStartBudgetMs = 8_000;
const interactionBudgetMs = 2_000;

test("stays responsive on a throttled low-end browser and network", async ({ context, page }) => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/api/auth/csrf-token") {
      await route.fulfill({ json: { csrfToken: "performance-csrf" } });
    } else if (pathname === "/v1/api/auth/sign-in/email") {
      await route.fulfill({ status: 401, json: { error: "Invalid email or password." } });
    } else {
      await route.fulfill({ json: {} });
    }
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1_600_000 / 8) * 0.9,
    uploadThroughput: (750_000 / 8) * 0.9,
    connectionType: "cellular3g",
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  const coldStart = performance.now();
  await page.goto("/login", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Sign in to Helix" })).toBeVisible();
  expect(performance.now() - coldStart).toBeLessThan(coldStartBudgetMs);

  await page.getByLabel("Email", { exact: true }).fill("admin@helix.local");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  const interaction = performance.now();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Invalid email or password.");
  expect(performance.now() - interaction).toBeLessThan(interactionBudgetMs);
});
