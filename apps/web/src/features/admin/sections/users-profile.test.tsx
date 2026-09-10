// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUser } from "@/features/admin/admin-users";
import { profileQueryKeys, type UserProfile } from "@/lib/profile";
import { sessionQueryKeys } from "@/lib/auth";
import { AdminUsers } from "./users";

vi.mock("@tanstack/react-router", async () => ({
  ...(await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));

const humanId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";

function user(id: string, type = "user"): AdminUser {
  return {
    id,
    orgId: "org-1",
    type,
    email: `${id}@example.com`,
    displayName: id === humanId ? "Morgan Lee" : "Taylor Quinn",
    scopes: [],
    disabledAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
}

function profile(actor: AdminUser): UserProfile {
  return {
    actorId: actor.id,
    orgId: actor.orgId,
    email: actor.email,
    displayName: actor.displayName,
    pronouns: "they/them",
    jobTitle: "Engineer",
    about: "Building useful things.",
  };
}

describe("Admin user profiles", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let profiles: Map<string, UserProfile>;
  let saveError: string | undefined;
  let loadError: string | undefined;
  let updates: { path: string; body: Record<string, unknown> }[];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    document.cookie = "helix_csrf=profile-test; path=/";
    profiles = new Map();
    updates = [];
    saveError = undefined;
    loadError = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    document.cookie = "helix_csrf=; Max-Age=0; path=/";
    vi.unstubAllGlobals();
  });

  async function waitFor(assertion: () => void): Promise<void> {
    const start = Date.now();
    let error: unknown;
    while (Date.now() - start < 2000) {
      try {
        assertion();
        return;
      } catch (caught) {
        error = caught;
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    throw error;
  }

  function button(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll("button")].find(
      (node) => (node.getAttribute("aria-label") ?? node.textContent?.trim()) === label,
    );
    if (!match) throw new Error(`Missing button: ${label}`);
    return match;
  }

  async function click(label: string): Promise<void> {
    await act(() => {
      button(label).click();
      return Promise.resolve();
    });
  }

  function input(name: string): HTMLInputElement | HTMLTextAreaElement {
    const node = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[name="${name}"]`,
    );
    if (!node) throw new Error(`Missing profile field: ${name}`);
    return node;
  }

  async function change(name: string, value: string): Promise<void> {
    const node = input(name);
    await act(() => {
      const prototype =
        node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      return Promise.resolve();
    });
  }

  async function submit(): Promise<void> {
    const form = container.querySelector("form");
    if (!form) throw new Error("Missing profile form");
    await act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return Promise.resolve();
    });
  }

  async function renderUsers(actors: AdminUser[], pageSize = actors.length): Promise<void> {
    profiles = new Map(actors.map((actor) => [actor.id, profile(actor)]));
    fetchMock.mockImplementation((request, init) => {
      const href =
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      const url = new URL(href, "http://localhost");
      const match = /^\/v1\/api\/admin\/users\/([^/]+)\/profile$/u.exec(url.pathname);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        const current = profiles.get(id);
        if (!current)
          return Promise.resolve(Response.json({ error: "Profile not found" }, { status: 404 }));
        if (init?.method === "PATCH") {
          if (typeof init.body !== "string") throw new Error("Expected a JSON profile body");
          const body = JSON.parse(init.body) as Record<string, unknown>;
          updates.push({ path: url.pathname, body });
          if (saveError)
            return Promise.resolve(Response.json({ error: saveError }, { status: 403 }));
          const updated = { ...current, ...body };
          profiles.set(id, updated);
          return Promise.resolve(Response.json({ profile: updated }));
        }
        if (loadError) return Promise.resolve(Response.json({ error: loadError }, { status: 403 }));
        return Promise.resolve(Response.json({ profile: current }));
      }
      if (url.pathname !== "/v1/api/admin/users")
        throw new Error(`Unexpected request: ${url.pathname}`);
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const page = actors.slice(start, start + pageSize).map((actor) => ({
        ...actor,
        displayName: profiles.get(actor.id)!.displayName,
      }));
      return Promise.resolve(
        Response.json({
          users: page,
          nextCursor: start + page.length < actors.length ? String(start + page.length) : null,
        }),
      );
    });
    await act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AdminUsers />
        </QueryClientProvider>,
      );
      return Promise.resolve();
    });
    await waitFor(() =>
      expect(container.querySelector('input[aria-label="Select all users"]')).not.toBeNull(),
    );
    await waitFor(() => expect(container.textContent).toContain(actors[0]!.displayName));
  }

  it("offers accessible editing only for human users and cancels without writing", async () => {
    await renderUsers([
      user(humanId),
      user("agent-1", "agent"),
      user("service-1", "service_account"),
      user("system-1", "system"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const editButtons = container.querySelectorAll('button[aria-label^="Edit profile for"]');
    expect(editButtons).toHaveLength(1);
    const opener = button("Edit profile for Morgan Lee");
    opener.focus();
    await click("Edit profile for Morgan Lee");
    await waitFor(() => expect(input("displayName").value).toBe("Morgan Lee"));
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe("Edit profile for Morgan Lee");
    for (const name of ["displayName", "pronouns", "jobTitle", "about"]) {
      expect(container.querySelector(`label[for="${input(name).id}"]`)).not.toBeNull();
    }
    expect(
      container.querySelector('input[name="email"], input[name="scopes"], select[name="role"]'),
    ).toBeNull();
    await click("Cancel");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(updates).toHaveLength(0);
  });

  it("saves the selected later-page profile and refreshes directory and identity caches", async () => {
    await renderUsers([user(humanId), user(otherId)], 1);
    const peopleKey = ["people", "directory", {}] as const;
    queryClient.setQueryData(peopleKey, []);
    queryClient.setQueryData(profileQueryKeys.current, profile(user(otherId)));
    queryClient.setQueryData(sessionQueryKeys.current, { actorId: otherId, name: "Taylor Quinn" });
    await click("Load more");
    await waitFor(() => expect(container.textContent).toContain("Taylor Quinn"));
    await click("Edit profile for Taylor Quinn");
    await waitFor(() => expect(input("displayName").value).toBe("Taylor Quinn"));
    await change("displayName", "Taylor Rivera");
    await change("pronouns", "she/her");
    await change("jobTitle", "Team lead");
    await change("about", "");
    await submit();
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
    await waitFor(() => expect(container.textContent).toContain("Taylor Rivera"));
    expect(container.textContent).toContain("Morgan Lee");
    expect(updates).toEqual([
      {
        path: `/v1/api/admin/users/${otherId}/profile`,
        body: {
          displayName: "Taylor Rivera",
          pronouns: "she/her",
          jobTitle: "Team lead",
          about: "",
        },
      },
    ]);
    expect(
      queryClient.getQueryData<UserProfile>(profileQueryKeys.byActor(otherId))?.displayName,
    ).toBe("Taylor Rivera");
    expect(queryClient.getQueryState(peopleKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(profileQueryKeys.current)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(sessionQueryKeys.current)?.isInvalidated).toBe(true);
  });

  it("keeps edits available after a refused save", async () => {
    await renderUsers([user(humanId)]);
    await click("Edit profile for Morgan Lee");
    await waitFor(() => expect(input("displayName").value).toBe("Morgan Lee"));
    await change("displayName", "Morgan Rivera");
    saveError = "You no longer have permission to edit this profile.";
    await submit();
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(saveError),
    );
    expect(input("displayName").value).toBe("Morgan Rivera");
    expect(profiles.get(humanId)?.displayName).toBe("Morgan Lee");
    saveError = undefined;
    await submit();
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
    await waitFor(() => expect(container.textContent).toContain("Morgan Rivera"));
  });

  it("reports a profile load error and retries before allowing changes", async () => {
    await renderUsers([user(humanId)]);
    loadError = "Profile access was refused.";
    await click("Edit profile for Morgan Lee");
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(loadError),
    );
    expect(container.querySelector("form")).toBeNull();
    loadError = undefined;
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
      node.textContent?.includes("Retry"),
    );
    expect(retry).toBeDefined();
    await act(() => {
      retry?.click();
      return Promise.resolve();
    });
    await waitFor(() => expect(input("displayName").value).toBe("Morgan Lee"));
    expect(updates).toHaveLength(0);
  });
});
