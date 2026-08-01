import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthFetch } from "@/lib/auth";
import { fetchCoreAppsShellStatus, setCoreAppEnabled } from "./core-apps-api";

describe("core-apps-api", () => {
  let fetchImpl: ReturnType<typeof vi.fn<AuthFetch>>;

  beforeEach(() => {
    fetchImpl = vi.fn<AuthFetch>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches the shell core-app status from /api/core-apps", async () => {
    fetchImpl.mockResolvedValue(
      new Response(
        JSON.stringify({
          role: "all",
          apps: [{ id: "mail", name: "Mail", enabled: true, registered: true }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const status = await fetchCoreAppsShellStatus(fetchImpl);
    expect(status.role).toBe("all");
    expect(status.apps[0]?.id).toBe("mail");
    expect(fetchImpl).toHaveBeenCalledWith("/api/core-apps", { method: "GET" });
  });

  it("PATCHes the admin toggle endpoint with the enabled flag", async () => {
    fetchImpl.mockResolvedValue(
      new Response(
        JSON.stringify({
          role: "all",
          apps: [],
          changed: { appId: "chat", from: true, to: false, requiresRestart: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await setCoreAppEnabled("chat", false, fetchImpl);
    expect(result.changed.to).toBe(false);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/admin/core-apps/chat");
    expect(init?.method).toBe("PATCH");
    expect(init?.body).toBe(JSON.stringify({ enabled: false }));
  });

  it("fails safe to a well-formed empty status when /api/core-apps returns junk", async () => {
    // A malformed body (here `{}`) must never reach the shell as an `undefined`
    // `apps` array — that previously white-screened the entire app.
    fetchImpl.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const status = await fetchCoreAppsShellStatus(fetchImpl);
    expect(Array.isArray(status.apps)).toBe(true);
    expect(status.apps).toHaveLength(0);
    expect(status.role).toBe("unknown");
  });

  it("fails safe when /api/core-apps returns a non-JSON / non-object body", async () => {
    fetchImpl.mockResolvedValue(
      new Response("<!doctype html><html>error page</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const status = await fetchCoreAppsShellStatus(fetchImpl);
    expect(status.apps).toEqual([]);
  });

  it("fails safe when /api/core-apps apps entries are malformed", async () => {
    fetchImpl.mockResolvedValue(
      new Response(JSON.stringify({ role: "all", apps: [{ id: "mail" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const status = await fetchCoreAppsShellStatus(fetchImpl);
    expect(status.apps).toEqual([]);
  });

  it("throws a descriptive error on a non-OK response", async () => {
    fetchImpl.mockResolvedValue(
      new Response(JSON.stringify({ error: "Unknown core app." }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(setCoreAppEnabled("mail", false, fetchImpl)).rejects.toThrow(/Unknown core app/u);
  });
});
