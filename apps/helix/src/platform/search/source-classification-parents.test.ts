import type { DataClassification, JsonObject } from "@helix/sdk-types";
import { expect, it, vi } from "vitest";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import { chatRecordToIndexDocument } from "../chat/search/indexer.js";
import { SemanticSearchRuntime } from "./semantic-runtime.js";
import type { IndexDocument } from "./types.js";

const orgId = "00000000-0000-4000-8000-000000000100";
const actorId = "00000000-0000-4000-8000-000000000101";
const request = { query: "release plan", forOrgId: orgId, forActorId: actorId };
const cases: readonly {
  type: string;
  attributes: JsonObject;
  resourceType: string;
  resourceId: string;
}[] = [
  {
    type: "chat",
    attributes: { messageId: "message", roomId: "room" },
    resourceType: "chat.room",
    resourceId: "room",
  },
  {
    type: "chat",
    attributes: { messageId: "message", roomId: "room" },
    resourceType: "thread",
    resourceId: "room",
  },
  {
    type: "mail",
    attributes: { messageId: "message", threadId: "thread" },
    resourceType: "mail.thread",
    resourceId: "thread",
  },
  {
    type: "mail",
    attributes: { messageId: "message", threadId: "thread" },
    resourceType: "thread",
    resourceId: "thread",
  },
  {
    type: "drive",
    attributes: { fileId: "file", parentFolderId: "folder" },
    resourceType: "folder",
    resourceId: "folder",
  },
];

it.each(cases)(
  "keeps the current $resourceType label as a floor for $type retrieval",
  async ({ type, attributes, resourceType, resourceId }) => {
    const current: IndexDocument = {
      id: `${type}:source`,
      type,
      body: "Plan the release on Friday.",
      attributes: { orgId, ...attributes, classification: "standard" },
    };
    const get = vi.fn(async (ref: { orgId: string; resourceType: string; resourceId: string }) =>
      ref.resourceType === resourceType && ref.resourceId === resourceId
        ? {
            ...ref,
            classification: "restricted" as DataClassification,
            source: "explicit" as const,
            reason: "parent floor",
            updatedAt: "2026-09-10T12:00:00.000Z",
          }
        : null,
    );
    const runtime = new SemanticSearchRuntime({
      sql: createRecordingSql().sql,
      getConfig: () => ({ security: { tier: "personal" } }),
      classifications: { get },
      resolveDocument: async () => current,
    });
    const result = await runtime.classifyHit(request, {
      ...current,
      body: "stale harmless snippet",
      attributes: { orgId, classification: "standard" },
    });
    expect(result?.body).toBe(current.body);
    expect(result?.attributes?.classification).toBe("restricted");
    expect(get).toHaveBeenCalledWith({ orgId, resourceType, resourceId });
  },
);

it("uses the refreshed parent instead of an index's old folder and scans beyond the preview", async () => {
  const calls: string[] = [];
  const current: IndexDocument = {
    id: "drive:file",
    type: "drive",
    body: `${"ordinary text ".repeat(300)}\nClassification: export controlled`,
    attributes: { orgId, fileId: "file", parentFolderId: "current-folder" },
  };
  const runtime = new SemanticSearchRuntime({
    sql: createRecordingSql().sql,
    getConfig: () => ({ security: { tier: "personal" } }),
    classifications: {
      get: async (ref) => {
        calls.push(ref.resourceId);
        return null;
      },
    },
    resolveDocument: async () => current,
  });
  const result = await runtime.classifyHit(request, {
    ...current,
    body: "stale snippet",
    attributes: { orgId, fileId: "file", parentFolderId: "old-folder" },
  });
  expect(calls).toContain("current-folder");
  expect(calls).not.toContain("old-folder");
  expect(result?.attributes?.classification).toBe("restricted");
});

it("ignores typed Chat participant/reaction UUIDs while still classifying a real SSN", async () => {
  const runtime = new SemanticSearchRuntime({
    sql: createRecordingSql().sql,
    getConfig: () => ({ security: { tier: "personal" } }),
    classifications: { get: async () => null },
  });
  const document = (body: string) =>
    chatRecordToIndexDocument({
      id: "message",
      orgId,
      roomId: "00000000-0000-4000-8000-000000000201",
      body,
      author: { id: actorId },
      mentions: [{ id: "00000000-0000-4000-8000-000000000102" }],
      reactions: [{ actorId: "00000000-0000-4000-8000-000000000103", emoji: "👍" }],
      createdAt: "2026-09-10T12:00:00.000Z",
      allowedActorIds: [actorId],
    });
  expect(
    (await runtime.classifyHit(request, document("Good plan for Friday")))?.attributes
      ?.classification,
  ).toBe("standard");
  expect(
    (await runtime.classifyHit(request, document("SSN 123-45-6789")))?.attributes?.classification,
  ).toBe("confidential");
});
