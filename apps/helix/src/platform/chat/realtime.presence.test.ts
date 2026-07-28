import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { InMemoryChatPresenceStore, RedisChatPresenceStore } from "./realtime.js";

const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user",
  displayName: "Ada",
};
const roomId = "33333333-3333-4333-8333-333333333333";

describe("presence TTL expiry", () => {
  it("InMemoryChatPresenceStore drops entries past ttlSeconds", async () => {
    let now = 0;
    const store = new InMemoryChatPresenceStore({
      ttlSeconds: 5,
      now: () => now,
    });
    await store.touch({ roomId, actor, at: new Date(0), status: "available" });
    expect(await store.list(roomId)).toHaveLength(1);
    now = 5_001;
    expect(await store.list(roomId)).toHaveLength(0);
  });

  it("RedisChatPresenceStore treats missing actor keys as offline", async () => {
    const redis = new FakeRedis();
    const now = 1_000;
    const store = new RedisChatPresenceStore(redis, {
      ttlSeconds: 10,
      now: () => now,
    });
    await store.touch({ roomId, actor, at: new Date(now), status: "available" });
    expect(await store.list(roomId)).toHaveLength(1);
    // Simulate TTL expiry by clearing the actor key while leaving the set member.
    redis.expireAll();
    expect(await store.list(roomId)).toHaveLength(0);
  });
});

class FakeRedis {
  readonly #kv = new Map<string, string>();
  readonly #sets = new Map<string, Set<string>>();

  async set(key: string, value: string, _mode: "EX", _ttl: number): Promise<unknown> {
    this.#kv.set(key, value);
    return "OK";
  }
  async get(key: string): Promise<string | null> {
    return this.#kv.get(key) ?? null;
  }
  async del(key: string): Promise<unknown> {
    this.#kv.delete(key);
    return 1;
  }
  async sadd(key: string, member: string): Promise<unknown> {
    const set = this.#sets.get(key) ?? new Set<string>();
    set.add(member);
    this.#sets.set(key, set);
    return 1;
  }
  async srem(key: string, member: string): Promise<unknown> {
    this.#sets.get(key)?.delete(member);
    return 1;
  }
  async smembers(key: string): Promise<string[]> {
    return [...(this.#sets.get(key) ?? [])];
  }
  async expire(_key: string, _seconds: number): Promise<unknown> {
    return 1;
  }
  expireAll(): void {
    this.#kv.clear();
  }
}
