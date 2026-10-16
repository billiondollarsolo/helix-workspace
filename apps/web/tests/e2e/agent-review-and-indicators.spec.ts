import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";

const pendingId = "00000000-0000-4000-8000-000000000701";

async function mockReview(page: Page, expired = false) {
  const state = {
    decisions: [] as string[],
    status: "pending_confirmation",
    chatUnread: 3,
    mailUnread: 7,
  };
  await seedBrowserSession(page, "agent-review-test");
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path === "/v1/api/core-apps")
      body = {
        role: "all-in-one",
        apps: ["mail", "chat", "drive", "meet", "assistant"].map((id) => ({
          id,
          name: id,
          enabled: true,
          registered: ["mail", "chat", "drive"].includes(id),
        })),
      };
    else if (path === "/v1/api/tools/assistant.status") body = { available: false };
    else if (path.startsWith("/v1/actions/") && path.endsWith("/review"))
      body = {
        action: {
          id: path.split("/").at(-2),
          toolId: "mail.send",
          actorId: "00000000-0000-4000-8000-000000000702",
          status: path.includes(pendingId) ? state.status : "pending_confirmation",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: expired ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
        },
        review: {
          from: { address: "atlas@example.test", name: "Atlas" },
          to: [{ address: "mike@example.test" }],
          cc: [],
          bcc: [],
          subject: "Atlas approval test",
          bodyText: "Only send this message after a human approves.",
          bodyHtml: "<script>window.reviewExecuted = true</script><b>HTML must stay inert</b>",
          attachments: [],
        },
      };
    else if (path.startsWith(`/v1/api/tools/pending/${pendingId}/`)) {
      const choice = path.split("/").at(-1) ?? "";
      state.decisions.push(choice);
      expect(route.request().headers()["x-helix-csrf-token"]).toBe("e2e-csrf-token");
      state.status = choice === "approve" ? "executed" : "cancelled";
      body = { status: state.status };
    } else if (path === "/v1/api/tools/mail.folders.list")
      body = { folders: [{ id: "inbox", label: "Inbox", total: 10, unread: state.mailUnread }] };
    else if (path === "/v1/api/tools/chat.unread.list")
      body = { rooms: [], totalUnread: state.chatUnread, totalMentions: 0 };
    else if (path === "/v1/api/tools/notifications.unread-count") body = { count: 0 };
    else if (await fulfillCoreAppsRoute(route)) return;
    else body = {};
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  return state;
}

