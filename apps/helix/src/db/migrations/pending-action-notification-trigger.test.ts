/* Executes the `notify_pending_action_state` trigger against a live database.
 *
 * The migration tests beside this one read their own .sql and assert it
 * contains an expected substring. That is how 0083 shipped a trigger body
 * referencing `new.requester_actor_id` — a column `pending_actions` does not
 * have — and stayed green: the string was present, so the assertion passed,
 * while every INSERT raised
 *
 *   record "new" has no field "requester_actor_id"
 *
 * plpgsql resolves record field references at run time, so nothing short of
 * running the trigger can catch that class of typo. Every tool with
 * `confirmationRequired: true` writes a pending action first — 31 of them
 * across mail, drive, chat, calendar, sheets, docs, assistant, plugins and
 * auth — so the broken trigger took out every confirmation-gated write in the
 * product while the suite reported success.
 *
 * Gated on DATABASE_URL, matching the other live-Postgres suites in this repo. */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skipUnlessLiveDatabase } from "../../platform/test/live-suite.js";

const live = describe.skipIf(skipUnlessLiveDatabase("pending-action notification trigger"));

live("notify_pending_action_state trigger", () => {
  const orgId = "f7830000-0000-4000-8000-000000000001";
  const requesterId = "f7830000-0000-4000-8000-000000000011";
  const approverId = "f7830000-0000-4000-8000-000000000022";
  let sql: postgres.Sql;

  /** Inserts a pending action and returns the notification row it projected. */
  async function insertPendingAction(input: {
    readonly id: string;
    readonly approvalOwnerActorId: string | null;
  }) {
    await sql`
      insert into pending_actions (
        id, org_id, actor_id, approval_owner_actor_id, tool_id, status,
        input, expires_at, execution_idempotency_key
      )
      values (
        ${input.id}, ${orgId}, ${requesterId}, ${input.approvalOwnerActorId},
        'trigger.spec', 'pending_confirmation', ${sql.json({})},
        now() + interval '1 hour', ${`trigger-spec-${input.id}`}
      )
    `;
    const rows = await sql<{ actor_id: string; verb: string; summary: string }[]>`
      select actor_id, verb, summary
      from notifications
      where object_type = 'pending_action' and object_id = ${input.id}
    `;
    return rows;
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL ?? "", { max: 4, prepare: false });
    await sql`
      insert into orgs (id, slug, display_name)
      values (${orgId}, 'pending-action-trigger-spec', 'Pending action trigger spec')
      on conflict (id) do nothing
    `;
    await sql`
      insert into actors (id, org_id, type, email, display_name)
      values
        (${requesterId}, ${orgId}, 'user', 'requester@trigger.spec', 'Requester'),
        (${approverId}, ${orgId}, 'user', 'approver@trigger.spec', 'Approver')
      on conflict (id) do nothing
    `;
  });

  afterAll(async () => {
    await sql`delete from notifications where org_id = ${orgId}`;
    await sql`delete from pending_actions where org_id = ${orgId}`;
    await sql`delete from actors where org_id = ${orgId}`;
    await sql`delete from orgs where id = ${orgId}`;
    await sql.end();
  });

  it("inserts a pending action without raising, and notifies the requesting actor", async () => {
    const id = "f7830000-0000-4000-8000-000000000101";

    // The bug surfaced here: this INSERT raised rather than returning.
    const rows = await insertPendingAction({ id, approvalOwnerActorId: null });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_id).toBe(requesterId);
    expect(rows[0]?.verb).toBe("pending_action.pending_confirmation");
    expect(rows[0]?.summary).toBe("Action approval required");
  });

  it("notifies the approval owner instead when one is assigned", async () => {
    const id = "f7830000-0000-4000-8000-000000000102";

    const rows = await insertPendingAction({ id, approvalOwnerActorId: approverId });

    // `coalesce(approval_owner_actor_id, actor_id)` — the owner takes
    // precedence, which is the whole point of the coalesce the typo broke.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_id).toBe(approverId);
  });

  it("projects a notification for each status the lifecycle reaches", async () => {
    const id = "f7830000-0000-4000-8000-000000000103";
    await insertPendingAction({ id, approvalOwnerActorId: null });

    await sql`update pending_actions set status = 'executed' where id = ${id}`;

    const rows = await sql<{ verb: string; summary: string }[]>`
      select verb, summary from notifications
      where object_type = 'pending_action' and object_id = ${id}
      order by verb
    `;
    expect(rows.map((row) => row.verb)).toEqual([
      "pending_action.executed",
      "pending_action.pending_confirmation",
    ]);
    expect(rows.map((row) => row.summary)).toContain("Approved action completed");
  });

  it("is idempotent for a repeated status, so a no-op update adds nothing", async () => {
    const id = "f7830000-0000-4000-8000-000000000104";
    await insertPendingAction({ id, approvalOwnerActorId: null });

    // Same status again: the trigger returns early on UPDATE when the status
    // is unchanged, and the unique index absorbs anything that slips past.
    await sql`update pending_actions set status = 'pending_confirmation' where id = ${id}`;

    const rows = await sql<{ verb: string }[]>`
      select verb from notifications
      where object_type = 'pending_action' and object_id = ${id}
    `;
    expect(rows).toHaveLength(1);
  });
});
