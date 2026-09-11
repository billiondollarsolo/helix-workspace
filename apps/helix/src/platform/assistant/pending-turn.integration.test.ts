import { randomUUID } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresAssistantStore } from "./store.js";

describe.skipIf(skipUnlessLiveDatabase("Assistant pending turn lookup"))(
  "native Assistant pending context",
  () => {
    const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 1 });
    const sql = tenantAwarePostgresSql(
      postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 2 }),
    );
    const orgId = randomUUID(),
      foreignOrg = randomUUID(),
      actorId = randomUUID(),
      outsiderId = randomUUID(),
      foreignActor = randomUUID();
    const store = new PostgresAssistantStore(sql);
    const actor: Actor = {
      id: actorId,
      orgId,
      type: "user",
      scopes: ["assistant.read", "assistant.write"],
    };
    const asActor = <T>(id: string, action: () => Promise<T>, tenantId = orgId) =>
      withTenantPostgresContext(sql, { orgId: tenantId, actorId: id }, action);
    beforeAll(async () => {
      await admin`insert into orgs(id,slug,display_name,status) values(${orgId},${orgId},'Pending test','active'),(${foreignOrg},${foreignOrg},'Foreign','active')`;
      for (const [id, tenant] of [
        [actorId, orgId],
        [outsiderId, orgId],
        [foreignActor, foreignOrg],
      ] as const)
        await admin`insert into actors(id,org_id,type,display_name) values(${id},${tenant},'user','Pending actor')`;
    });
    afterAll(async () => {
      await cleanupTestTenants(admin, [orgId, foreignOrg]);
      await sql.end();
      await admin.end();
    });

    it("locates an old owned pending action and its original context while excluding later and foreign histories", async () => {
      await asActor(actorId, async () => {
        const rows = await sql<{ current_user: string }[]>`select current_user`;
        expect(rows[0]?.current_user).toBe("helix_app");
      });
      const conversation = await asActor(actorId, () =>
        store.createConversation({ actor, title: "Original turn" }),
      );
      const origin = await asActor(actorId, () =>
        store.appendMessage({
          orgId,
          conversationId: conversation.id,
          actorId,
          role: "user",
          content: "Original request",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        }),
      );
      const pendingId = randomUUID();
      const settings = {
        originMessageId: origin.id,
        maxToolRounds: 16,
        usedToolRounds: 1,
        toolGroups: ["chat"],
        webSearch: false,
      };
      const assistant = await asActor(actorId, () =>
        store.appendMessage({
          orgId,
          conversationId: conversation.id,
          role: "assistant",
          content: "Approve",
          createdAt: new Date("2026-01-01T00:00:01Z"),
          metadata: {
            selectedModelId: "original-model",
            assistantTurn: settings,
            toolCalls: [{ id: "chat.write", callId: "original-native-id" }],
          },
        }),
      );
      const pending = await asActor(actorId, () =>
        store.appendMessage({
          orgId,
          conversationId: conversation.id,
          role: "tool",
          toolCallId: "original-native-id",
          content: "Pending",
          createdAt: new Date("2026-01-01T00:00:02Z"),
          metadata: { assistantTurn: settings, toolCall: { pending: { id: pendingId } } },
        }),
      );
      await admin`insert into assistant_messages(org_id,conversation_id,actor_id,role,content,metadata,created_at)
      select ${orgId},${conversation.id},${actorId},'user','Unrelated later question','{}'::jsonb,'2026-01-02'::timestamptz + n*interval '1 second' from generate_series(1,140) n`;
      const input = { orgId, actorId, conversationId: conversation.id, pendingId, limit: 24 };
      expect(
        (
          await asActor(actorId, () =>
            store.listMessages({ orgId, conversationId: conversation.id, limit: 100 }),
          )
        ).some((message) => message.id === pending.id),
      ).toBe(false);
      const context = await asActor(actorId, () => store.getPendingTurnContext(input));
      expect(context).toMatchObject({
        origin: { id: origin.id },
        assistant: { id: assistant.id, metadata: { selectedModelId: "original-model" } },
        pending: { id: pending.id, metadata: { assistantTurn: settings } },
      });
      expect(context?.history.length).toBeLessThanOrEqual(24);
      expect(
        context?.history.some((message) => message.content === "Unrelated later question"),
      ).toBe(false);
      expect(
        await asActor(outsiderId, () =>
          store.getPendingTurnContext({ ...input, actorId: outsiderId }),
        ),
      ).toBeNull();
      expect(
        await asActor(
          foreignActor,
          () => store.getPendingTurnContext({ ...input, orgId: foreignOrg, actorId: foreignActor }),
          foreignOrg,
        ),
      ).toBeNull();
      expect(
        await asActor(actorId, () =>
          store.getPendingTurnContext({ ...input, pendingId: randomUUID() }),
        ),
      ).toBeNull();
    });
  },
);