test.describe("Agent review and global indicators", () => {
  test("reviews a non-email action without exposing executable content", async ({ page }) => {
    await mockReview(page);
    await page.route("**/v1/actions/*/review", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          action: {
            id: pendingId,
            toolId: "drive.rename",
            actorId: "00000000-0000-4000-8000-000000000702",
            status: "pending_confirmation",
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
          review: {
            kind: "action",
            preview: {
              toolId: "drive.rename",
              action: "drive.write",
              resourceIds: ["file-1"],
              recipients: [],
              targets: [],
              consequence: "Renames the selected file.",
            },
            input: {
              objectId: "file-1",
              name: "<script>window.executed = true</script>",
              secret: "[redacted]",
            },
            sourceIds: ["mail-thread-1"],
          },
        }),
      }),
    );
    await page.goto(`/approvals/${pendingId}`);
    await expect(page.getByRole("heading", { name: "Review action", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Proposed arguments" })).toContainText(
      "[redacted]",
    );
    await expect(page.getByRole("button", { name: "Approve and run" })).toBeVisible();
    await expect(page.getByText("mail-thread-1", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, "executed"))).toBeUndefined();
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => {
      const result = await (window as typeof window & { axe: typeof axe }).axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      });
      return result.violations;
    });
    expect(violations).toEqual([]);
  });

  test.skip(isLiveBackend(), "These security and expiry fixtures use a mocked backend.");

  for (const theme of ["light", "dark"] as const) {
    for (const width of [390, 1280] as const) {
      test(`reviews email and unread badges in ${theme} at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.addInitScript(
          (nextTheme) =>
            localStorage.setItem(
              "helix-appearance",
              JSON.stringify({
                theme: nextTheme,
                density: "compact",
                accent: "violet",
                fontScale: "default",
              }),
            ),
          theme,
        );
        const state = await mockReview(page);
        await page.goto(`/approvals/${pendingId}`);
        await expect(
          page.getByRole("heading", { name: "Review email", exact: true }),
        ).toBeVisible();
        await expect(page.getByText("mike@example.test", { exact: true })).toBeVisible();
        await expect(
          page.getByText("Only send this message after a human approves."),
        ).toBeVisible();
        const nav = page.locator(width < 768 ? ".bottom-nav" : ".rail");
        await expect(nav.getByRole("link", { name: "Mail", exact: true })).toHaveAttribute(
          "aria-describedby",
          /mail-unread$/,
        );
        await expect(
          nav.getByRole("link", { name: "Chat", exact: true }).locator(".app-unread-badge"),
        ).toContainText("3");
        await expect(nav.getByRole("link", { name: "Meet", exact: true })).toHaveCount(0);
        await expect(nav.getByRole("link", { name: "Helix AI", exact: true })).toHaveCount(0);
        expect(state.decisions).toEqual([]);
        await page.locator("summary").filter({ hasText: "HTML source" }).click();
        expect(await page.evaluate(() => "reviewExecuted" in window)).toBe(false);
        await page.addScriptTag({ content: axe.source });
        expect(
          await page.evaluate(async () => {
            const result = await (window as typeof window & { axe: typeof axe }).axe.run({
              include: ["main", "nav[aria-label='Apps']"],
            });
            return result.violations.map((item) => ({
              id: item.id,
              targets: item.nodes.map((node) => node.target),
            }));
          }),
        ).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.getByRole("button", { name: "Approve and send", exact: true }).click();
        await expect(page.getByRole("status").filter({ hasText: "Helix accepted" })).toBeVisible();
        expect(state.decisions).toEqual(["approve"]);
      });
    }
  }

  test("denies a request and never submits an expired one", async ({ page }) => {
    const state = await mockReview(page);
    await page.goto(`/approvals/${pendingId}`);
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(page.getByText("Denied. This email will not be sent.")).toBeVisible();
    expect(state.decisions).toEqual(["cancel"]);
    await page.unroute("**/v1/**");
    const expired = await mockReview(page, true);
    await page.reload();
    await expect(page.getByText("This request is expired.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve and send" })).toHaveCount(0);
    expect(expired.decisions).toEqual([]);
  });

  test("refreshes cross-app counts without navigation or losing focus", async ({ page }) => {
    await page.clock.install();
    const state = await mockReview(page);
    await page.goto(`/approvals/${pendingId}`);
    const approve = page.getByRole("button", { name: "Approve and send", exact: true });
    await approve.focus();
    state.chatUnread = 4;
    state.mailUnread = 8;
    await page.clock.runFor(30_100);
    await expect(page.locator(".rail #rail-chat-unread")).toHaveText("4 unread messages");
    await expect(page.locator(".rail #rail-mail-unread")).toHaveText("8 unread messages");
    await expect(approve).toBeFocused();
    expect(state.decisions).toEqual([]);
    expect(page.url()).toContain(`/approvals/${pendingId}`);
  });

  test("does not carry an approval decision into another request", async ({ page }) => {
    const state = await mockReview(page);
    await page.goto(`/approvals/${pendingId}`);
    await page.getByRole("button", { name: "Approve and send", exact: true }).click();
    await expect(page.getByText("Approved. Helix accepted the send request.")).toBeVisible();
    const nextId = "00000000-0000-4000-8000-000000000703";
    await page.evaluate((id) => {
      history.pushState(null, "", `/approvals/${id}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, nextId);
    await expect(page.getByRole("button", { name: "Approve and send", exact: true })).toBeVisible();
    await expect(page.getByText("This email has not been sent.")).toBeVisible();
    expect(state.decisions).toEqual(["approve"]);
  });

  test("does not flash disabled apps before configuration arrives", async ({ page }) => {
    await mockReview(page);
    let release!: () => void;
    const configuration = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/core-apps", async (route) => {
      await configuration;
      await route.fallback();
    });
    await page.addInitScript(() => {
      (window as typeof window & { flashedApps: string[] }).flashedApps = [];
      new MutationObserver(() => {
        for (const label of ["Meet", "Helix AI"]) {
          if (document.querySelector(`.rail a[aria-label="${label}"]`))
            (window as typeof window & { flashedApps: string[] }).flashedApps.push(label);
        }
      }).observe(document, { subtree: true, childList: true });
    });
    await page.goto(`/approvals/${pendingId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Review email", exact: true })).toBeVisible();
    await expect(page.locator(".rail a[aria-label='Mail']")).toHaveCount(0);
    release();
    await expect(page.locator(".rail a[aria-label='Mail']")).toBeVisible();
    expect(
      await page.evaluate(() => (window as typeof window & { flashedApps: string[] }).flashedApps),
    ).toEqual([]);
  });
});
