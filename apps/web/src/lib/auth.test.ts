// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticatedFetch,
  safeLoginReturnTo,
  getSessionUser,
  sessionUserQueryOptions,
  signInWithEmail,
  signInWithOidc,
  signOut,
} from "./auth";

describe("web auth helpers", () => {
  beforeEach(() => {
    document.cookie = "helix_csrf=; Max-Age=0; Path=/";
  });

  afterEach(() => {
    document.cookie = "helix_csrf=; Max-Age=0; Path=/";
    vi.restoreAllMocks();
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

  it("throws a clear error on bad credentials", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ message: "Invalid email or password" }, { status: 401 }));

    await expect(
      signInWithEmail({ email: "x@helix.local", password: "wrong" }, fetchMock),
    ).rejects.toThrow("Invalid email or password");
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
});
