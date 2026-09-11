import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";
const sourceId = "00000000-0000-4000-8000-000000000111";
const personId = "00000000-0000-4000-8000-000000000112";
const agentId = "00000000-0000-4000-8000-000000000113";
const orgId = "00000000-0000-4000-8000-000000000100";
const time = "2026-09-10T12:00:00Z";
const initialCounts = {
  driveFiles: 3,
  driveFolders: 1,
  mailMessages: 4,
  mailDrafts: 2,
  calendars: 1,
  contacts: 6,
  addressBooks: 1,
  assistantConversations: 2,
  assistantMemories: 3,
};
test.beforeEach(() =>
  test.skip(
    isLiveBackend(),
    "Offboarding and policy tests never change live accounts or policies.",
  ),
);

for (const type of ["user", "agent"] as const)
  test(`previews and offboards a ${type} with ownership handoff and stale-preview recovery`, async ({
    page,
  }) => {
    const state = await mockAccounts(page, type);
    const dialog = await openOffboard(page);
    const owner = dialog.getByLabel("New owner", { exact: true });
    await expect(owner.locator("option")).toHaveCount(3);
    await dialog.getByRole("button", { name: "Review handoff", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Choose a successor for owned resources.",
    );
    await expect(dialog.getByRole("button", { name: "Offboard account", exact: true })).toHaveCount(
      0,
    );
    await owner.selectOption(type === "user" ? agentId : personId);
    await dialog.getByLabel("Keep receiving mail at the old addresses").check();
    await dialog.getByRole("button", { name: "Review handoff", exact: true }).click();
    const preview = dialog.getByRole("region", { name: "Account handoff preview" });
    await expect(preview.locator("dd")).toHaveText(Object.values(initialCounts).map(String));
    await expect(preview).toContainText(
      type === "user" ? "Builder agent (agent)" : "Mira Chen (user)",
    );
    await expect(preview).toContainText("receive only");
    await expect(preview).toContainText("morgan@first.test");
    expect(state.executions).toHaveLength(0);
    state.stale = true;
    await dialog.getByRole("button", { name: "Offboard account", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Resources changed. Review the handoff again.",
    );
    await expect(preview).toHaveCount(0);
    await expect(owner).toHaveValue(type === "user" ? agentId : personId);
    expect(state.executions).toHaveLength(1);
    await dialog.getByRole("button", { name: "Review handoff", exact: true }).click();
    await dialog.getByRole("button", { name: "Offboard account", exact: true }).click();
    await expect(dialog).toContainText("Access is disabled for Morgan Lee.");
    expect(state.executions.at(-1)).toEqual({
      successorActorId: type === "user" ? agentId : personId,
      preserveReceivingAddresses: true,
      confirmationToken: "preview-3",
    });
    expect(state.disabled).toBe(true);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });

test("security policy offers solo-operator choices, retains errors, and reads back effective safeguards", async ({
  page,
}) => {
  const state = await mockAccounts(page);
  await openMfa(page);
  await page.getByLabel("Administrator MFA", { exact: true }).selectOption("optional");
  await page.getByLabel("Require recent MFA for sensitive actions").uncheck();
  await page.getByLabel("Require a second administrator for sensitive actions").uncheck();
  state.policyError = true;
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Sign in again before changing administrator safeguards.",
  );
  await expect(page.getByLabel("Administrator MFA", { exact: true })).toHaveValue("optional");
  await expect(
    page.getByLabel("Require a second administrator for sensitive actions"),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await expect(page.getByLabel("Administrator MFA", { exact: true })).toHaveCount(0);
  const effective = page.locator('dl[aria-label="Effective administrator safeguards"]');
  await expect(effective).toContainText("Optional (policy)");
  await expect(effective).toContainText("Not required");
  expect(state.policyWrites).toHaveLength(2);
  expect(state.policyWrites[0]).toEqual(state.policyWrites[1]);
  expect(state.policyWrites[1]).toMatchObject({
    settings: {
      adminMfa: "optional",
      sensitiveActionMfaRequired: false,
      secondAdminApprovalRequired: false,
    },
  });
  await page.reload();
  await page.getByRole("button", { name: "Edit Multi-factor authentication", exact: true }).click();
  await expect(page.getByLabel("Administrator MFA", { exact: true })).toHaveValue("optional");
  await expect(page.getByLabel("Require recent MFA for sensitive actions")).not.toBeChecked();
});

test("typing and choice updates retain focus and Escape restores the offboard opener", async ({
  page,
}) => {
  await mockAccounts(page);
  const dialog = await openOffboard(page);
  const search = dialog.getByLabel("Find actor", { exact: true });
  await search.pressSequentially("Mira");
  await expect(search).toHaveValue("Mira");
  await expect(search).toBeFocused();
  const select = dialog.getByLabel("New owner", { exact: true });
  await select.selectOption(personId);
  await select.focus();
  await expect(select).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Offboard Morgan Lee", exact: true }),
  ).toBeFocused();
});

for (const width of [390, 768, 1440])
  for (const theme of ["light", "dark"] as const)
    test(`offboarding and operator safeguards are accessible at ${width}px ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 960 });
      await page.addInitScript(
        (theme) => localStorage.setItem("helix-appearance", JSON.stringify({ theme })),
        theme,
      );
      await mockAccounts(page);
      const dialog = await openOffboard(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await dialog.getByLabel("New owner", { exact: true }).selectOption(agentId);
      await dialog.getByRole("button", { name: "Review handoff", exact: true }).click();
      await expect(dialog.getByRole("region", { name: "Account handoff preview" })).toBeVisible();
      await audit(page);
      await page.screenshot({
        path: `/tmp/helix-release-work/offboarding-${width}-${theme}.png`,
        fullPage: true,
      });
      const bounds = await dialog.boundingBox();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await openMfa(page);
      await audit(page);
      await page.screenshot({
        path: `/tmp/helix-release-work/admin-safeguards-${width}-${theme}.png`,
        fullPage: true,
      });
    });
async function audit(page: Page) {
  await page.addScriptTag({ content: axe.source });
  const results = await page.evaluate(
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
  expect(results).toEqual([]);
}
async function openOffboard(page: Page) {
  await page.goto("/admin/users");
  const details = page.getByRole("button", { name: "Details for Morgan Lee", exact: true });
  await expect(details).toBeVisible();
  if ((await details.getAttribute("aria-expanded")) !== "true") await details.click();
  await page.getByRole("button", { name: "Offboard Morgan Lee", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Offboard Morgan Lee", exact: true });
  await expect(dialog.getByLabel("New owner", { exact: true })).toBeEnabled();
  return dialog;
}
async function openMfa(page: Page) {
  await page.goto("/admin/policies?policy=mfa");
  await expect(page.getByLabel("Administrator MFA", { exact: true })).toBeVisible();
}

async function mockAccounts(page: Page, sourceType = "user") {
  await seedBrowserSession(page, "offboarding-session");
  const state = {
    previews: [] as Record<string, unknown>[],
    executions: [] as Record<string, unknown>[],
    policyWrites: [] as Record<string, unknown>[],
    stale: false,
    disabled: false,
    policyError: false,
  };
  let policy = {
    id: "mfa-policy",
    orgId,
    policyType: "mfa",
    enabled: true,
    enforcement: "required",
    settings: {
      adminMfa: "tier_default",
      sensitiveActionMfaRequired: true,
      secondAdminApprovalRequired: true,
    },
    effectiveControls: {
      adminMfaRequired: true,
      sensitiveActionMfaRequired: true,
      secondAdminApprovalRequired: true,
      adminMfaSource: "tier",
    },
    updatedBy: null,
    createdAt: time,
    updatedAt: time,
  };
  const actors = () =>
    [
      {
        id: sourceId,
        type: sourceType,
        displayName: "Morgan Lee",
        disabledAt: state.disabled ? time : null,
      },
      { id: personId, type: "user", displayName: "Mira Chen", disabledAt: null },
      { id: agentId, type: "agent", displayName: "Builder agent", disabledAt: null },
      {
        id: "00000000-0000-4000-8000-000000000114",
        type: "system",
        displayName: "System",
        disabledAt: null,
      },
    ].map((actor) => ({
      ...actor,
      orgId,
      email: `${actor.id}@first.test`,
      scopes: [],
      createdAt: time,
      updatedAt: time,
    }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/api/auth/get-session") {
      await route.fulfill({
        json: {
          user: {
            id: "admin-user",
            actorId: "00000000-0000-4000-8000-000000000999",
            name: "Workspace admin",
            email: "admin@first.test",
          },
        },
      });
      return;
    }
    if (await fulfillCoreAppsRoute(route)) return;
    if (path === "/v1/api/admin/users") {
      const query = new URL(request.url()).searchParams.get("query")?.toLowerCase();
      await route.fulfill({
        json: {
          users: actors().filter(
            (actor) => !query || actor.displayName.toLowerCase().includes(query),
          ),
          nextCursor: null,
        },
      });
      return;
    }
    if (path.endsWith("/offboard/preview")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.previews.push(body);
      const successor = actors().find((actor) => actor.id === body.successorActorId) ?? null;
      await route.fulfill({
        json: {
          source: actors()[0],
          successor,
          counts: initialCounts,
          blockers: successor ? [] : ["Choose a successor for owned resources."],
          receivingAddresses: ["morgan@first.test", "support@second.test"],
          preserveReceivingAddresses: body.preserveReceivingAddresses === true,
          confirmationToken: `preview-${state.previews.length}`,
        },
      });
      return;
    }
    if (path.endsWith("/offboard")) {
      expect(request.headers()["x-helix-csrf-token"]).toBe("e2e-csrf-token");
      state.executions.push(request.postDataJSON() as Record<string, unknown>);
      if (state.stale) {
        state.stale = false;
        await route.fulfill({
          status: 409,
          json: { error: { message: "Resources changed. Review the handoff again." } },
        });
        return;
      }
      state.disabled = true;
      await route.fulfill({
        json: {
          offboard: {
            actorId: sourceId,
            orgId,
            disabled: true,
            sessionsRevoked: 0,
            appPasswordsRevoked: 1,
            agentCredentialsRevoked: 2,
          },
        },
      });
      return;
    }
    if (path === "/v1/api/admin/security-policies") {
      await route.fulfill({ json: { policies: [policy] } });
      return;
    }
    if (path === "/v1/api/admin/security-policies/mfa") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.policyWrites.push(body);
      if (state.policyError) {
        state.policyError = false;
        await route.fulfill({
          status: 403,
          json: {
            code: "security_policy_reauthentication_required",
            error: { message: "Sign in again before changing administrator safeguards." },
          },
        });
        return;
      }
      policy = {
        ...policy,
        ...body,
        effectiveControls: {
          adminMfaRequired: false,
          sensitiveActionMfaRequired: false,
          secondAdminApprovalRequired: false,
          adminMfaSource: "policy",
        },
      };
      await route.fulfill({ json: { policy } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Unexpected ${path}` } });
  });
  return state;
}
