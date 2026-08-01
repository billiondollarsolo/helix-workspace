// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminUsersQueryKeys,
  adminUsersQueryOptions,
  listAdminUsers,
  prefetchAdminUsersQuery,
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
      "/api/admin/users?query=Mina&type=user&includeDisabled=true&limit=25&cursor=cursor-3",
    );
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
