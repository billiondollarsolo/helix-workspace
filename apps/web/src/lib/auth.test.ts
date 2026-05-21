// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HELIX_ACCESS_TOKEN_STORAGE_KEY,
  addAccessTokenSearchParam,
  authenticatedFetch,
  clearStoredAccessToken,
  requestOAuthClientCredentialsToken,
  storeAccessToken,
} from "./auth";

describe("web auth helpers", () => {
  afterEach(() => {
    clearStoredAccessToken();
    vi.restoreAllMocks();
  });

  it("attaches a stored bearer token to API requests", async () => {
    storeAccessToken("token-1");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true }));

    await authenticatedFetch("/api/tools/mail.search", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer token-1");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("keeps requests unchanged when no token is stored", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true }));
    const init = { method: "POST", headers: { "content-type": "application/json" } };

    await authenticatedFetch("/api/tools/mail.search", init);

    expect(fetchMock).toHaveBeenCalledWith("/api/tools/mail.search", init);
  });

  it("adds access_token to websocket URLs", () => {
    window.localStorage.setItem(HELIX_ACCESS_TOKEN_STORAGE_KEY, "ws-token");

    expect(addAccessTokenSearchParam("ws://localhost/ws/chat")).toBe(
      "ws://localhost/ws/chat?access_token=ws-token",
    );
  });

  it("mints and normalizes OAuth client credentials tokens", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: "token-1",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "platform.read",
      }),
    );

    const token = await requestOAuthClientCredentialsToken(
      {
        clientId: "client-1",
        clientSecret: "secret-1",
        scope: "platform.read",
      },
      fetchMock,
    );

    expect(token.accessToken).toBe("token-1");
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("/oauth/token");
    expect(call?.[1]?.method).toBe("POST");
    expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(
      "Basic Y2xpZW50LTE6c2VjcmV0LTE=",
    );
    expect(call?.[1]?.body).toBeInstanceOf(URLSearchParams);
    expect((call?.[1]?.body as URLSearchParams | undefined)?.toString()).toBe(
      "grant_type=client_credentials&scope=platform.read",
    );
  });
});
