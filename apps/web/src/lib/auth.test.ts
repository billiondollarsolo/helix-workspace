// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticatedFetch,
  safeLoginReturnTo,
  getSessionUser,
  sessionUserQueryOptions,
  discoverSignInMethod,
  signInWithEmail,
  WRONG_CREDENTIALS_MESSAGE,
  signInWithOidc,
  signOut,
} from "./auth";
import { familyAuthorizationQuery } from "./family-auth";
import { settleSecondFactorStepUp, subscribeSecondFactorStepUp } from "./second-factor-step-up";

describe("web auth helpers", () => {
  beforeEach(() => {
    document.cookie = "helix_csrf=; Max-Age=0; Path=/";
  });

  afterEach(() => {
    document.cookie = "helix_csrf=; Max-Age=0; Path=/";
    vi.restoreAllMocks();
  });

  it("preserves only provider-declared signed authorization fields", () => {
    expect(
      familyAuthorizationQuery(
        "?client_id=app&ba_param=client_id&sig=proof&returnTo=https://evil.test&extra=ignored",
      ),
    ).toBe("client_id=app&ba_param=client_id&sig=proof");
    expect(familyAuthorizationQuery("?client_id=app&ba_param=client_id")).toBeUndefined();
    expect(familyAuthorizationQuery("?sig=proof")).toBeUndefined();
  });

  it("keeps login return paths local and prevents login redirect loops", () => {
    expect(safeLoginReturnTo("/admin?tab=users#selected")).toBe("/admin?tab=users#selected");
    for (const value of [
      undefined,
      "https://evil.test",
      "//evil.test",
      "/\\evil.test",
      "/login?returnTo=/admin",
      "javascript:alert(1)",
    ])
      expect(safeLoginReturnTo(value)).toBe("/mail");
  });

  it("sends the session cookie on backend requests", async () => {
    const csrfToken = "a".repeat(43);
    document.cookie = `helix_csrf=${csrfToken}; Path=/`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));

    await authenticatedFetch("/api/tools/mail.search", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("include");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-helix-csrf-token")).toBe(
      csrfToken,
    );
  });

  it("bootstraps a CSRF token before the first mutation", async () => {
    const csrfToken = "c".repeat(43);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ csrfToken }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await authenticatedFetch("/api/tools/mail.search", { method: "POST" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/v1/api/auth/csrf-token");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/v1/api/tools/mail.search");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("x-helix-csrf-token")).toBe(
      csrfToken,
    );
  });

  it("signs in with email and password against Better-Auth", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        user: {
          id: "login-1",
          email: "admin@helix.local",
          name: "Avery Park",
          actorId: "actor-1",
        },
      }),
    );

    const user = await signInWithEmail(
      { email: "admin@helix.local", password: "helix-admin-password" },
      fetchMock,
    );

    expect(user.actorId).toBe("actor-1");
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("/api/auth/sign-in/email");
    expect(call?.[1]?.method).toBe("POST");
    expect(call?.[1]?.credentials).toBe("include");
  });

  it("answers every credential failure with one message that hides whether the account exists", async () => {
    for (const [status, message] of [
      [401, "Invalid email or password"],
      [400, "User not found"],
    ] as const) {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ message }, { status }));
      await expect(
        signInWithEmail({ email: "x@helix.local", password: "wrong" }, fetchMock),
      ).rejects.toThrow(WRONG_CREDENTIALS_MESSAGE);
    }
    const limited = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ message: "Too many attempts" }, { status: 429 }));
    await expect(
      signInWithEmail({ email: "x@helix.local", password: "wrong" }, limited),
    ).rejects.toThrow("Too many attempts");
  });

  it("routes only managed OIDC domains to SSO and falls back to password", async () => {
    const managed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ managed: true, protocol: "oidc" }));
    await expect(discoverSignInMethod(" Ana@Corp.example ", managed)).resolves.toBe("sso");
    expect(JSON.parse(managed.mock.calls[0]?.[1]?.body as string)).toEqual({
      email: "ana@corp.example",
    });
    const unmanaged = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ managed: false }));
    await expect(discoverSignInMethod("a@b.example", unmanaged)).resolves.toBe("password");
    const failing = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
    await expect(discoverSignInMethod("a@b.example", failing)).resolves.toBe("password");
  });

  it("discovers a managed domain before starting tenant OIDC", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ managed: true, protocol: "oidc" }))
      .mockResolvedValueOnce(
        Response.json({ url: "https://idp.example.com/authorize", redirect: true }),
      );
    const navigate = vi.fn();
    await signInWithOidc(" Member@Acme.Example ", fetchMock, navigate);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/domain-discovery",
      "/api/auth/sign-in/sso",
    ]);
    expect(
      JSON.parse(
        typeof fetchMock.mock.calls[1]?.[1]?.body === "string"
          ? fetchMock.mock.calls[1][1].body
          : "",
      ),
    ).toMatchObject({
      email: "member@acme.example",
      providerType: "oidc",
      requestSignUp: false,
    });
    expect(navigate).toHaveBeenCalledWith("https://idp.example.com/authorize");
  });

  it("does not start SSO for an unmanaged or unsupported domain", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ managed: false, protocol: null }));
    await expect(signInWithOidc("guest@example.com", fetchMock, vi.fn())).rejects.toThrow(
      "not configured",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when there is no active session", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(null));
    expect(await getSessionUser(fetchMock)).toBeNull();
  });

  it.each([429, 500, 502, 503, 504])(
    "reports HTTP %s session lookup failures without treating them as sign-out",
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("Backend unavailable", { status }));
      await expect(getSessionUser(fetchMock)).rejects.toMatchObject({
        status,
        message: expect.stringContaining("check your session"),
      });
    },
  );

  it("reads the actor's scopes from the session, keeping only strings", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        user: {
          id: "user-1",
          name: "A",
          email: "a@example.test",
          actorId: "actor-1",
          scopes: ["mail.read", 7, "admin.users.read"],
        },
      }),
    );
    await expect(getSessionUser(fetchMock)).resolves.toMatchObject({
      actorId: "actor-1",
      scopes: ["mail.read", "admin.users.read"],
    });
    fetchMock.mockResolvedValue(
      Response.json({ user: { id: "user-1", name: "A", email: "a@example.test" } }),
    );
    expect(await getSessionUser(fetchMock)).not.toHaveProperty("scopes");
  });

  it("treats a real unauthorized session as signed out", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(getSessionUser(fetchMock)).resolves.toBeNull();
  });

  it.each([
    "<html>Proxy response</html>",
    "not JSON",
    "{}",
    "[]",
    "true",
    "42",
    '"session"',
    '{"user":null}',
    '{"user":{}}',
    '{"user":{"id":123,"name":"A","email":"a@example.test"}}',
    '{"user":{"id":"","name":"A","email":"a@example.test"}}',
    '{"user":{"id":"user-1"}}',
    '{"id":"user-1","name":"A","email":"a@example.test"}',
  ])("preserves authentication when HTTP200 contains malformed payload %s", async (body) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(getSessionUser(fetchMock)).rejects.toMatchObject({
      status: 200,
      message: expect.stringContaining("Unable to check your session"),
    });
  });

  it("does not mistake a network outage for a signed-out session", async () => {
    await expect(
      getSessionUser(vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"))),
    ).rejects.toThrow("Failed to fetch");
  });

  it("resolves the session user when authenticated", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        user: { id: "login-1", email: "a@helix.local", name: "A", actor_id: "ac" },
      }),
    );
    const user = await getSessionUser(fetchMock);
    expect(user?.actorId).toBe("ac");
  });

  it("keeps the shared verified session during failed stale revalidation and recovers", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = { id: "session-user", email: "member@example.test", name: "Samara" };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ user }))
      .mockResolvedValueOnce(new Response("Restarting", { status: 502 }))
      .mockResolvedValueOnce(Response.json({ user }));
    const options = {
      ...sessionUserQueryOptions(),
      queryFn: () => getSessionUser(fetchMock),
      staleTime: 0,
    };
    try {
      await client.fetchQuery(options);
      await expect(
        client.ensureQueryData({ ...options, revalidateIfStale: true }),
      ).resolves.toMatchObject(user);
      await vi.waitFor(() => expect(client.getQueryState(options.queryKey)?.status).toBe("error"));
      expect(client.getQueryData(options.queryKey)).toMatchObject(user);
      await expect(client.fetchQuery(options)).resolves.toMatchObject(user);
      expect(client.getQueryState(options.queryKey)?.status).toBe("success");
    } finally {
      client.clear();
    }
  });

  it("posts to the Better-Auth sign-out endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true }));
    await signOut(fetchMock);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("/api/auth/sign-out");
    expect(call?.[1]?.method).toBe("POST");
  });

  it("asks for 2-step verification and resends a refused administrator request", async () => {
    document.cookie = `helix_csrf=${"d".repeat(43)}; Path=/`;
    const unsubscribe = subscribeSecondFactorStepUp(() => {
      queueMicrotask(() => settleSecondFactorStepUp(true));
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ error: { code: "admin_mfa_required" } }, { status: 403 }),
      )
      .mockResolvedValueOnce(Response.json({ invited: true }, { status: 201 }));

    const response = await authenticatedFetch("/api/admin/users/invite", {
      method: "POST",
      body: JSON.stringify({ email: "new@example.com" }),
    });
    unsubscribe();

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(fetchMock.mock.calls[0]?.[1]?.body);
  });

  it("verifies a lapsed admin session in place instead of leaving the page", async () => {
    const unsubscribe = subscribeSecondFactorStepUp(() => {
      queueMicrotask(() => settleSecondFactorStepUp(true));
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ error: { code: "session_reauthentication_required" } }, { status: 401 }),
      )
      .mockResolvedValueOnce(Response.json({ users: [] }));

    const response = await authenticatedFetch("/api/admin/users");
    unsubscribe();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(window.location.pathname).not.toBe("/login");
  });

  it("returns the refusal when the person does not verify", async () => {
    const unsubscribe = subscribeSecondFactorStepUp(() => {
      queueMicrotask(() => settleSecondFactorStepUp(false));
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ error: { code: "admin_mfa_required" } }, { status: 403 }));

    const response = await authenticatedFetch("/api/admin/users");
    unsubscribe();

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-verifies once when concurrent requests hit an expired session", async () => {
    vi.resetModules();
    const { authenticatedFetch: freshFetch } = await import("./auth");
    const replace = vi.fn();
    vi.stubGlobal("location", {
      pathname: "/admin/users",
      search: "",
      hash: "#directory",
      replace,
    });
    const expired = () =>
      Response.json(
        { error: { code: "session_reauthentication_required", message: "Sign in again." } },
        { status: 401 },
      );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(expired());
    const settled = vi.fn();
    try {
      // Both requests are in flight before either 401 arrives.
      void Promise.all([freshFetch("/api/admin/users"), freshFetch("/api/admin/users")]).then(
        settled,
        settled,
      );
      await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
      // A request issued while the sign-in page loads never reaches the server.
      void freshFetch("/api/admin/groups").then(settled, settled);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(replace).toHaveBeenCalledExactlyOnceWith(
        "/login?reauthenticate=true&returnTo=%2Fadmin%2Fusers%23directory",
      );
      expect(settled).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
