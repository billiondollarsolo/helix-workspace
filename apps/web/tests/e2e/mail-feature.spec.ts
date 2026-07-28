/**
 * Mail feature E2E (P1-1) — drives the real /mail UI in a real browser.
 *
 * Modeled on `meet-jitsi-embed.spec.ts` / `admin-dashboard.spec.ts`.
 *
 * MOCKED (default): every `/api/**` call is intercepted with deterministic
 * fixtures, so this runs anywhere including CI's `pnpm exec playwright test`.
 *
 * LIVE (`HELIX_E2E_BACKEND=live`): no mocks are installed; the spec mints a real
 * OAuth token and exercises the live mail tools served by the docker-compose
 * backend. See `.github/workflows/e2e.yml` and `support/backend-mode.ts`.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { isLiveBackend, mintLiveAccessToken } from "./support/backend-mode";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const mailScope = "platform.read mail.read mail.send";

interface BackendCall {
  readonly authorization: string | null;
  readonly method: string;
  readonly pathname: string;
}

test.describe("/mail feature flow", () => {
  test("renders backend thread rows in the inbox", async ({ page }) => {
    const backendCalls: BackendCall[] = [];

    const accessToken = await seedAccessToken(page, mailScope, "e2e-mail-token");
    if (!isLiveBackend()) {
      await mockMailBackend(page, backendCalls, accessToken);
    }

    await page.goto("/mail");

    await expect(page.getByRole("main", { name: "Mail" })).toBeVisible();

    if (!isLiveBackend()) {
      // The mocked fixture guarantees this exact thread is in the inbox.
      await expect(page.getByText("Backend launch thread")).toBeVisible();
      const listCall = backendCalls.find(
        (call) => call.pathname === "/api/tools/mail.threads.list",
      );
      expect(listCall?.method).toBe("POST");
      expect(listCall?.authorization).toBe(`Bearer ${accessToken}`);
    } else {
      // Live mode: the inbox region must render without a backend error state.
      await expect(page.getByText("Mail backend unavailable")).toHaveCount(0);
    }
  });
});

async function seedAccessToken(page: Page, scope: string, mockToken: string): Promise<string> {
  const token = isLiveBackend() ? await mintLiveAccessToken(scope) : mockToken;
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: accessTokenStorageKey, value: token },
  );
  return token;
}

async function mockMailBackend(page: Page, calls: BackendCall[], accessToken: string) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    calls.push({
      authorization: request.headers().authorization ?? null,
      method: request.method(),
      pathname,
    });

    if (request.headers().authorization !== `Bearer ${accessToken}`) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "missing bearer token" }),
      });
      return;
    }

    if (pathname === "/api/tools/mail.threads.list") {
      await fulfillJson(route, {
        threads: [
          {
            threadId: "00000000-0000-4000-8000-000000000301",
            messageId: "00000000-0000-4000-8000-000000000401",
            subject: "Backend launch thread",
            from: "Sam Patel",
            fromEmail: "sam@helix.local",
            preview: "Backend search result preview",
            time: "2026-05-20T12:00:00.000Z",
            unread: true,
            starred: false,
            hasAttachment: false,
            messageCount: 1,
            labels: ["planning"],
            category: "primary",
            folder: "inbox",
            snoozedUntil: null,
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      });
      return;
    }
    if (pathname === "/api/tools/mail.filter.list") {
      await fulfillJson(route, { filters: [] });
      return;
    }
    if (pathname === "/api/tools/mail.vacation.get") {
      await fulfillJson(route, {
        vacation: {
          enabled: false,
          subject: "Out of office",
          body: "I am away right now.",
          startsAt: null,
          endsAt: null,
        },
      });
      return;
    }

    // The production shell calls GET /api/core-apps on mount; serve the
    // shared valid CoreAppShellStatus fixture so the shell never crashes.
    if (await fulfillCoreAppsRoute(route)) {
      return;
    }

    await fulfillJson(route, {});
  });
}

async function fulfillJson(route: Route, value: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
