import type { Actor } from "@helix/sdk-types";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AdminConsoleAuditSink } from "../admin/console-shared.js";
import { registerChatModerationRoutes, type ChatModerationStore } from "./moderation.js";

const orgId = "c1300000-0000-4000-8000-000000000001";
const actorId = "c1300000-0000-4000-8000-000000000011";
const subjectId = "c1300000-0000-4000-8000-000000000012";
const roomId = "c1300000-0000-4000-8000-000000000021";
const messageId = "c1300000-0000-4000-8000-000000000031";
const caseId = "c1300000-0000-4000-8000-000000000041";
const actor: Actor = { id: actorId, orgId, type: "user", scopes: [] };

describe("chat moderation routes", () => {
  it("uses one store and writes audit records for every mutation", async () => {
    const store = new FakeModerationStore();
    const audit = new FakeAuditSink();
    const app = Fastify();
    await registerChatModerationRoutes(app, { store, audit, actorFromRequest: () => actor });

    expect(
      await app.inject({
        method: "POST",
        url: "/api/chat/moderation/reports",
        payload: {
          roomId,
          messageId,
          subjectActorId: subjectId,
          category: "harassment",
          description: "Incident",
          evidence: { messageHash: "sha256:value" },
        },
      }),
    ).toMatchObject({ statusCode: 201 });
    await app.inject({
      method: "PUT",
      url: `/api/chat/moderation/blocks/${subjectId}`,
      payload: {},
    });
    await app.inject({ method: "DELETE", url: `/api/chat/moderation/blocks/${subjectId}` });
    await app.inject({
      method: "PUT",
      url: `/api/chat/rooms/${roomId}/moderation`,
      payload: {
        slowModeSeconds: 30,
        blockedTerms: ["spam"],
        allowedBodyFormats: ["plain"],
        allowExternalGuests: false,
      },
    });
    const queue = await app.inject({
      method: "GET",
      url: `/api/chat/moderation/queue?roomId=${roomId}`,
    });
    expect(queue.statusCode).toBe(200);
    await app.inject({
      method: "POST",
      url: `/api/chat/moderation/cases/${caseId}/actions`,
      payload: { action: "ban_actor", reason: "Policy violation", evidence: {} },
    });
    await app.inject({
      method: "POST",
      url: `/api/chat/moderation/cases/${caseId}/appeal`,
      payload: { reason: "Recovered", evidence: {} },
    });
    await app.inject({
      method: "POST",
      url: `/api/chat/moderation/cases/${caseId}/evidence`,
      payload: { evidence: { scannerVerdict: "malicious" } },
    });

    expect(store.calls.map((call) => call.operation)).toEqual([
      "report",
      "block",
      "unblock",
      "configure",
      "queue",
      "moderate",
      "appeal",
      "evidence",
    ]);
    expect(store.calls.every((call) => call.orgId === orgId && call.actorId === actorId)).toBe(
      true,
    );
    expect(audit.verbs).toEqual([
      "chat.moderation.reported",
      "chat.moderation.blocked",
      "chat.moderation.unblocked",
      "chat.moderation.controls.updated",
      "chat.moderation.ban_actor",
      "chat.moderation.appealed",
      "chat.moderation.evidence.added",
    ]);
    await app.close();
  });
});

class FakeModerationStore implements ChatModerationStore {
  readonly calls: { operation: string; orgId: string; actorId: string }[] = [];

  report(input: Parameters<ChatModerationStore["report"]>[0]) {
    this.record("report", input);
    return Promise.resolve(caseId);
  }

  setBlock(input: Parameters<ChatModerationStore["setBlock"]>[0]) {
    this.record(input.blocked ? "block" : "unblock", input);
    return Promise.resolve();
  }

  configure(input: Parameters<ChatModerationStore["configure"]>[0]) {
    this.record("configure", input);
    return Promise.resolve();
  }

  listQueue(input: Parameters<ChatModerationStore["listQueue"]>[0]) {
    this.record("queue", input);
    return Promise.resolve({ cases: [], signals: [] });
  }

  moderate(input: Parameters<ChatModerationStore["moderate"]>[0]) {
    this.record("moderate", input);
    return Promise.resolve();
  }

  appeal(input: Parameters<ChatModerationStore["appeal"]>[0]) {
    this.record("appeal", input);
    return Promise.resolve();
  }

  addEvidence(input: Parameters<ChatModerationStore["addEvidence"]>[0]) {
    this.record("evidence", input);
    return Promise.resolve();
  }

  private record(operation: string, input: { orgId: string; actorId: string }) {
    this.calls.push({ operation, orgId: input.orgId, actorId: input.actorId });
  }
}

class FakeAuditSink implements AdminConsoleAuditSink {
  readonly verbs: string[] = [];

  append(record: Parameters<AdminConsoleAuditSink["append"]>[0]) {
    this.verbs.push(record.verb);
    return Promise.resolve({ id: "audit", thisHash: "hash" });
  }
}
