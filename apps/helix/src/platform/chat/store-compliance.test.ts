import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const storeUrl = new URL("./store.ts", import.meta.url);

describe("Postgres Chat compliance invariants", () => {
  it("scopes retry dedupe by organization, room, actor, and client ID", async () => {
    const source = await readFile(storeUrl, "utf8");
    const helper = source.slice(
      source.indexOf("async function selectClientMessage"),
      source.indexOf("async function selectOwnedMessage"),
    );
    expect(helper).toContain("m.org_id = ${input.orgId}");
    expect(helper).toContain("m.thread_id = ${input.roomId}");
    expect(helper).toContain("m.actor_id = ${input.actorId}");
    expect(helper).toContain("m.metadata->>'clientMessageId' = ${input.clientMessageId}");
  });

  it("serializes legal-hold changes with mutation and retention deletion", async () => {
    const source = await readFile(storeUrl, "utf8");
    expect(source).toContain("await lockChatCompliance(tx, input.orgId)");
    expect(source).toContain("await lockChatCompliance(sql, message.orgId)");
    expect(source).toContain("coalesce(room_policy.legal_hold, false)");
    expect(source).toContain("or coalesce(org_policy.legal_hold, false)");
    expect(source).toContain(
      "(select legal_hold from chat_retention_policies\n" +
        "               where org_id = m.org_id and thread_id is null)",
    );
    expect(source).not.toContain("coalesce(room_policy.legal_hold, org_policy.legal_hold, false)");
  });

  it("keeps exports tenant-scoped and deleted content null", async () => {
    const source = await readFile(storeUrl, "utf8");
    expect(source).toContain("where m.org_id = ${input.orgId}");
    expect(source).toContain("case when m.deleted_at is null then m.body else null end as body");
    expect(source).toContain("if (roomRows.length !== roomIds.length)");
  });

  it("removes attachments and emits content-free lifecycle audits", async () => {
    const source = await readFile(storeUrl, "utf8");
    expect(source).toContain(
      "delete from message_attachments where message_id = ${input.messageId}",
    );
    for (const verb of [
      "chat.room.created",
      "chat.room.members_invited",
      "chat.room.member_removed",
      "chat.message.sent",
      "chat.message.edited",
      "chat.message.deleted",
      "chat.retention.changed",
      "chat.export.created",
    ]) {
      expect(source).toContain(`verb: "${verb}"`);
    }
  });
});
