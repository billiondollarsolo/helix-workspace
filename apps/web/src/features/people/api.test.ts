import { describe, expect, it, vi } from "vitest";
import { listPeopleDirectory } from "./api";

describe("people directory API", () => {
  it("lists people through the authenticated directory route", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          people: [
            {
              id: "actor-1",
              email: "ada@example.com",
              displayName: "Ada Lovelace",
            },
          ],
        }),
      ),
    );

    await expect(listPeopleDirectory({ limit: 10, query: "ada" }, fetchImpl)).resolves.toEqual([
      {
        id: "actor-1",
        email: "ada@example.com",
        displayName: "Ada Lovelace",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith("/api/people?limit=10&query=ada");
  });

  it("rejects malformed people directory responses", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ people: [{ id: "actor-1" }] })));

    await expect(listPeopleDirectory({}, fetchImpl)).rejects.toThrow(
      "People directory response was missing required fields.",
    );
  });
});
