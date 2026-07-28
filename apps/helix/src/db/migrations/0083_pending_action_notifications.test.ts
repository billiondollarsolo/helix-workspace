import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("./0083_pending_action_notifications.sql", import.meta.url);
const rollbackUrl = new URL("./rollbacks/0083_pending_action_notifications.sql", import.meta.url);

describe("0083 pending action notifications migration", () => {
  it("projects required lifecycle states transactionally and idempotently", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("after insert or update of status on pending_actions");
    expect(sql).toContain("'pending_confirmation', 'executed', 'failed', 'cancelled', 'expired'");
    expect(sql).toContain("coalesce(new.approval_owner_actor_id, new.requester_actor_id)");
    expect(sql).toContain("notifications_pending_action_state_idx");
    expect(sql).toContain("on conflict (org_id, actor_id, verb, object_type, object_id)");
    expect(sql).not.toContain("new.input");
    expect(sql).not.toContain("new.preview");
  });

  it("removes only the pending-action notification projection", async () => {
    const sql = await readFile(rollbackUrl, "utf8");

    expect(sql).toContain("drop trigger if exists pending_actions_notify_state");
    expect(sql).toContain("drop function if exists notify_pending_action_state");
    expect(sql).toContain("drop index if exists notifications_pending_action_state_idx");
  });
});
