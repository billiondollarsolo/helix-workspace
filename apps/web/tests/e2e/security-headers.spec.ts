import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { installCoreAppsRoutes } from "./support/api-fixtures";

test("production CSP permits the isolated mail bridge and blocks third-party scripts", async ({
  page,
}) => {
  // Load the renderer through Vite so its inline stylesheet uses the same module
  // pipeline as the app, rather than importing browser assets in the test runner.
  await installCoreAppsRoutes(page);
  await page.goto("/passwords");
  await expect(page.getByRole("heading", { name: "Passwords", exact: true })).toBeVisible();
  const mailDocument = await page.evaluate(async () => {
    const modulePath = "/src/features/mail/mail-html-body.tsx";
    const { buildMailHtmlDocument } = await import(modulePath);
    return buildMailHtmlDocument(
      '<h1>Email</h1><blockquote>Quoted text</blockquote><a data-helix-href="https://outside.example/">External link</a>',
      "csp-test",
    );
  });
  const edge = readFileSync("../../infra/caddy/Caddyfile.production", "utf8");
  const csp = /Content-Security-Policy "([^"]+)"/u.exec(edge)?.[1];
  expect(csp).toBeDefined();
  // Meet runs in the app itself; LiveKit signalling is a same-host websocket.
  expect(csp).toMatch(/frame-src 'self'(?:;|$)/u);
  expect(csp).toContain("connect-src 'self' wss:");
  expect(edge).toContain("camera=(self), microphone=(self), display-capture=(self)");
  await page.route("https://helix.example.test/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      headers: { "Content-Security-Policy": csp ?? "default-src 'none'" },
      body: "<!doctype html><html><body></body></html>",
    });
  });
  await page.route("https://cdn.example.test/**", async (route) => {
    await route.fulfill({
      contentType: "text/javascript",
      body: "document.documentElement.dataset.thirdPartyLoaded = 'true'",
    });
  });
  await page.addInitScript(() => {
    window.addEventListener("message", (event) => {
      console.info("mail-bridge", JSON.stringify(event.data));
    });
  });
  await page.goto("https://helix.example.test/");
  const height = page.waitForEvent("console", {
    predicate: (message) => message.text().includes('"kind":"height"'),
  });
  await page.evaluate((srcdoc) => {
    const iframe = document.createElement("iframe");
    iframe.title = "Email";
    iframe.sandbox.add("allow-scripts");
    iframe.srcdoc = srcdoc;
    document.body.appendChild(iframe);
  }, mailDocument);
  expect((await height).text()).toContain('"channel":"csp-test"');
  const frame = page.frameLocator('iframe[title="Email"]');
  await expect(frame.getByRole("heading", { name: "Email" })).toBeVisible();
  await frame.getByLabel("Show quoted text").click();
  await expect(frame.getByText("Quoted text", { exact: true })).toBeVisible();
  const link = page.waitForEvent("console", {
    predicate: (message) => message.text().includes('"kind":"link"'),
  });
  await frame.getByText("External link").click();
  expect((await link).text()).toContain("https://outside.example/");

  await expect(
    page.addScriptTag({ url: "https://cdn.example.test/external_api.js" }),
  ).rejects.toThrow();
  await expect(page.locator("html")).not.toHaveAttribute("data-third-party-loaded", "true");
});
