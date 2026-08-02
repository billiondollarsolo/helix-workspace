import { describe, expect, it } from "vitest";
import { InMemoryMeetRateLimiter } from "./rate-limit.js";

describe("InMemoryMeetRateLimiter (MT.6)", () => {
  it("allows creates under budget and then rejects", async () => {
    let now = 1_000_000;
    const limiter = new InMemoryMeetRateLimiter({
      now: () => now,
      budget: { createRoomLimit: 2, joinRoomLimit: 5, windowMs: 60_000 },
    });
    const base = { orgId: "org-1", actorId: "actor-1", action: "create_room" as const };
    expect((await limiter.consume(base)).allowed).toBe(true);
    expect((await limiter.consume(base)).allowed).toBe(true);
    const blocked = await limiter.consume(base);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.code).toBe("meet_rate_limited");
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("isolates rate limits per org and actor (tenant boundary)", async () => {
    const limiter = new InMemoryMeetRateLimiter({
      budget: { createRoomLimit: 1, joinRoomLimit: 1, windowMs: 60_000 },
    });
    expect(
      (await limiter.consume({ orgId: "a", actorId: "u1", action: "join_room" })).allowed,
    ).toBe(true);
    expect(
      (await limiter.consume({ orgId: "a", actorId: "u1", action: "join_room" })).allowed,
    ).toBe(false);
    expect(
      (await limiter.consume({ orgId: "b", actorId: "u1", action: "join_room" })).allowed,
    ).toBe(true);
  });
});
