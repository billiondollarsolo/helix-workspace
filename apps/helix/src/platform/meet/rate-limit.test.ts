import { describe, expect, it } from "vitest";
import { InMemoryMeetRateLimiter, meetRateLimitError } from "./rate-limit.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const otherActor = "33333333-3333-4333-8333-333333333333";
const otherOrg = "44444444-4444-4444-8444-444444444444";

describe("Meet abuse rate limits (MT.6)", () => {
  it("limits create_room per org+actor independently of join_room", async () => {
    const now = 1_000;
    const limiter = new InMemoryMeetRateLimiter({
      now: () => now,
      budget: { createRoomLimit: 2, joinRoomLimit: 3, windowMs: 60_000 },
    });

    await expect(limiter.consume({ orgId, actorId, action: "create_room" })).resolves.toMatchObject(
      { allowed: true, used: 1, remaining: 1 },
    );
    await expect(limiter.consume({ orgId, actorId, action: "create_room" })).resolves.toMatchObject(
      { allowed: true, used: 2, remaining: 0 },
    );
    const blocked = await limiter.consume({ orgId, actorId, action: "create_room" });
    expect(blocked).toMatchObject({
      allowed: false,
      code: "meet_rate_limited",
      action: "create_room",
      remaining: 0,
    });
    if (blocked.allowed) {
      throw new Error("expected block");
    }
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    // Join bucket is independent.
    await expect(limiter.consume({ orgId, actorId, action: "join_room" })).resolves.toMatchObject({
      allowed: true,
      used: 1,
    });
  });

  it("scopes limits by actor and org (no cross-tenant bleed)", async () => {
    const limiter = new InMemoryMeetRateLimiter({
      budget: { createRoomLimit: 1, joinRoomLimit: 1, windowMs: 60_000 },
    });

    await expect(limiter.consume({ orgId, actorId, action: "create_room" })).resolves.toMatchObject(
      { allowed: true },
    );
    await expect(limiter.consume({ orgId, actorId, action: "create_room" })).resolves.toMatchObject(
      { allowed: false },
    );

    await expect(
      limiter.consume({ orgId, actorId: otherActor, action: "create_room" }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      limiter.consume({ orgId: otherOrg, actorId, action: "create_room" }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("resets after the window elapses", async () => {
    let now = 10_000;
    const limiter = new InMemoryMeetRateLimiter({
      now: () => now,
      budget: { createRoomLimit: 1, joinRoomLimit: 1, windowMs: 5_000 },
    });

    await expect(limiter.consume({ orgId, actorId, action: "join_room" })).resolves.toMatchObject({
      allowed: true,
    });
    await expect(limiter.consume({ orgId, actorId, action: "join_room" })).resolves.toMatchObject({
      allowed: false,
    });

    now += 5_000;
    await expect(limiter.consume({ orgId, actorId, action: "join_room" })).resolves.toMatchObject({
      allowed: true,
      used: 1,
    });
  });

  it("builds a structured MeetRateLimitError", () => {
    const error = meetRateLimitError({
      allowed: false,
      limit: 10,
      used: 10,
      remaining: 0,
      retryAfterSeconds: 42,
      resetsAt: new Date("2026-05-20T13:00:00.000Z"),
      action: "create_room",
      code: "meet_rate_limited",
      message: "too many creates",
    });
    expect(error.name).toBe("MeetRateLimitError");
    expect(error.message).toBe("too many creates");
    expect(error).toMatchObject({
      code: "meet_rate_limited",
      retryAfterSeconds: 42,
      action: "create_room",
    });
  });

  it("rejects non-positive budgets instead of silently disabling protection", () => {
    expect(() => new InMemoryMeetRateLimiter({ budget: { createRoomLimit: 0 } })).toThrow(
      "createRoomLimit",
    );
  });
});
