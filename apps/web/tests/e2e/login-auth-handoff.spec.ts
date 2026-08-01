import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const sessionCookieName = "helix_session";
const sessionCookieValue = "e2e-session";
const expectedCookie = `${sessionCookieName}=${sessionCookieValue}`;

interface BackendCall {
  readonly authorization: string | null;
  readonly cookie: string | null;
  readonly method: string;
  readonly pathname: string;
}

interface SignInCall {
  readonly body: Record<string, unknown>;
  readonly method: string;
  readonly pathname: string;
}

const sessionUser = {
  id: "user-1",
  email: "admin@helix.local",
  name: "Admin",
  actorId: "actor-1",
};

test.describe("/login authenticated handoff", () => {
  test("signs in with local email/password and sends the session cookie on backend calls", async ({
    page,
  }) => {
    const signInCalls: SignInCall[] = [];
    const backendCalls: BackendCall[] = [];
    let resolveFirstBackendCall: (call: BackendCall) => void;
    const firstBackendCall = new Promise<BackendCall>((resolve) => {
      resolveFirstBackendCall = resolve;
    });

    await mockAppApi(page, {
      backendCalls,
      signInCalls,
      signInResponse: { status: 200, body: { user: sessionUser } },
      onBackendCall: (call) => resolveFirstBackendCall(call),
    });

    await page.goto("/login");
    await expect(page.getByText("Local email/password login")).toBeVisible();
    await expect(page.getByText("Email + password")).toBeVisible();

    await page.getByLabel("Email", { exact: true }).fill(" admin@helix.local ");
    await page.getByLabel("Password", { exact: true }).fill("helix-admin-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/mail(?:[/?#]|$)/);
    await expect(
      page.getByRole("textbox", {
        name: "Search mail (try from:mira, has:attachment, label:urgent)",
      }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), accessTokenStorageKey))
      .toBeNull();

    const firstCall = await firstBackendCall;
    expect(firstCall.authorization).toBeNull();
    expect(firstCall.cookie).toContain(expectedCookie);
    expect(firstCall.pathname).toMatch(/^\/api\//);
    expect(backendCalls[0]).toEqual(firstCall);
    expect(signInCalls).toEqual([
      {
        body: {
          email: "admin@helix.local",
          password: "helix-admin-password",
        },
        method: "POST",
        pathname: "/api/auth/sign-in/email",
      },
    ]);
  });

  test("shows the local sign-in error and stays on login when email/password auth fails", async ({
    page,
  }) => {
    const signInCalls: SignInCall[] = [];
    const backendCalls: BackendCall[] = [];

    await mockAppApi(page, {
      backendCalls,
      signInCalls,
      signInResponse: {
        status: 401,
        body: { error: "Invalid email or password." },
      },
    });

    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill("admin@helix.local");
    await page.getByLabel("Password", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toHaveText("Invalid email or password.");
    await expect(page).toHaveURL(/\/login(?:[/?#]|$)/);
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), accessTokenStorageKey))
      .toBeNull();
    expect(backendCalls).toEqual([]);
    expect(signInCalls).toEqual([
      {
        body: {
          email: "admin@helix.local",
          password: "wrong-password",
        },
        method: "POST",
        pathname: "/api/auth/sign-in/email",
      },
    ]);
  });
});

async function mockAppApi(
  page: Page,
  options: {
    readonly backendCalls: BackendCall[];
    readonly signInCalls: SignInCall[];
    readonly signInResponse: { readonly status: number; readonly body: unknown };
    readonly onBackendCall?: (call: BackendCall) => void;
  },
): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/auth/get-session") {
      await fulfillJson(
        route,
        request.headers().cookie?.includes(expectedCookie) ? { user: sessionUser } : {},
      );
      return;
    }

    if (pathname === "/api/auth/sign-in/email") {
      options.signInCalls.push({
        body: JSON.parse(request.postData() ?? "{}") as Record<string, unknown>,
        method: request.method(),
        pathname,
      });
      await route.fulfill({
        status: options.signInResponse.status,
        contentType: "application/json",
        headers:
          options.signInResponse.status >= 200 && options.signInResponse.status < 300
            ? { "set-cookie": `${expectedCookie}; Path=/; HttpOnly; SameSite=Lax` }
            : {},
        body: JSON.stringify(options.signInResponse.body),
      });
      return;
    }

    const call = {
      authorization: request.headers().authorization ?? null,
      cookie: request.headers().cookie ?? null,
      method: request.method(),
      pathname,
    } satisfies BackendCall;
    options.backendCalls.push(call);
    options.onBackendCall?.(call);

    if (!call.cookie?.includes(expectedCookie)) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "missing session cookie" }),
      });
      return;
    }

    await fulfillMailTool(route, pathname);
  });
}

async function fulfillMailTool(route: Route, pathname: string): Promise<void> {
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

async function fulfillJson(route: Route, value: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
