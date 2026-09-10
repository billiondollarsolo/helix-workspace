import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { buildMailHtmlDocument } from "../../src/features/mail/mail-html-body";

test("production CSP permits the isolated mail bridge and configured Jitsi origin", async ({
  page,
}) => {
  const edge = readFileSync("../../infra/caddy/Caddyfile.production", "utf8");
  const csp = /Content-Security-Policy "([^"]+)"/u
    .exec(edge)?.[1]
    ?.replaceAll("{$HELIX_JITSI_ORIGIN:https://meet.localhost}", "https://meet.example.test");
  expect(csp).toBeDefined();
  await page.route("https://helix.example.test/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      headers: { "Content-Security-Policy": csp ?? "default-src 'none'" },
      body: "<!doctype html><html><body></body></html>",
    });
  });
  await page.route("https://meet.example.test/**", async (route) => {
    await route.fulfill(
      route.request().url().endsWith(".js")
        ? {
            contentType: "text/javascript",
            body: "document.documentElement.dataset.jitsiLoaded = 'true'",
          }
        : {
            contentType: "text/html",
            body: "<p>Configured Jitsi frame</p>",
          },
    );
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
  await page.evaluate(
    (srcdoc) => {
      const iframe = document.createElement("iframe");
      iframe.title = "Email";
      iframe.sandbox.add("allow-scripts");
      iframe.srcdoc = srcdoc;
      document.body.appendChild(iframe);
    },
    buildMailHtmlDocument(
      '<h1>Email</h1><blockquote>Quoted text</blockquote><a data-helix-href="https://outside.example/">External link</a>',
      "csp-test",
    ),
  );
  expect((await height).text()).toContain('"channel":"csp-test"');
  const frame = page.frameLocator('iframe[title="Email"]');
  await expect(frame.getByRole("heading", { name: "Email" })).toBeVisible();
  await frame.getByText("Show quoted text").click();
  await expect(frame.getByText("Quoted text", { exact: true })).toBeVisible();
  const link = page.waitForEvent("console", {
    predicate: (message) => message.text().includes('"kind":"link"'),
  });
  await frame.getByText("External link").click();
  expect((await link).text()).toContain("https://outside.example/");

  await page.addScriptTag({ url: "https://meet.example.test/external_api.js" });
  await expect(page.locator("html")).toHaveAttribute("data-jitsi-loaded", "true");
  await page.evaluate(() => {
    const iframe = document.createElement("iframe");
    iframe.title = "Jitsi";
    iframe.src = "https://meet.example.test/room";
    document.body.appendChild(iframe);
  });
  await expect(
    page.frameLocator('iframe[title="Jitsi"]').getByText("Configured Jitsi frame"),
  ).toBeVisible();
});
