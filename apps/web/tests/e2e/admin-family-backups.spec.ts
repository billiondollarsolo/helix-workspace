import { expect, test } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend } from "./support/backend-mode";

test("enrolls an independently authorized worker and retains rejected capability drafts", async ({
  page,
}) => {
  test.skip(isLiveBackend(), "Worker enrollment uses a dedicated operator fixture.");
  const writes: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/api/admin/family-backups" && route.request().method() === "POST") {
      writes.push(route.request().postDataJSON());
      return route.fulfill({
        status: 409,
        json: { error: { message: "The worker does not match this installation." } },
      });
    }
    return route.fulfill({ json: { targets: [], jobs: [], applications: [] } });
  });
  await page.goto("/admin/family-backups");
  await page.getByRole("button", { name: "+ Add backup target", exact: true }).click();
  const form = page.getByRole("form", { name: "Connect backup worker" });
  await form.getByRole("button", { name: "Review and connect recovery" }).click();
  await expect(form.getByRole("alert")).toContainText("separate complete backup");
  expect(writes).toHaveLength(0);
  const backup = form.getByLabel("Backup management capability", { exact: true });
  await backup.fill("a".repeat(64));
  await form.getByLabel("Independent restore capability (optional)").fill("b".repeat(64));
  await form.getByRole("button", { name: "Review and connect recovery" }).click();
  await expect(form.getByRole("alert")).toContainText("does not match");
  await expect(backup).toHaveValue("a".repeat(64));
  expect(writes).toHaveLength(1);
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(
    async () =>
      (
        await (window as typeof window & { axe: typeof axe }).axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations,
  );
  expect(violations).toEqual([]);
});
