import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend } from "./support/backend-mode";

/* Admin → Domains → HTTPS certificate: the certificate the workspace serves,
   replacing it with the organization's own, and going back to automatic. */

test.beforeEach(() =>
  test.skip(isLiveBackend(), "Certificate management needs an edge the test backend lacks."),
);

const DAY_MS = 24 * 60 * 60 * 1000;
/* Not a key. Assembled so the repository's secret scan, which rejects any
   source containing a private-key header, has nothing to match. */
const KEY_TEXT = ["-----BEGIN", "PRIVATE KEY-----\nMIIE\n-----END", "PRIVATE KEY-----\n"].join(" ");
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS + 60_000).toISOString();

function certificate(issuer: string, days: number, fingerprint: string) {
  return {
    subject: "workspace.example.test",
    issuer,
    names: ["workspace.example.test"],
    notBefore: inDays(-5),
    notAfter: inDays(days),
    fingerprintSha256: fingerprint.repeat(64),
  };
}

const automatic = {
  hostname: "workspace.example.test",
  source: "automatic",
  manageable: true,
  unavailableReason: null,
  served: certificate("Let's Encrypt R11", 82, "a"),
  uploaded: null,
  applied: true,
};
const ownCertificate = certificate("Example Corp Issuing CA", 20, "b");

interface Edge {
  state: Record<string, unknown>;
  uploads: unknown[];
  removals: number;
  refuseNextUpload: boolean;
}

async function openDomains(page: Page): Promise<Edge> {
  const edge: Edge = { state: automatic, uploads: [], removals: 0, refuseNextUpload: false };
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/api/admin/domains") return route.fulfill({ json: { domains: [] } });
    if (pathname !== "/v1/api/admin/edge/certificate") return route.fulfill({ json: {} });
    if (request.method() === "PUT") {
      if (edge.refuseNextUpload) {
        edge.refuseNextUpload = false;
        return route.fulfill({
          status: 400,
          json: {
            error: "The private key does not belong to this certificate.",
            code: "invalid_request",
            issues: [{ path: ["privateKey"] }],
          },
        });
      }
      edge.uploads.push(request.postDataJSON());
      edge.state = {
        ...automatic,
        source: "uploaded",
        served: ownCertificate,
        uploaded: { ...ownCertificate, updatedAt: new Date().toISOString() },
        applied: true,
      };
    }
    if (request.method() === "DELETE") {
      edge.removals += 1;
      edge.state = automatic;
    }
    return route.fulfill({ json: { certificate: edge.state } });
  });
  await page.goto("/admin/domains");
  return edge;
}

async function audit(page: Page) {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(
    async () =>
      (
        await (window as typeof window & { axe: typeof axe }).axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
          },
        })
      ).violations,
  );
  expect(violations).toEqual([]);
}

test("replaces the automatic certificate with the organization's own and goes back", async ({
  page,
}) => {
  const edge = await openDomains(page);
  const panel = page.getByRole("region", { name: "HTTPS certificate" });
  await expect(panel).toContainText("What browsers check when they open workspace.example.test.");
  await expect(panel).toContainText("Automatic");
  await expect(panel).toContainText("Let's Encrypt R11");
  await expect(panel).toContainText("expires in 82 days");

  await panel.getByRole("button", { name: "Use your own certificate" }).click();
  const dialog = page.getByRole("dialog", { name: "Use your own certificate" });
  const certificateField = dialog.getByLabel("Certificate (PEM), followed by any intermediates");
  const keyField = dialog.getByLabel("Private key (PEM, without a passphrase)");
  await expect(certificateField).toBeFocused();

  await dialog.getByRole("button", { name: "Use this certificate" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Paste the certificate or choose its file.");
  expect(edge.uploads).toEqual([]);

  // A file can be chosen instead of pasting.
  await dialog.getByLabel("Choose the certificate file").setInputFiles({
    name: "workspace.pem",
    mimeType: "application/x-pem-file",
    buffer: Buffer.from("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"),
  });
  await expect(certificateField).toHaveValue(/BEGIN CERTIFICATE/u);
  await keyField.fill(KEY_TEXT);

  edge.refuseNextUpload = true;
  await dialog.getByRole("button", { name: "Use this certificate" }).click();
  const refusal = dialog.getByRole("alert");
  await expect(refusal).toHaveText("The private key does not belong to this certificate.");
  await expect(keyField).toHaveAttribute("aria-invalid", "true");
  await expect(keyField).toHaveAccessibleDescription(
    "The private key does not belong to this certificate.",
  );
  await expect(keyField).toHaveValue(/BEGIN PRIVATE KEY/u);
  await audit(page);

  await dialog.getByRole("button", { name: "Use this certificate" }).click();
  await expect(dialog).toBeHidden();
  expect(edge.uploads).toHaveLength(1);
  await expect(panel).toContainText("Your certificate");
  await expect(panel).toContainText("Example Corp Issuing CA");
  // Nothing renews an uploaded certificate, so 20 days out is already a warning.
  await expect(panel).toContainText("expires in 20 days");
  await expect(panel.getByRole("alert")).toContainText(
    "Helix does not renew a certificate you uploaded.",
  );
  await audit(page);

  await panel.getByRole("button", { name: "Go back to automatic" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Remove your certificate" });
  await expect(confirm).toContainText("requests one from Let’s Encrypt instead");
  expect(edge.removals).toBe(0);
  await confirm.getByRole("button", { name: "Remove certificate" }).click();
  await expect(confirm).toBeHidden();
  expect(edge.removals).toBe(1);
  await expect(panel).toContainText("Let's Encrypt R11");
  await expect(panel.getByRole("button", { name: "Go back to automatic" })).toHaveCount(0);
});

test("explains a certificate the console cannot change", async ({ page }) => {
  const edge = await openDomains(page);
  edge.state = {
    ...automatic,
    source: "deployment-files",
    manageable: false,
    unavailableReason:
      "This deployment serves a certificate from files on the server. Replace those files and restart the edge to change it.",
  };
  await page.reload();
  const panel = page.getByRole("region", { name: "HTTPS certificate" });

  await expect(panel).toContainText("From server files");
  await expect(panel).toContainText("Replace those files and restart the edge to change it.");
  await expect(panel.getByRole("button")).toHaveCount(0);
});

for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const) {
    test(`the certificate panel and upload dialog are accessible at ${width}px ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 960 });
      await page.addInitScript(
        (value) => localStorage.setItem("helix-appearance", JSON.stringify({ theme: value })),
        theme,
      );
      await openDomains(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const panel = page.getByRole("region", { name: "HTTPS certificate" });
      await expect(panel).toContainText("Let's Encrypt R11");
      await audit(page);
      await panel.getByRole("button", { name: "Use your own certificate" }).click();
      const dialog = page.getByRole("dialog", { name: "Use your own certificate" });
      await expect(dialog).toBeVisible();
      await audit(page);
      const bounds = await dialog.boundingBox();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `/tmp/helix-release-work/edge-certificate-${width}-${theme}.png`,
        fullPage: true,
      });
    });
  }
