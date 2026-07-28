import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { ChatRoomAccessError } from "./errors.js";
import { PostgresChatStore } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";

describe("Chat V2 negative-security boundary", () => {
  it("keeps non-member room list and search empty and blocks message reads and sends", async () => {
    const listSql = recordingSql([[{ "?column?": 1 }], []]);
    await expect(new PostgresChatStore(listSql.sql).listRooms({ orgId, actorId })).resolves.toEqual(
      [],
    );
    expect(listSql.calls[1]).toContain("exists");
    expect(listSql.calls[1]).toContain("p.actor_id");
    expect(listSql.calls[1]).toContain("p.org_id");

    const searchSql = recordingSql([[{ "?column?": 1 }], []]);
    await expect(
      new PostgresChatStore(searchSql.sql).search({ orgId, actorId, query: "secret" }),
    ).resolves.toEqual([]);
    expect(searchSql.calls[1]).toContain("exists");
    expect(searchSql.calls[1]).toContain("p.actor_id");
    expect(searchSql.calls[1]).toContain("p.org_id");

    const readSql = recordingSql([[]]);
    await expect(
      new PostgresChatStore(readSql.sql).listMessages({ orgId, actorId, roomId }),
    ).rejects.toBeInstanceOf(ChatRoomAccessError);
    expect(readSql.calls.some((query) => query.includes("from messages"))).toBe(false);

    const sendSql = recordingSql([[]]);
    await expect(
      new PostgresChatStore(sendSql.sql).sendMessage({
        orgId,
        actorId,
        roomId,
        body: "must not be stored",
      }),
    ).rejects.toBeInstanceOf(ChatRoomAccessError);
    expect(sendSql.calls.some((query) => query.includes("insert into messages"))).toBe(false);
  });
});

function recordingSql(responses: readonly unknown[][]): {
  readonly sql: postgres.Sql;
  readonly calls: string[];
} {
  const calls: string[] = [];
  let responseIndex = 0;
  const tag = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    calls.push(strings.join("?"));
    return responses[responseIndex++] ?? [];
  }) as unknown as postgres.Sql;
  Object.assign(tag, {
    array: (values: readonly unknown[]) => values,
    json: (value: unknown) => value,
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
      callback(tag as unknown as postgres.TransactionSql),
  });
  return { sql: tag, calls };
}
