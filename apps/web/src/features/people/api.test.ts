import { describe, expect, it, vi } from "vitest";
import { listPeopleDirectory, peopleSearchQueryOptions } from "./api";

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authenticatedFetch }));

describe("people directory API", () => {
  it("lists people through the authenticated directory route", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          people: [
            {
              id: "contact-1",
              email: "ada@example.com",
              displayName: "Ada Lovelace",
              kind: "personal",
              actorId: "actor-1",
              title: "Analyst",
              favorite: true,
              avatarDataUrl: null,
              relationship: { manager: "Grace Hopper" },
            },
          ],
        }),
      ),
    );

    await expect(listPeopleDirectory({ limit: 10, query: "ada" }, fetchImpl)).resolves.toEqual([
      {
        id: "contact-1",
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        kind: "personal",
        actorId: "actor-1",
        title: "Analyst",
        favorite: true,
        avatarDataUrl: null,
        relationship: { manager: "Grace Hopper" },
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith("/api/people?limit=10&query=ada");
  });

  it("treats a directory row as its own actor when the server omits actorId", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          people: [{ id: "actor-2", email: null, displayName: "Grace", kind: "directory" }],
        }),
      ),
    );

    await expect(listPeopleDirectory({}, fetchImpl)).resolves.toMatchObject([
      { actorId: "actor-2", title: null },
    ]);
  });

  it("rejects malformed people directory responses", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ people: [{ id: "actor-1" }] })));

    await expect(listPeopleDirectory({}, fetchImpl)).rejects.toThrow(
      "People directory response was missing required fields.",
    );
  });

  it("searches the tenant autocomplete route with a per-query cache key", async () => {
    authenticatedFetch.mockResolvedValue(Response.json({ people: [] }));
    const options = peopleSearchQueryOptions("ada l");

    expect(options.queryKey).toEqual(["people", "search", "ada l"]);
    expect(peopleSearchQueryOptions("").enabled).toBe(false);
    await expect(options.queryFn()).resolves.toEqual([]);
    expect(authenticatedFetch).toHaveBeenCalledWith(
      "/api/people/autocomplete?query=ada+l&limit=12",
    );
  });

  it("surfaces server errors", async () => {
    authenticatedFetch.mockResolvedValue(
      Response.json({ error: "invalid_people_query" }, { status: 400 }),
    );

    await expect(peopleSearchQueryOptions("x").queryFn()).rejects.toThrow("invalid_people_query");
  });
});
