import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "./0085_fix_pending_action_notification_requester.sql",
  import.meta.url,
);
const rollbackUrl = new URL(
  "./rollbacks/0085_fix_pending_action_notification_requester.sql",
  import.meta.url,
);

describe("0085 pending action notification requester repair", () => {
  it("uses the durable pending-action actor as the requester fallback", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("create or replace function notify_pending_action_state()");
    expect(sql).toContain("coalesce(new.approval_owner_actor_id, new.actor_id)");
    expect(sql).not.toContain("new.requester_actor_id");
    expect(sql).not.toContain("new.input");
    expect(sql).not.toContain("new.preview");
  });

  it("refuses to restore the invalid trigger body", async () => {
    const sql = await readFile(rollbackUrl, "utf8");

    expect(sql).toContain("cannot roll back 0085");
    expect(sql).toContain("nonexistent pending_actions.requester_actor_id");
  });
});
