import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";

const actorId = "00000000-0000-4000-8000-000000000111";
const orgId = "00000000-0000-4000-8000-000000000100";
const timestamp = "2026-09-10T12:00:00Z";
interface Address {
  id: string | null;
  address: string;
  displayName: string | null;
  isPrimary: boolean;
  receiveEnabled: boolean;
  sendAsEnabled: boolean;
  source: "primary" | "alias" | "domain_alias";
}
const initialAddresses: Address[] = [
  {
    id: null,
    address: "morgan@first.test",
    displayName: "Morgan",
    isPrimary: true,
    receiveEnabled: true,
    sendAsEnabled: true,
    source: "primary",
  },
  {
    id: "alias-1",
    address: "support@second.test",
    displayName: "Morgan",
    isPrimary: false,
    receiveEnabled: true,
    sendAsEnabled: true,
    source: "alias",
  },
  {
    id: null,
    address: "morgan@automatic.test",
    displayName: "Morgan",
    isPrimary: false,
    receiveEnabled: true,
    sendAsEnabled: true,
    source: "domain_alias",
  },
];
test.beforeEach(() =>
  test.skip(isLiveBackend(), "Address error injection uses isolated fixtures."),
);

test("admin manages addresses across selected domains and keeps failed changes editable", async ({
  page,
}) => {
  const state = await mockAddresses(page, true);
  await openAddresses(page);
  const dialog = page.getByRole("dialog", { name: "Mail addresses for Morgan Lee" });
  await expect(dialog).toContainText("sign-in email stays unchanged");
  await expect(dialog).toContainText("Login email: morgan@login.test");
  await expect(dialog.getByLabel("Primary address domain").locator("option")).toHaveText([
    "Select a verified domain",
    "first.test",
    "second.test",
  ]);
  await expect(
    dialog.getByRole("button", { name: "Remove alias morgan@automatic.test" }),
  ).toHaveCount(0);
  await dialog.getByLabel("Alias name", { exact: true }).fill("sales");
  await dialog.getByLabel("Alias domain", { exact: true }).selectOption("second.test");
  await dialog.getByLabel("Allow sending as this alias").uncheck();
  await dialog.getByRole("button", { name: "Add alias", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("This address belongs to another user.");
  await expect(dialog.getByLabel("Alias name", { exact: true })).toHaveValue("sales");
  await dialog.getByRole("button", { name: "Add alias", exact: true }).click();
  await expect(dialog.getByLabel("Send as sales@second.test")).not.toBeChecked();
  await dialog.getByLabel("Send as sales@second.test").click();
  await expect(dialog.getByLabel("Send as sales@second.test")).toBeChecked();
  await dialog.getByLabel("Receive mail at sales@second.test").click();
  await expect(dialog.getByLabel("Receive mail at sales@second.test")).not.toBeChecked();
  await dialog.getByLabel("Primary address name", { exact: true }).fill("support");
  await dialog.getByLabel("Primary address domain", { exact: true }).selectOption("second.test");
  await dialog.getByRole("button", { name: "Set primary address" }).click();
  await expect(dialog).toContainText("Primary mail address: support@second.test");
  await expect(dialog.getByLabel("Send as morgan@first.test")).toBeChecked();
  await dialog.getByRole("button", { name: "Remove alias sales@second.test", exact: true }).click();
  await expect(dialog.getByLabel("Send as sales@second.test")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  const details = page.getByRole("button", { name: "Details for Morgan Lee", exact: true });
  await expect(details).toBeVisible();
  if ((await details.getAttribute("aria-expanded")) !== "true") await details.click();
  await page
    .getByRole("button", { name: "Manage mail addresses for Morgan Lee", exact: true })
    .click();
  await expect(dialog).toContainText("Primary mail address: support@second.test");
  expect(
    state.writes.filter((write) => write.method === "POST").map((write) => write.body),
  ).toEqual([
    { address: "sales@second.test", receiveEnabled: true, sendAsEnabled: false },
    { address: "sales@second.test", receiveEnabled: true, sendAsEnabled: false },
  ]);
});

test("email group create and edit send explicit internal or external posting policy", async ({
  page,
}) => {
  const state = await mockAddresses(page);
  await page.goto("/admin/groups");
  await page.getByRole("button", { name: "New group", exact: true }).click();
  await page.getByLabel("New group name", { exact: true }).fill("Support team");
  await page.getByLabel("Group email name", { exact: true }).fill("team");
  await page.getByLabel("Group email domain", { exact: true }).selectOption("second.test");
  await expect(page.getByLabel("Who can email this group?")).toHaveValue("organization");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.getByRole("button", { name: "Manage team@second.test", exact: true }).click();
  await page.getByLabel("Who can email this group?").selectOption("anyone");
  await page.getByRole("button", { name: "Save group settings", exact: true }).click();
  await expect(page.getByText("Group settings saved.", { exact: true })).toBeVisible();
  expect(state.groupWrites).toEqual([
    {
      name: "Support team",
      kind: "mailing_list",
      email: "team@second.test",
      postingPolicy: "organization",
    },
    {
      name: "Support team",
      kind: "mailing_list",
      email: "team@second.test",
      postingPolicy: "anyone",
    },
  ]);
  await page.reload();
  await page.getByRole("button", { name: "Manage team@second.test", exact: true }).click();
  await expect(page.getByLabel("Who can email this group?")).toHaveValue("anyone");
});

test("saved drafts retain From after reload and revoked aliases block sending until changed", async ({
  page,
}) => {
  const state = await mockAddresses(page);
  await page.goto("/mail");
  await openCompose(page);
  const compose = page.locator(".compose");
  await compose.getByLabel("From address").selectOption("support@second.test");
  await compose.getByLabel("To", { exact: true }).fill("recipient@first.test");
  await compose.getByLabel("Subject", { exact: true }).fill("Sender draft");
  await compose.getByLabel("Subject", { exact: true }).blur();
  await expect.poll(() => state.draft?.from).toEqual({ address: "support@second.test" });
  state.revokeAlias();
  await page.reload();
  await openCompose(page);
  await expect(compose.getByLabel("Subject", { exact: true })).toHaveValue("Sender draft");
  await expect(compose.getByLabel("From address")).toHaveValue("support@second.test");
  await expect(compose.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(compose).toContainText("Choose an available sending address");
  await compose.getByLabel("From address").selectOption("morgan@first.test");
  await compose.getByRole("button", { name: "Send", exact: true }).click();
  await expect(compose).toHaveCount(0);
  expect(state.sent).toMatchObject({
    from: { address: "morgan@first.test" },
    subject: "Sender draft",
  });
});

for (const width of [390, 768, 1440])
  for (const theme of ["light", "dark"] as const) {
    test(`address, group and sender forms are accessible at ${width}px ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 960 });
      await page.addInitScript(
        (value) => localStorage.setItem("helix-appearance", JSON.stringify({ theme: value })),
        theme,
      );
      await mockAddresses(page);
      await openAddresses(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await audit(page);
      await page.screenshot({
        path: `/tmp/helix-release-work/admin-addresses-${width}-${theme}.png`,
        fullPage: true,
      });
      const dialog = page.getByRole("dialog", { name: "Mail addresses for Morgan Lee" });
      const bounds = await dialog.boundingBox();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await page.goto("/admin/groups");
      await page.getByRole("button", { name: "New group", exact: true }).click();
      await audit(page);
      await page.screenshot({
        path: `/tmp/helix-release-work/mail-groups-${width}-${theme}.png`,
        fullPage: true,
      });
      await page.goto("/mail");
      await openCompose(page);
      await expect(page.getByLabel("From address")).toHaveValue("morgan@first.test");
      await audit(page);
      await page.screenshot({
        path: `/tmp/helix-release-work/mail-addresses-${width}-${theme}.png`,
        fullPage: true,
      });
    });
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
async function openAddresses(page: Page) {
  await page.goto("/admin/users");
  const details = page.getByRole("button", { name: "Details for Morgan Lee", exact: true });
  await expect(details).toBeVisible();
  if ((await details.getAttribute("aria-expanded")) !== "true") await details.click();
  await page
    .getByRole("button", { name: "Manage mail addresses for Morgan Lee", exact: true })
    .click();
  await expect(page.getByLabel("Primary address domain")).toBeVisible();
}
async function mockAddresses(page: Page, failFirst = false) {
  await seedBrowserSession(page, "mail-address-session");
  let addresses = initialAddresses.map((address) => ({ ...address }));
  let groups: Record<string, unknown>[] = [];
  const state = {
    writes: [] as { method: string; body: unknown }[],
    groupWrites: [] as unknown[],
    draft: null as Record<string, unknown> | null,
    sent: null as unknown,
    revokeAlias: () => {
      addresses = addresses.map((address) => ({
        ...address,
        sendAsEnabled: address.source !== "alias",
      }));
    },
  };
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const payload = () => ({
      actorId,
      loginEmail: "morgan@login.test",
      primaryEmail: addresses.find((address) => address.isPrimary)?.address ?? null,
      eligibleDomains: [
        { domain: "first.test", primary: true, aliases: true },
        { domain: "second.test", primary: true, aliases: true },
        { domain: "automatic.test", primary: false, aliases: true },
      ],
      addresses,
    });
    if (
      path === "/v1/api/mail/addresses" ||
      path.startsWith(`/v1/api/admin/users/${actorId}/addresses`)
    ) {
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      if (method !== "GET") {
        expect(request.headers()["x-helix-csrf-token"]).toBe("e2e-csrf-token");
        state.writes.push({ method, body });
      }
      if (method === "POST") {
        if (failFirst) {
          failFirst = false;
          await route.fulfill({
            status: 409,
            json: { error: { message: "This address belongs to another user." } },
          });
          return;
        }
        addresses.push({
          id: "alias-added",
          address: String(body.address),
          displayName: null,
          isPrimary: false,
          receiveEnabled: Boolean(body.receiveEnabled),
          sendAsEnabled: Boolean(body.sendAsEnabled),
          source: "alias",
        });
      }
      if (method === "PATCH")
        addresses = addresses.map((address) =>
          path.endsWith(`/${address.id}`) ? { ...address, ...body } : address,
        );
      if (method === "DELETE")
        addresses = addresses.filter((address) => !path.endsWith(`/${address.id}`));
      if (method === "PUT")
        addresses = addresses.map((address) => ({
          ...address,
          isPrimary: address.address === body.address,
          source:
            address.address === body.address
              ? "primary"
              : address.isPrimary
                ? "alias"
                : address.source,
          id: address.isPrimary ? "former-primary" : address.id,
        }));
      await route.fulfill({ json: payload() });
      return;
    }
    if (path === "/v1/api/admin/users") {
      await route.fulfill({
        json: {
          users: [
            {
              id: actorId,
              orgId,
              type: "user",
              displayName: "Morgan Lee",
              email: payload().primaryEmail,
              scopes: [],
              disabledAt: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          nextCursor: null,
        },
      });
      return;
    }
    if (path === "/v1/api/admin/org-units") {
      await route.fulfill({ json: { orgUnits: [] } });
      return;
    }
    if (path === "/v1/api/admin/groups/eligible-domains") {
      await route.fulfill({ json: { eligibleDomains: payload().eligibleDomains } });
      return;
    }
    if (path.startsWith("/v1/api/admin/groups")) {
      if (path.endsWith("/members")) {
        await route.fulfill({ json: { members: [] } });
        return;
      }
      if (method === "GET") {
        await route.fulfill({ json: { groups } });
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      state.groupWrites.push(body);
      const group = {
        id: "group-1",
        orgId,
        description: "",
        orgUnitId: null,
        memberCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...body,
      };
      groups = [group];
      await route.fulfill({ json: { group } });
      return;
    }
    if (path === "/v1/api/tools/mail.draft.save") {
      state.draft = {
        ...(request.postDataJSON() as Record<string, unknown>),
        id: "00000000-0000-4000-8000-000000000999",
        orgId,
        actorId,
        threadId: null,
        revision: 1,
        createdAt: timestamp,
        updatedAt: new Date().toISOString(),
        expiresAt: "2027-01-01T00:00:00Z",
      };
      await route.fulfill({ json: state.draft });
      return;
    }
    if (path === "/v1/api/tools/mail.draft.list") {
      await route.fulfill({ json: { drafts: state.draft ? [state.draft] : [] } });
      return;
    }
    if (path === "/v1/api/tools/mail.draft.get") {
      await route.fulfill({ json: state.draft });
      return;
    }
    if (path === "/v1/api/tools/mail.send") {
      state.sent = request.postDataJSON();
      await route.fulfill({ json: { id: "sent-1", status: "queued" } });
      return;
    }
    if (path === "/v1/api/tools/mail.threads.list") {
      await route.fulfill({ json: { threads: [], total: 0, limit: 50, offset: 0 } });
      return;
    }
    if (path === "/v1/api/tools/mail.folders.list") {
      await route.fulfill({
        json: { folders: [{ id: "inbox", label: "Inbox", total: 0, unread: 0 }] },
      });
      return;
    }
    if (path === "/v1/api/tools/mail.labels.list") {
      await route.fulfill({ json: { labels: [] } });
      return;
    }
    if (path.startsWith("/v1/api/tools/mail.")) {
      await route.fulfill({ json: {} });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unexpected ${method} ${path}` } });
  });
  return state;
}

