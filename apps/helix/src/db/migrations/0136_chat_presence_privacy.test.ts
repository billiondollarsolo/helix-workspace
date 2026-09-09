import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresChatStore } from "../../platform/chat/store.js";

const sql = readFileSync(new URL("./0136_chat_presence_privacy.sql", import.meta.url), "utf8");

describe("0136 chat presence privacy migration", () => {
  it("hides presence in both directions without exposing the block table", () => {
    expect(sql).toContain("security definer");
    expect(sql).toContain("block.blocker_actor_id = input_actor_id");
    expect(sql).toContain("block.blocked_actor_id = input_actor_id");
    expect(sql).toContain("helix_current_org_id() = input_org_id");
    expect(sql).toContain("revoke all");
  });
});

describe.skipIf(process.env.DATABASE_URL === undefined)("chat presence block privacy", () => {
  const database = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const store = new PostgresChatStore(database);
  const orgId = "f1360000-0000-4000-8000-000000000001";
  const blockerId = "f1360000-0000-4000-8000-000000000002";
  const blockedId = "f1360000-0000-4000-8000-000000000003";

  beforeAll(async () => {
    await database`
      insert into orgs (id, slug, display_name)
      values (${orgId}, 'chat-presence-privacy-test', 'Chat Presence Privacy Test')
    `;
    await database`
      insert into actors (id, org_id, type, display_name, scopes)
      values
        (${blockerId}, ${orgId}, 'user', 'Blocker', '{}'),
        (${blockedId}, ${orgId}, 'user', 'Blocked', '{}')
    `;
    await database`
      insert into chat_user_blocks (org_id, blocker_actor_id, blocked_actor_id)
      values (${orgId}, ${blockerId}, ${blockedId})
    `;
  });

  afterAll(async () => {
    await database`delete from orgs where id = ${orgId}`;
    await database.end();
  });

  it("hides a blocker from the blocked viewer despite owner-only block-table RLS", async () => {
    const hidden = await store.withActorContext({ orgId, actorId: blockedId }, (scoped) => {
      const listBlocked = scoped.listPresenceBlockedActorIds;
      if (listBlocked === undefined) throw new Error("Presence privacy query is required.");
      return listBlocked({
        orgId,
        actorId: blockedId,
        candidateActorIds: [blockerId],
      });
    });
    expect(hidden).toEqual([blockerId]);
  });
});
