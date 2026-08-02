import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { createToolRegistry } from "../tool-registry.js";
import { InMemoryMeetRateLimiter } from "./rate-limit.js";
import { InMemoryMeetStore, PostgresMeetStore } from "./store.js";
import { registerMeetTools } from "./tools.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const otherOrgId = "99999999-9999-4999-8999-999999999999";
const actorId = "11111111-1111-4111-8111-111111111111";
const outsiderId = "88888888-8888-4888-8888-888888888888";
const roomId = "33333333-3333-4333-8333-333333333333";

describe("Meet negative-security / tenant isolation (MT.5 / MT.6)", () => {
  it("InMemory store denies cross-tenant and non-member room access", async () => {
    const store = new InMemoryMeetStore();
    const room = await store.createRoom({
      orgId,
      actorId,
      subject: "Private sync",
      jitsiDomain: "meet.helix.test",
    });

    await expect(
      store.getRoomForActor({ orgId: otherOrgId, actorId, roomId: room.id }),
    ).resolves.toBeNull();
    await expect(
      store.getRoomForActor({ orgId, actorId: outsiderId, roomId: room.id }),
    ).resolves.toBeNull();
    await expect(
      store.getRoomById({ orgId: otherOrgId, roomId: room.id }),
    ).resolves.toBeNull();
    await expect(
      store.endRoom({ orgId: otherOrgId, actorId, roomId: room.id }),
    ).resolves.toBeNull();
    await expect(
      store.listRoomsForActor({ orgId: otherOrgId, actorId, limit: 10 }),
    ).resolves.toEqual([]);
  });

  it("Postgres getRoomForActor SQL always binds org_id and membership", async () => {
    const recording = recordingSql([[]]);
    const store = new PostgresMeetStore(recording.sql);

    await expect(
      store.getRoomForActor({ orgId, actorId, roomId }),
    ).resolves.toBeNull();

    const query = recording.calls[0] ?? "";
    expect(query).toContain("from meet_rooms");
    expect(query).toContain("r.org_id");
    expect(query).toMatch(/permissions|created_by_actor_id/);
    expect(recording.values[0]).toEqual(expect.arrayContaining([roomId, orgId, actorId]));
    expect(recording.values[0]).not.toContain(otherOrgId);
  });

  it("mint-token tool fails closed for foreign-org rooms without minting JWT", async () => {
    const store = new InMemoryMeetStore();
    const room = await store.createRoom({
      orgId,
      actorId,
      subject: "Org A room",
      jitsiDomain: "meet.helix.test",
    });
    const registry = createToolRegistry();
    registerMeetTools(registry, { store, jwtSecret: "test-secret" });

    const foreignActor: Actor = {
      id: actorId,
      orgId: otherOrgId,
      type: "user",
      scopes: ["meet.read", "meet.write"],
    };
    const result = await registry.invoke("meet.mint-token", { roomId: room.id }, {
      actor: foreignActor,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected denial");
    }
    expect(result.error).toMatch(/Unknown Meet room/i);
  });

  it("enforces create-room abuse rate limits via the tool surface", async () => {
    const store = new InMemoryMeetStore();
    const rateLimiter = new InMemoryMeetRateLimiter({
      budget: { createRoomLimit: 2, joinRoomLimit: 50, windowMs: 60_000 },
    });
    const registry = createToolRegistry();
    registerMeetTools(registry, {
      store,
      jwtSecret: "test-secret",
      rateLimiter,
    });
    const actor: Actor = {
      id: actorId,
      orgId,
      type: "user",
      scopes: ["meet.read", "meet.write"],
    };

    const first = await registry.invoke("meet.create-room", {
      subject: "Room 1",
      jitsiDomain: "meet.helix.test",
    }, { actor });
    const second = await registry.invoke("meet.create-room", {
      subject: "Room 2",
      jitsiDomain: "meet.helix.test",
    }, { actor });
    const third = await registry.invoke("meet.create-room", {
      subject: "Room 3",
      jitsiDomain: "meet.helix.test",
    }, { actor });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (third.ok) {
      throw new Error("expected rate limit");
    }
    expect(third.error).toMatch(/rate limit/i);
  });

  it("enforces join (mint-token) abuse rate limits via the tool surface", async () => {
    const store = new InMemoryMeetStore();
    const room = await store.createRoom({
      orgId,
      actorId,
      subject: "Busy room",
      jitsiDomain: "meet.helix.test",
    });
    const rateLimiter = new InMemoryMeetRateLimiter({
      budget: { createRoomLimit: 50, joinRoomLimit: 2, windowMs: 60_000 },
    });
    const registry = createToolRegistry();
    registerMeetTools(registry, {
      store,
      jwtSecret: "test-secret",
      rateLimiter,
    });
    const actor: Actor = {
      id: actorId,
      orgId,
      type: "user",
      scopes: ["meet.read", "meet.write"],
    };

    expect(
      (await registry.invoke("meet.mint-token", { roomId: room.id }, { actor })).ok,
    ).toBe(true);
    expect(
      (await registry.invoke("meet.mint-token", { roomId: room.id }, { actor })).ok,
    ).toBe(true);
    const blocked = await registry.invoke("meet.mint-token", { roomId: room.id }, { actor });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) {
      throw new Error("expected rate limit");
    }
    expect(blocked.error).toMatch(/rate limit/i);
  });
});

function recordingSql(responses: readonly unknown[][]): {
  readonly sql: postgres.Sql;
  readonly calls: string[];
  readonly values: unknown[][];
} {
  const calls: string[] = [];
  const values: unknown[][] = [];
  let responseIndex = 0;
  const tag = (async (strings: TemplateStringsArray, ...params: unknown[]) => {
    calls.push(strings.join("?"));
    values.push(params);
    return responses[responseIndex++] ?? [];
  }) as unknown as postgres.Sql;
  Object.assign(tag, {
    array: (items: readonly unknown[]) => items,
    json: (value: unknown) => value,
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
      callback(tag as unknown as postgres.TransactionSql),
  });
  return { sql: tag, calls, values };
}
