import { randomUUID } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { tenantAwarePostgresSql } from "../tenancy/postgres-roles.js";
import { PostgresAssistantFeedbackStore } from "./message-annotations.js";

const live = !skipUnlessLiveDatabase("assistant message feedback");
describe.skipIf(!live)("assistant message feedback", () => {
  const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 1 });
  const sql = tenantAwarePostgresSql(
    postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 4 }),
  );
  const feedback = new PostgresAssistantFeedbackStore(sql);
  const orgId = randomUUID();
  const foreignOrgId = randomUUID();
  const ownerId = randomUUID();
  const colleagueId = randomUUID();
  const foreignId = randomUUID();
  const conversationId = randomUUID();
  const answerId = randomUUID();
  const questionId = randomUUID();
  const owner: Actor = { id: ownerId, orgId, type: "user", scopes: ["assistant.write"] };

  beforeAll(async () => {
    await admin`
      insert into orgs (id, slug, display_name, status) values
        (${orgId}, ${orgId}, 'Feedback', 'active'),
        (${foreignOrgId}, ${foreignOrgId}, 'Foreign', 'active')
    `;
    await admin`
      insert into actors (id, org_id, type, display_name) values
        (${ownerId}, ${orgId}, 'user', 'Owner'),
        (${colleagueId}, ${orgId}, 'user', 'Colleague'),
        (${foreignId}, ${foreignOrgId}, 'user', 'Foreign')
    `;
    await admin`
      insert into assistant_conversations (id, org_id, actor_id, title)
      values (${conversationId}, ${orgId}, ${ownerId}, 'Planning')
    `;
    await admin`
      insert into assistant_messages (id, org_id, conversation_id, actor_id, role, content) values
        (${questionId}, ${orgId}, ${conversationId}, ${ownerId}, 'user', 'What changed?'),
        (${answerId}, ${orgId}, ${conversationId}, null, 'assistant', 'The budget moved.')
    `;
  });

  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId, foreignOrgId]);
    await Promise.all([admin.end(), sql.end()]);
  });

  const rate = (
    actor: Actor,
    input: { messageId?: string; rating: "up" | "down" | null; comment?: string },
  ) =>
    feedback.setFeedback({
      actor,
      conversationId,
      messageId: input.messageId ?? answerId,
      rating: input.rating,
      comment: input.comment ?? null,
    });

  it("stores one rating per person and answer, updates it, and clears it", async () => {
    await expect(
      rate(owner, { rating: "down", comment: "  Missed the Q3 numbers " }),
    ).resolves.toMatchObject({ feedback: { rating: "down", comment: "Missed the Q3 numbers" } });
    await expect(rate(owner, { rating: "up" })).resolves.toMatchObject({
      feedback: { rating: "up", comment: null },
    });
    const listed = await feedback.listFeedback({
      actor: owner,
      messageIds: [answerId, questionId],
    });
    expect([...listed.entries()]).toEqual([
      [answerId, expect.objectContaining({ rating: "up", comment: null })],
    ]);

    await expect(rate(owner, { rating: null })).resolves.toEqual({ feedback: null });
    expect((await feedback.listFeedback({ actor: owner, messageIds: [answerId] })).size).toBe(0);

    const audit = await admin<{ verb: string; payload: Record<string, unknown> }[]>`
      select verb, payload from activity
      where org_id = ${orgId} and object_id = ${answerId}
      order by created_at, id
    `;
    expect(audit.map((row) => row.verb)).toEqual([
      "assistant.message.feedback",
      "assistant.message.feedback",
      "assistant.message.feedback.cleared",
    ]);
    expect(audit[0]?.payload).toMatchObject({ rating: "down", hasComment: true, conversationId });
    expect(JSON.stringify(audit)).not.toContain("Q3 numbers");
  });

  it("only lets the conversation owner rate its answers, never other tenants", async () => {
    await expect(rate(owner, { messageId: questionId, rating: "up" })).resolves.toBeNull();
    await expect(rate({ ...owner, id: colleagueId }, { rating: "up" })).resolves.toBeNull();
    await expect(
      rate({ ...owner, id: foreignId, orgId: foreignOrgId }, { rating: "down" }),
    ).resolves.toBeNull();

    await rate(owner, { rating: "up" });
    const foreignView = await feedback.listFeedback({
      actor: { ...owner, id: foreignId, orgId: foreignOrgId },
      messageIds: [answerId],
    });
    expect(foreignView.size).toBe(0);
    const colleagueView = await feedback.listFeedback({
      actor: { ...owner, id: colleagueId },
      messageIds: [answerId],
    });
    expect(colleagueView.size).toBe(0);
  });
});
