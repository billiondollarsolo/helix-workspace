// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HELIX_ACCESS_TOKEN_STORAGE_KEY,
  addAccessTokenSearchParam,
  authenticatedFetch,
  clearStoredAccessToken,
  getSessionUser,
  signInWithEmail,
  signOut,
  storeAccessToken,
} from "./auth";

describe("web auth helpers", () => {
  afterEach(() => {
    clearStoredAccessToken();
    vi.restoreAllMocks();
  });

  it("sends the session cookie on backend requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));

    await authenticatedFetch("/api/tools/mail.search", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("include");
  });

  it("attaches a stored fallback bearer token when present", async () => {
    storeAccessToken("token-1");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));

    await authenticatedFetch("/api/tools/mail.search", { method: "POST" });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer token-1");
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("include");
  });

  it("adds a fallback access_token to websocket URLs only when stored", () => {
    expect(addAccessTokenSearchParam("ws://localhost/ws/chat")).toBe("ws://localhost/ws/chat");
    window.localStorage.setItem(HELIX_ACCESS_TOKEN_STORAGE_KEY, "ws-token");
    expect(addAccessTokenSearchParam("ws://localhost/ws/chat")).toBe(
      "ws://localhost/ws/chat?access_token=ws-token",
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

  it("returns null when there is no active session", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(null));
    expect(await getSessionUser(fetchMock)).toBeNull();
  });

  it("resolves the session user when authenticated", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ user: { id: "login-1", email: "a@helix.local", name: "A", actor_id: "ac" } }),
    );
    const user = await getSessionUser(fetchMock);
    expect(user?.actorId).toBe("ac");
  });

  it("posts to the Better-Auth sign-out endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true }));
    await signOut(fetchMock);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("/api/auth/sign-out");
    expect(call?.[1]?.method).toBe("POST");
  });
});
