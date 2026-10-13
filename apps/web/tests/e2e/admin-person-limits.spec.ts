import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend } from "./support/backend-mode";

/* Admin → Limits: how much each person may store and send. The organization
   sets a default for everyone, and a person or agent can be given values of
   their own; an empty value falls back to the default, and an empty default
   means no limit. */

test.beforeEach(() =>
  test.skip(isLiveBackend(), "Uses a fixed set of people the live backend does not have."),
);

const GB = 1024 ** 3;

interface Values {
  storageBytes: number | null;
  mailSendPerHour: number | null;
  mailSendPerDay: number | null;
}

interface Desk {
  defaults: Values;
  lee: Values;
  defaultSaves: unknown[];
  personSaves: unknown[];
}

function person(desk: Desk) {
  const effective = {
    storageBytes: desk.lee.storageBytes ?? desk.defaults.storageBytes,
    mailSendPerHour: desk.lee.mailSendPerHour ?? desk.defaults.mailSendPerHour,
    mailSendPerDay: desk.lee.mailSendPerDay ?? desk.defaults.mailSendPerDay,
  };
  return {
    actorId: "11111111-1111-4111-8111-111111111111",
    displayName: "Lee Park",
    email: "lee@example.com",
    type: "user",
    overrides: desk.lee,
    effective,
    usage: { storageBytes: 1.5 * GB, mailSentLastHour: 3, mailSentLastDay: 12 },
  };
}

async function openLimits(page: Page): Promise<Desk> {
  const desk: Desk = {
    defaults: { storageBytes: null, mailSendPerHour: null, mailSendPerDay: null },
    lee: { storageBytes: 20 * GB, mailSendPerHour: null, mailSendPerDay: null },
    defaultSaves: [],
    personSaves: [],
  };
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    if (pathname === "/v1/api/admin/tenant-config" && method === "PATCH") {
      const update = request.postDataJSON() as {
        quotas: {
          storage_bytes_per_person_limit: number | null;
          mail_send_per_hour_limit: number | null;
          mail_send_per_day_limit: number | null;
        };
      };
      desk.defaultSaves.push(update);
      desk.defaults = {
        storageBytes: update.quotas.storage_bytes_per_person_limit,
        mailSendPerHour: update.quotas.mail_send_per_hour_limit,
        mailSendPerDay: update.quotas.mail_send_per_day_limit,
      };
      return route.fulfill({
        json: {
          tenantConfig: {
            orgId: "33333333-3333-4333-8333-333333333333",
            orgName: "Example",
            byo: {},
            features: {},
            quotas: update.quotas,
            branding: {},
            effective: { byo: {}, features: {}, quotas: update.quotas, branding: {} },
          },
        },
      });
    }
    if (pathname === "/v1/api/admin/person-limits") {
      const overridden = Object.values(desk.lee).some((value) => value !== null);
      return route.fulfill({
        json: { defaults: desk.defaults, people: overridden ? [person(desk)] : [] },
      });
    }
    if (pathname.startsWith("/v1/api/admin/person-limits/")) {
      if (method === "PUT") {
        desk.lee = request.postDataJSON() as Values;
        desk.personSaves.push(desk.lee);
      }
      return route.fulfill({ json: { person: person(desk) } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/admin/limits");
  return desk;
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

test("sets the limits that apply to everyone", async ({ page }) => {
  const desk = await openLimits(page);
  const everyone = page.getByRole("region", { name: "For everyone" });
  // Nothing is limited until an administrator says so.
  for (const field of ["Storage (GB)", "Messages sent per hour", "Messages sent per day"]) {
    await expect(everyone.getByLabel(field)).toHaveValue("");
    await expect(everyone.getByLabel(field)).toHaveAttribute("placeholder", "No limit");
  }
  await everyone.getByLabel("Storage (GB)").fill("ten");
  await everyone.getByRole("button", { name: "Save defaults" }).click();
  await expect(everyone).toContainText("Enter numbers of zero or more.");
  expect(desk.defaultSaves).toEqual([]);

  await everyone.getByLabel("Storage (GB)").fill("15");
  await everyone.getByLabel("Messages sent per day").fill("500");
  await audit(page);
  await everyone.getByRole("button", { name: "Save defaults" }).click();
  await expect(everyone).toContainText("Defaults saved.");
  expect(desk.defaultSaves).toEqual([
    {
      quotas: {
        storage_bytes_per_person_limit: 15 * GB,
        mail_send_per_hour_limit: null,
        mail_send_per_day_limit: 500,
      },
      reason: "admin limits update: defaults for each person",
    },
  ]);
  await expect(everyone.getByLabel("Storage (GB)")).toHaveValue("15");
});

test("shows who has limits of their own and changes them", async ({ page }) => {
  const desk = await openLimits(page);
  const people = page.getByRole("list", { name: "People with their own limits" });
  await expect(people.getByRole("listitem")).toHaveCount(1);
  await expect(people).toContainText("Lee Park");
  await expect(people).toContainText("Storage 1.5 GB of 20 GB.");
  await expect(people).toContainText("Sent today 12, no limit.");

  await people.getByRole("button", { name: "Edit limits for Lee Park" }).click();
  const dialog = page.getByRole("dialog", { name: "Limits for Lee Park" });
  await expect(dialog).toContainText("Sent in the last hour");
  await expect(dialog.getByLabel("Storage (GB)")).toHaveValue("20");
  await audit(page);
  // An empty field hands that limit back to the organization's default.
  await dialog.getByLabel("Storage (GB)").fill("");
  await dialog.getByLabel("Messages sent per day").fill("1000");
  await dialog.getByRole("button", { name: "Save limits" }).click();
  await expect(dialog).toHaveCount(0);
  expect(desk.personSaves).toEqual([
    { storageBytes: null, mailSendPerHour: null, mailSendPerDay: 1000 },
  ]);
  await expect(people).toContainText("Sent today 12 of 1,000.");

  // Clearing every value returns the person to the defaults, and they leave the list.
  await people.getByRole("button", { name: "Edit limits for Lee Park" }).click();
  await page.getByRole("dialog").getByLabel("Messages sent per day").fill("");
  await page.getByRole("dialog").getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByText("Everyone uses the defaults.")).toBeVisible();
});
