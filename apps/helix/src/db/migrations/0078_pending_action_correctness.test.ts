import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("./0078_pending_action_correctness.sql", import.meta.url);
const rollbackUrl = new URL("./rollbacks/0078_pending_action_correctness.sql", import.meta.url);

describe("0078 pending action correctness migration", () => {
  it("adds delegated identity, immutable input, policy and execution lease fields", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    for (const required of [
      "requester_credential_id",
      "requester_principal",
      "approval_owner_actor_id",
      "approver_actor_id",
      "execution_actor_id",
      "input_hash",
      "policy_snapshot",
      "policy_version",
      "preview",
      "execution_lease_expires_at",
      "execution_attempts",
      "execution_idempotency_key",
    ]) {
      expect(sql).toContain(required);
    }
    expect(sql).toContain("rename value 'confirmed' to 'approved'");
    expect(sql).toContain("add value if not exists 'executing'");
    expect(sql).toContain("pending_actions_execution_idempotency_idx");
    expect(sql).toContain("pending_actions_execution_recovery_idx");
  });

  it("guards destructive rollback behind worker-stop, backup, and evidence checks", async () => {
    const sql = await readFile(rollbackUrl, "utf8");

    expect(sql).toContain("helix.pending_workers_stopped");
    expect(sql).toContain("helix.pending_actions_backup_verified");
    expect(sql).toContain("helix.allow_destructive_pending_action_rollback");
    expect(sql).toContain("execution_attempts > 0");
    expect(sql).toContain("restore backup instead");
    expect(sql.indexOf("raise exception")).toBeLessThan(
      sql.indexOf("drop column if exists execution_idempotency_key"),
    );
  });
});
