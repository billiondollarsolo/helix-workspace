import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_EVENT_STREAMS_PER_ORG, EventStreamLimiter } from "./stream-limit.js";

describe("EventStreamLimiter", () => {
  it("admits connections up to the ceiling and refuses the next one", () => {
    const limiter = new EventStreamLimiter({ maxPerOrg: 2 });

    expect(limiter.acquire("org-a")).not.toBeNull();
    expect(limiter.acquire("org-a")).not.toBeNull();
    // `/events/ws` no longer pays the request-rate meter, so this refusal is the
    // only thing standing between one workspace and every socket in the process.
    expect(limiter.acquire("org-a")).toBeNull();
  });

  it("counts each org separately", () => {
    const limiter = new EventStreamLimiter({ maxPerOrg: 1 });

    expect(limiter.acquire("org-a")).not.toBeNull();
    // One tenant exhausting its own ceiling must not lock another tenant out.
    expect(limiter.acquire("org-b")).not.toBeNull();
    expect(limiter.acquire("org-a")).toBeNull();
  });

  it("frees the slot when the lease is released", () => {
    const limiter = new EventStreamLimiter({ maxPerOrg: 1 });

    const release = limiter.acquire("org-a");
    expect(release).not.toBeNull();
    expect(limiter.acquire("org-a")).toBeNull();

    release?.();
    expect(limiter.activeFor("org-a")).toBe(0);
    expect(limiter.acquire("org-a")).not.toBeNull();
  });

  it("ignores a repeated release", () => {
    const limiter = new EventStreamLimiter({ maxPerOrg: 2 });

    const first = limiter.acquire("org-a");
    limiter.acquire("org-a");
    expect(limiter.activeFor("org-a")).toBe(2);

    /* A socket can emit both `error` and `close`. Without the idempotency guard
       each flap would hand the org a free slot back, and the count would drift
       below the real number of open sockets until the cap meant nothing. */
    first?.();
    first?.();
    first?.();
    expect(limiter.activeFor("org-a")).toBe(1);
  });

  it("forgets orgs that have no open streams", () => {
    const limiter = new EventStreamLimiter({ maxPerOrg: 4 });

    const release = limiter.acquire("org-a");
    release?.();

    // A map entry per org that ever connected is a slow leak in a long-lived
    // process, so the counter is deleted rather than parked at zero.
    expect(limiter.activeFor("org-a")).toBe(0);
  });

  it("defaults to a documented per-org ceiling", () => {
    const limiter = new EventStreamLimiter();
    for (let index = 0; index < DEFAULT_MAX_EVENT_STREAMS_PER_ORG; index += 1) {
      expect(limiter.acquire("org-a")).not.toBeNull();
    }
    expect(limiter.acquire("org-a")).toBeNull();
  });
});
