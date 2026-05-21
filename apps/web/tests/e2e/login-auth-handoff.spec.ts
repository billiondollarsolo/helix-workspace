import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const clientId = "helix-local-oauth-client";
const clientSecret = "e2e-client-secret";
const accessToken = "e2e-login-token";
const expectedAuthorization = `Bearer ${accessToken}`;

interface BackendCall {
  readonly authorization: string | null;
  readonly method: string;
  readonly pathname: string;
}

interface TokenCall {
  readonly authorization: string | null;
  readonly body: Record<string, string>;
  readonly method: string;
}

test.describe("/login authenticated handoff", () => {
  test("stores the OAuth token and sends it on the first backend call after navigation", async ({
    page,
  }) => {
    const tokenCalls: TokenCall[] = [];
    const backendCalls: BackendCall[] = [];
    let resolveFirstBackendCall: (call: BackendCall) => void;
    const firstBackendCall = new Promise<BackendCall>((resolve) => {
      resolveFirstBackendCall = resolve;
    });

    await mockTokenEndpoint(page, tokenCalls, {
      status: 200,
      body: {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "platform.read mail.read chat.read docs.read drive.read calendar.read",
      },
    });
    await mockBackendApi(page, backendCalls, (call) => resolveFirstBackendCall(call));

    await page.goto("/login");
    await page.getByLabel("Client secret").fill(clientSecret);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/mail(?:[/?#]|$)/);
    await expect(page.getByRole("main", { name: "Mail" })).toBeVisible();
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), accessTokenStorageKey))
      .toBe(accessToken);

    const firstCall = await firstBackendCall;
    expect(firstCall.authorization).toBe(expectedAuthorization);
    expect(firstCall.pathname).toBe("/api/tools/mail.search");
    expect(backendCalls[0]).toEqual(firstCall);
    expect(tokenCalls).toEqual([
      {
        authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        body: {
          grant_type: "client_credentials",
          scope: "platform.read mail.read chat.read docs.read drive.read calendar.read",
        },
        method: "POST",
      },
    ]);
  });

  test("shows the token error and stays on login when OAuth token exchange fails", async ({
    page,
  }) => {
    const tokenCalls: TokenCall[] = [];
    const backendCalls: BackendCall[] = [];

    await mockTokenEndpoint(page, tokenCalls, {
      status: 401,
      body: { error: "invalid_client", error_description: "Invalid client secret." },
    });
    await mockBackendApi(page, backendCalls);

    await page.goto("/login");
    await page.getByLabel("Client secret").fill(clientSecret);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toHaveText("Invalid client secret.");
    await expect(page).toHaveURL(/\/login(?:[/?#]|$)/);
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), accessTokenStorageKey))
      .toBeNull();
    expect(backendCalls).toEqual([]);
    expect(tokenCalls).toHaveLength(1);
  });
});

async function mockTokenEndpoint(
  page: Page,
  tokenCalls: TokenCall[],
  response: { readonly status: number; readonly body: unknown },
) {
  await page.route("**/oauth/token", async (route) => {
    const request = route.request();
    tokenCalls.push({
      authorization: request.headers().authorization ?? null,
      body: Object.fromEntries(new URLSearchParams(request.postData() ?? "")),
      method: request.method(),
    });

    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: JSON.stringify(response.body),
    });
  });
}

async function mockBackendApi(
  page: Page,
  backendCalls: BackendCall[],
  onBackendCall?: (call: BackendCall) => void,
) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const call = {
      authorization: request.headers().authorization ?? null,
      method: request.method(),
      pathname: new URL(request.url()).pathname,
    } satisfies BackendCall;
    backendCalls.push(call);
    onBackendCall?.(call);

    if (call.authorization !== expectedAuthorization) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "missing bearer token" }),
      });
      return;
    }

    await fulfillMailTool(route, call.pathname);
  });
}

async function fulfillMailTool(route: Route, pathname: string) {
  // The production shell calls GET /api/core-apps on mount; serve the shared
  // valid CoreAppShellStatus fixture so the shell never white-screens.
  if (await fulfillCoreAppsRoute(route)) {
    return;
  }
  if (pathname === "/api/tools/mail.search") {
    await fulfillJson(route, { hits: [] });
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

  await fulfillJson(route, {});
}

async function fulfillJson(route: Route, value: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
