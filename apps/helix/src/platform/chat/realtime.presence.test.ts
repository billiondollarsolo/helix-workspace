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

  it("does not revive removed online presence values", async () => {
    const redis = new FakeRedis();
    const store = new RedisChatPresenceStore(redis, { ttlSeconds: 10, now: () => 1_000 });
    await store.touch({ roomId, actor, at: new Date(1_000), status: "available" });
    redis.replaceActorValue(
      JSON.stringify({ ...actor, status: "online", seenAt: new Date(1_000) }),
    );

    expect(await store.list(roomId)).toEqual([]);
  });

  it("uses one atomic Redis lease set for the membership connection limit", async () => {
    const redis = new FakeRedis();
    const store = new RedisChatPresenceStore(redis, { ttlSeconds: 10, now: () => 1_000 });
    expect(
      await store.connect({
        orgId: actor.orgId,
        actorId: actor.id,
        connectionId: "one",
        limit: 1,
      }),
    ).toBe(true);
    expect(
      await store.connect({
        orgId: actor.orgId,
        actorId: actor.id,
        connectionId: "two",
        limit: 1,
      }),
    ).toBe(false);
    await store.disconnect({ orgId: actor.orgId, actorId: actor.id, connectionId: "one" });
    expect(
      await store.connect({
        orgId: actor.orgId,
        actorId: actor.id,
        connectionId: "two",
        limit: 1,
      }),
    ).toBe(true);
  });
});

class FakeRedis {
  readonly #kv = new Map<string, string>();
  readonly #sets = new Map<string, Set<string>>();
  readonly #sortedSets = new Map<string, Map<string, number>>();

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
  async sscan(key: string): Promise<[string, string[]]> {
    return ["0", await this.smembers(key)];
  }
  async expire(_key: string, _seconds: number): Promise<unknown> {
    return 1;
  }
  async eval(
    _script: string,
    _keyCount: number,
    key: string | number,
    now: string | number,
    expiresAt: string | number,
    member: string | number,
    limit: string | number,
  ): Promise<unknown> {
    const members = this.#sortedSets.get(String(key)) ?? new Map<string, number>();
    for (const [id, expiry] of members) {
      if (expiry <= Number(now)) members.delete(id);
    }
    if (!members.has(String(member)) && members.size >= Number(limit)) return 0;
    members.set(String(member), Number(expiresAt));
    this.#sortedSets.set(String(key), members);
    return 1;
  }
  async zrem(key: string, member: string): Promise<unknown> {
    return this.#sortedSets.get(key)?.delete(member) === true ? 1 : 0;
  }
  expireAll(): void {
    this.#kv.clear();
  }
  replaceActorValue(value: string): void {
    const key = [...this.#kv.keys()][0];
    if (key === undefined) throw new Error("expected an actor presence key");
    this.#kv.set(key, value);
  }
}
