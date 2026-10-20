import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend } from "./support/backend-mode";

const app = {
  id: "11111111-1111-4111-8111-111111111111",
  origin: "https://bot.example.test",
  status: "active",
  installationId: "55555555-5555-4555-8555-555555555555",
  tenantId: "66666666-6666-4666-8666-666666666666",
  lastSyncedAt: null,
  error: null,
  pending: false,
  rotationPending: true,
};
const person = {
  actorId: "22222222-2222-4222-8222-222222222222",
  role: "member",
  displayName: "Assigned person",
  email: "assigned@example.test",
};
const policy = {
  revision: 2,
  enabled: false,
  intervalMinutes: 60,
  retentionDays: 30,
  destinationRef: "offsite",
};
const target = {
  id: "33333333-3333-4333-8333-333333333333",
  applicationId: app.id,
  origin: app.origin,
  status: "active",
  policy: { ...policy, revision: 3 },
  pending: true,
  error: null,
  observedAt: new Date().toISOString(),
  restoreEnabled: false,
  observation: {
    protocol: "helix.federation.backup.v1",
    owner: "workspace",
    scheduler: "external",
    capabilities: ["backup", "verify"],
    policy,
    requiredCoverage: ["database", "files", "configuration"],
    alerts: ["restore_drill_missing"],
    applicationHealthy: true,
    jobs: [],
  },
};
async function accessible(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(0);
  await page.addScriptTag({ content: axe.source });
  expect(
    await page.evaluate(
      async () =>
        (
          await (window as typeof window & { axe: typeof axe }).axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          })
        ).violations,
    ),
  ).toEqual([]);
}
for (const width of [1440, 390]) {
  test(`app details, capability failure/retry and assignments remain accessible at ${width}px`, async ({
    page,
  }) => {
    test.skip(isLiveBackend(), "App management uses an isolated directory and recovery fixture.");
    await page.setViewportSize({ width, height: 900 });
    let unavailable = false;
    let failedSave = true;
    const writes: unknown[] = [];
    let assignments = [person];
    let revision = "1";
    await page.route("**/api/**", async (route) => {
      if (await fulfillCoreAppsRoute(route)) return;
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/federation-applications"))
        return route.fulfill({ json: { applications: [app] } });
      if (path.endsWith("/federation-backups"))
        return route.fulfill(
          unavailable
            ? { status: 403, json: { error: { message: "Recovery administration is required." } } }
            : {
                json: {
                  targets: [
                    target,
                    {
                      ...target,
                      id: "unrelated",
                      applicationId: "another-app",
                      observation: { ...target.observation, alerts: ["unrelated-private-marker"] },
                    },
                  ],
                },
              },
        );
      if (path.endsWith("/assignments")) {
        if (route.request().method() === "PUT") {
          const body = route.request().postDataJSON();
          writes.push(body);
          if (failedSave)
            return route.fulfill({
              status: 409,
              json: { error: { message: "Assignments were not saved. Retry." } },
            });
          assignments = body.assignments.map((entry: { actorId: string; role: string }) => ({
            ...person,
            ...entry,
          }));
          return route.fulfill({ json: { updated: true } });
        }
        return route.fulfill({ json: { assignments, revision } });
      }
      return route.fulfill({
        json: { applications: [], targets: [], jobs: [], users: [], nextCursor: null },
      });
    });
    await page.goto("/admin/federation-applications");
    await expect(page.getByRole("heading", { name: "Federated apps", exact: true })).toBeVisible();
    await expect(
      page.getByText("Connection credential delivery is pending.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Directory: verification overdue.", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "View app details", exact: true }).click();
    const details = page.getByRole("region", { name: "Application details" });
    await expect(details).toContainText("Last acknowledged policy: revision 2");
    await expect(details).toContainText("Desired Workspace policy: revision 3. Delivery pending");
    await expect(details).toContainText("Isolated restore: not enrolled");
    await expect(details).not.toContainText("unrelated-private-marker");
    await expect(
      details.getByRole("link", { name: "Open application", exact: true }),
    ).toHaveAttribute("href", app.origin);
    await expect(details).toContainText("Application health: healthy");
    unavailable = true;
    await details.getByRole("button", { name: "Refresh backup status" }).click();
    await expect(details.getByRole("alert")).toContainText("Backup status unavailable");
    await expect(details).not.toContainText("Application health: healthy");
    await accessible(page);
    unavailable = false;
    await details.getByRole("button", { name: "Refresh backup status" }).click();
    await expect(details).toContainText("Application health: healthy");
    await page.getByRole("button", { name: "Manage assigned people", exact: true }).click();
    const assigned = page.getByRole("combobox", { name: person.email, exact: true });
    await expect(assigned).toHaveValue("member");
    await assigned.selectOption("admin");
    await page.getByRole("button", { name: "Refresh assigned people" }).click();
    await expect(assigned).toHaveValue("admin");
    await page.getByRole("button", { name: "Save assignments" }).click();
    await expect(page.getByRole("alert")).toContainText("Assignments were not saved");
    await expect(assigned).toHaveValue("admin");
    await page.getByRole("button", { name: "Manage assigned people", exact: true }).click();
    await page.getByRole("button", { name: "Manage assigned people", exact: true }).click();
    await expect(assigned).toHaveValue("admin");
    failedSave = false;
    await page.getByRole("button", { name: "Save assignments" }).click();
    await expect(
      page.getByText("Assignments saved. Directory synchronization is pending.", { exact: true }),
    ).toBeVisible();
    expect(writes).toEqual(
      [0, 1].map(() => ({
        revision: "1",
        assignments: [{ actorId: person.actorId, role: "admin" }],
      })),
    );
    await assigned.selectOption("viewer");
    assignments = [{ ...person, role: "member" }];
    revision = "2";
    await page.getByRole("button", { name: "Refresh assigned people" }).click();
    await expect(
      page.getByText("The directory or assignments changed.", { exact: false }),
    ).toBeVisible();
    await expect(assigned).toHaveValue("viewer");
    await expect(page.getByRole("button", { name: "Save assignments" })).toBeDisabled();
    await page.getByRole("button", { name: "Use current assignments" }).click();
    await expect(assigned).toHaveValue("member");
    await accessible(page);
  });
}
