// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminUsersInfiniteQueryOptions,
  adminUsersQueryKeys,
  adminUsersQueryOptions,
  createAdminUser,
  inviteAdminUsers,
  listAdminUsers,
  prefetchAdminUsersQuery,
  suspendAdminUser,
  type AdminUsersListResponse,
} from "./admin-users";

describe("admin users API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds list params and validates the response shape", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(adminUsersPage({})));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(() => null) },
    });

    await expect(
      listAdminUsers({
        cursor: " cursor-3 ",
        includeDisabled: true,
        limit: 25,
        query: " Mina ",
        type: " user ",
      }),
    ).resolves.toEqual(adminUsersPage({}));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/v1/api/admin/users?query=Mina&type=user&includeDisabled=true&limit=25&cursor=cursor-3",
    );
  });

  it("posts create, invite, and suspend to the admin users write routes", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/v1/api/admin/users") {
        return Response.json({ user: adminUser() }, { status: 201 });
      }
      if (url === "/v1/api/admin/users/invites") {
        return Response.json({ status: "accepted", inviteCount: 1, skippedCount: 0 });
      }
      if (url.includes("/suspend")) {
        return Response.json({ suspend: { disabled: true } });
      }
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(() => null) },
    });

    await expect(
      createAdminUser({
        email: "mina@example.com",
        password: "correct-horse-battery-staple",
        displayName: "Mina Park",
      }),
    ).resolves.toMatchObject({ email: "mina@example.com" });
    await expect(inviteAdminUsers({ emails: ["ada@example.com"] })).resolves.toEqual({
      inviteCount: 1,
      skippedCount: 0,
    });
    await expect(suspendAdminUser("55555555-5555-4555-8555-555555555555")).resolves.toBeUndefined();

    const urls = fetchMock.mock.calls.map((call) => call[0]);
    expect(urls).toEqual([
      "/v1/api/admin/users",
      "/v1/api/admin/users/invites",
      "/v1/api/admin/users/55555555-5555-4555-8555-555555555555/suspend",
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  /* `sections/users.tsx` asks for `includeDisabled: true` while the app-password
   * and agent-credential actor pickers ask for `false`. If those collapsed to
   * one cache key the pickers would silently offer disabled actors. */
  it("keys the list query by every input that changes the response", () => {
    expect(adminUsersQueryKeys.list({ includeDisabled: true })).not.toEqual(
      adminUsersQueryKeys.list({ includeDisabled: false }),
    );
    expect(adminUsersQueryKeys.list({ query: " mina " })).toEqual(
      adminUsersQueryKeys.list({ query: "mina" }),
    );
    expect(adminUsersQueryOptions({ cursor: "cursor-2" }).queryKey).not.toEqual(
      adminUsersQueryOptions().queryKey,
    );
  });

  /* An infinite query caches `{ pages, pageParams }` where a plain one caches a
     single response. The audit-log actor picker reads `list` with the very same
     limit and includeDisabled the directory uses, so a shared key would hand it
     a paged object it would fail to read. */
  it("keeps the paged directory key out of the single-page key space", () => {
    const input = { includeDisabled: true, limit: 250 } as const;
    expect(adminUsersQueryKeys.infinite(input)).not.toEqual(adminUsersQueryKeys.list(input));
    expect(adminUsersQueryKeys.infinite({ ...input, query: "mina" })).not.toEqual(
      adminUsersQueryKeys.infinite(input),
    );
    // The cursor is the page param, not part of the query's identity — keying on
    // it would give every page its own cache entry and never accumulate.
    expect(adminUsersQueryKeys.infinite({ ...input, cursor: "cursor-2" })).toEqual(
      adminUsersQueryKeys.infinite(input),
    );
  });

  it("follows the route's cursor and stops when it runs out", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(adminUsersPage({ nextCursor: "cursor-2" })));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(() => null) },
    });

    const options = adminUsersInfiniteQueryOptions({ includeDisabled: true, limit: 250 });
    expect(
      options.getNextPageParam(adminUsersPage({ nextCursor: "cursor-2" }), [], undefined, []),
    ).toBe("cursor-2");
    // `null` means the server has nothing after this page; react-query needs
    // `undefined` to stop, and a null cursor sent back would 400.
    expect(
      options.getNextPageParam(adminUsersPage({ nextCursor: null }), [], undefined, []),
    ).toBeUndefined();

    const { queryFn } = options;
    if (typeof queryFn !== "function") {
      throw new Error("adminUsersInfiniteQueryOptions must define a queryFn");
    }
    await queryFn({
      queryKey: options.queryKey,
      pageParam: "cursor-2",
      signal: new AbortController().signal,
      client: undefined as never,
      direction: "forward",
      meta: undefined,
    });
    const requested = fetchMock.mock.calls[0]?.[0];
    expect(typeof requested === "string" ? requested : "").toContain("cursor=cursor-2");
  });

  it("prefetches the default admin users query with contained errors", async () => {
    const ensureQueryData = vi
      .fn<(options: ReturnType<typeof adminUsersQueryOptions>) => Promise<unknown>>()
      .mockRejectedValue(new Error("users unavailable"));

    await expect(prefetchAdminUsersQuery({ ensureQueryData })).resolves.toBeUndefined();

    expect(ensureQueryData).toHaveBeenCalledTimes(1);
  });
});

function adminUsersPage(input: { readonly nextCursor?: string | null }): AdminUsersListResponse {
  return {
    users: [
      adminUser(),
      adminUser({
        disabledAt: "2026-05-19T10:00:00.000Z",
        displayName: "",
        email: "disabled@example.com",
        id: "22222222-2222-4222-8222-222222222222",
        scopes: [],
        type: "agent",
      }),
    ],
    nextCursor: input.nextCursor ?? null,
  };
}

function adminUser(
  overrides: Partial<AdminUsersListResponse["users"][number]> = {},
): AdminUsersListResponse["users"][number] {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "99999999-9999-4999-8999-999999999999",
    type: "user",
    email: "mina@example.com",
    displayName: "Mina Jay",
    scopes: ["admin.users", "workspace.read"],
    disabledAt: null,
    createdAt: "2026-05-18T12:00:00.000Z",
    updatedAt: "2026-05-20T13:30:00.000Z",
    ...overrides,
  };
}
