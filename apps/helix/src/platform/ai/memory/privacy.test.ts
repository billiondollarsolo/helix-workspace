import type { Actor, HelixConfig } from "@helix/sdk-types";
import { expect, it, vi } from "vitest";
import { createRecordingSql } from "../../../test-support/recording-sql.js";
import { createAssistantEmbeddingProvider } from "../providers/factory.js";
import { PostgresMemoryStore } from "./postgres.js";

const actor: Actor = { id: "member", orgId: "org", type: "user" };
const testCredential = ["api_key=sk", "live", "abcdefghijklmnop12345678"].join("_");
const config: HelixConfig = {
  security: { tier: "personal" },
  ai: {
    embeddingProvider: {
      plugin: "openai-compatible",
      config: { baseUrl: "https://embedding.example.test/v1", model: "memory", dimensions: 768 },
    },
  },
};
const response = () =>
  Response.json({ data: [{ index: 0, embedding: Array.from({ length: 768 }, () => 0.1) }] });

it("blocks restricted recall and unclassified or restricted memory storage before external embedding", async () => {
  const send = vi.fn<typeof fetch>(async () => response());
  const db = createRecordingSql();
  const memory = new PostgresMemoryStore(db.sql, {
    embeddingProvider: createAssistantEmbeddingProvider(config.ai, {}, send, config.security),
  });
  await expect(
    memory.recall(actor, "ordinary-looking query", 3, "restricted"),
  ).rejects.toMatchObject({ statusCode: 422 });
  await expect(
    memory.store(actor, { content: "ordinary text", metadata: { classification: "restricted" } }),
  ).rejects.toMatchObject({ statusCode: 422 });
  await expect(memory.store(actor, { content: "unclassified context" })).rejects.toMatchObject({
    statusCode: 422,
  });
  await expect(
    memory.store(actor, { content: "SSN 123-45-6789", metadata: { classification: "public" } }),
  ).rejects.toMatchObject({ statusCode: 422 });
  await expect(memory.recall(actor, testCredential, 3)).rejects.toMatchObject({ statusCode: 422 });
  await expect(
    memory.store(actor, {
      content: testCredential,
      metadata: { classification: "standard" },
    }),
  ).rejects.toMatchObject({ statusCode: 422 });
  await expect(
    memory.store(actor, {
      content: "ordinary text",
      metadata: { classification: "standard", effectiveClassification: "restricted" },
    }),
  ).rejects.toMatchObject({ statusCode: 422 });
  expect(send).not.toHaveBeenCalled();
  expect(db.calls).toHaveLength(0);
});

it("applies hot policy and endpoint changes to the next memory operation", async () => {
  let current = config;
  const send = vi.fn<typeof fetch>(async () => response());
  const memory = new PostgresMemoryStore(createRecordingSql().sql, {
    get embeddingProvider() {
      return createAssistantEmbeddingProvider(current.ai, {}, send, current.security);
    },
  });
  await memory.recall(actor, "ordinary query", 3, "standard");
  expect(send).toHaveBeenCalledTimes(1);
  current = {
    ...config,
    ai: { ...config.ai, privacy: { blockExternalForClassifications: ["standard"] } },
  };
  await expect(memory.recall(actor, "ordinary query", 3, "standard")).rejects.toMatchObject({
    statusCode: 422,
  });
  current = { ...config, security: { tier: "personal", overrides: { localAiOnly: true } } };
  await expect(memory.recall(actor, "ordinary query", 3)).rejects.toMatchObject({
    statusCode: 422,
  });
  current = { ...config, security: { tier: "sovereign", overrides: { localAiOnly: false } } };
  await expect(memory.recall(actor, "ordinary query", 3)).rejects.toMatchObject({
    statusCode: 422,
  });
  expect(send).toHaveBeenCalledTimes(1);
  current = {
    ...current,
    ai: {
      embeddingProvider: {
        plugin: "openai-compatible",
        config: { ...config.ai?.embeddingProvider?.config, baseUrl: "http://127.0.0.1:11435/v1" },
      },
    },
  };
  await memory.recall(actor, "ordinary query", 3, "restricted");
  expect(send).toHaveBeenCalledTimes(2);
});

it("keeps incompatible retrieval dimensions on deterministic local memory and persists its classification", async () => {
  const send = vi.fn<typeof fetch>();
  const provider = createAssistantEmbeddingProvider(
    {
      embeddingProvider: {
        plugin: "openai-compatible",
        config: {
          model: "retrieval",
          dimensions: 384,
          baseUrl: "https://embedding.example.test/v1",
        },
      },
    },
    {},
    send,
    { tier: "sovereign" },
  );
  expect((await provider.embed(["restricted context"], "restricted"))[0]).toHaveLength(768);
  const db = createRecordingSql([
    [
      {
        id: "memory",
        org_id: actor.orgId,
        actor_id: actor.id,
        content: "ordinary text",
        source: "assistant.conversation",
        metadata: { classification: "restricted" },
        score: null,
        created_at: new Date(),
        expires_at: null,
      },
    ],
  ]);
  const stored = await new PostgresMemoryStore(db.sql, { embeddingProvider: provider }).store(
    actor,
    { content: "ordinary text", metadata: { classification: "restricted" } },
  );
  expect(db.jsonValues).toContainEqual({ classification: "restricted" });
  expect(stored.metadata?.classification).toBe("restricted");
  expect(send).not.toHaveBeenCalled();
});
