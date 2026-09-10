// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { profileQueryOptions, updateProfile } from "./profile";

const profile = {
  actorId: "actor-1",
  orgId: "org-1",
  email: "morgan@example.com",
  displayName: "Morgan Lee",
  pronouns: "they/them",
  jobTitle: "Designer",
  about: "Hello",
};

afterEach(() => {
  document.cookie = "helix_csrf=; Max-Age=0; Path=/";
  vi.restoreAllMocks();
});

it("loads separate self/admin profiles and sends authenticated, CSRF-protected updates", async () => {
  const csrfToken = "p".repeat(43);
  document.cookie = `helix_csrf=${csrfToken}; Path=/`;
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() => Promise.resolve(Response.json({ profile })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await expect(client.fetchQuery(profileQueryOptions())).resolves.toEqual(profile);
    await expect(client.fetchQuery(profileQueryOptions("actor-1"))).resolves.toEqual(profile);
    const input = { displayName: "Morgan Lee", pronouns: "", jobTitle: "", about: "" };
    await updateProfile(input);
    await updateProfile(input, "actor-1");
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/v1/api/profile",
      "/v1/api/admin/users/actor-1/profile",
      "/v1/api/profile",
      "/v1/api/admin/users/actor-1/profile",
    ]);
    for (const [, init] of fetchMock.mock.calls.slice(2)) {
      expect(init?.method).toBe("PATCH");
      expect(init?.credentials).toBe("include");
      expect(new Headers(init?.headers).get("x-helix-csrf-token")).toBe(csrfToken);
      expect(init?.body).toBe(JSON.stringify(input));
    }
  } finally {
    client.clear();
  }
});

it("rejects incomplete profiles and preserves actionable server failures and retry hints", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ profile: { displayName: "Incomplete" } }))
    .mockResolvedValueOnce(
      Response.json(
        { error: { message: "Please retry shortly." } },
        { status: 429, headers: { "Retry-After": "3" } },
      ),
    );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await expect(client.fetchQuery(profileQueryOptions())).rejects.toThrow("incomplete profile");
    await expect(client.fetchQuery(profileQueryOptions())).rejects.toMatchObject({
      message: "Please retry shortly.",
      status: 429,
      retryAfterMs: 3000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    client.clear();
  }
});