async function openCompose(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) <= 700)
    await page.getByRole("button", { name: "Toggle section navigation", exact: true }).click();
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  if ((page.viewportSize()?.width ?? 1440) <= 700)
    await page.getByRole("button", { name: "Toggle section navigation", exact: true }).click();
}

test("domain identity choices retain MFA and second-administrator gates", async ({ page }) => {
  await mockAddresses(page);
  const base = {
    orgId,
    status: "verified",
    isPrimary: false,
    identityEnabled: true,
    mailEnabled: true,
    aliasesEnabled: true,
    customHostEnabled: false,
    federationEnabled: false,
    providerId: null,
    identityMode: "secondary",
    aliasTargetDomainId: null,
    verificationHost: "_helix.test",
    verificationValue: "test-challenge",
    verificationExpiresAt: "2027-01-01T00:00:00Z",
    verificationAttempts: 0,
    verificationLastAttemptAt: null,
    quarantinedAt: null,
    releasedAt: null,
    claimableAfter: null,
    verifiedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const domains = [
    { domain: { ...base, id: "first", domain: "first.test", isPrimary: true }, dnsRecords: [] },
    { domain: { ...base, id: "second", domain: "second.test" }, dnsRecords: [] },
    {
      domain: { ...base, id: "pending", domain: "pending.test", status: "pending" },
      dnsRecords: [],
    },
    {
      domain: {
        ...base,
        id: "alias",
        domain: "automatic.test",
        identityMode: "alias",
        aliasTargetDomainId: "first",
      },
      dnsRecords: [],
    },
  ];
  const writes: unknown[] = [];
  await page.route("**/api/admin/domains**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { domains } });
      return;
    }
    writes.push(route.request().postDataJSON());
    await route.fulfill(
      writes.length === 1
        ? {
            status: 403,
            json: {
              code: "crown_jewel_step_up_required",
              error: "Recent MFA verification is required.",
            },
          }
        : {
            status: 202,
            json: { code: "crown_jewel_approval_required", approval: { id: "approval-1" } },
          },
    );
  });
  await page.goto("/admin/domains");
  const entry = (name: string) =>
    page
      .locator(".admin-domain-entry")
      .filter({ has: page.locator(".admin-domain-name", { hasText: name }) });
  await expect(entry("first.test").getByLabel("Domain identity mode")).toBeDisabled();
  const secondary = entry("second.test");
  await secondary.getByLabel("Domain identity mode").selectOption("alias");
  await expect(secondary.getByLabel("Alias target domain").locator("option")).toHaveText([
    "Select a verified identity domain",
    "first.test",
  ]);
  await secondary.getByLabel("Alias target domain").selectOption("first");
  await secondary.getByRole("button", { name: "Save domain identity" }).click();
  await expect(secondary.getByRole("alert")).toContainText("Recent MFA verification is required.");
  await secondary.getByRole("button", { name: "Save domain identity" }).click();
  await expect(secondary.getByRole("alert")).toContainText(
    "A second administrator must approve this change (request approval-1). The requested change has not been applied.",
  );
  expect(writes).toEqual([
    { identityMode: "alias", aliasTargetDomainId: "first" },
    { identityMode: "alias", aliasTargetDomainId: "first" },
  ]);
  await audit(page);
  await page.screenshot({
    path: "/tmp/helix-release-work/mail-domain-approval.png",
    fullPage: true,
  });
});
