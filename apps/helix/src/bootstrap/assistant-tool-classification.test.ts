import { expect, it, vi } from "vitest";
import type { Actor, LLMProviderCapability, ToolDefinition } from "@helix/sdk-types";
import type { ResourceClassificationService } from "../platform/ai/classification/index.js";
import { AIClassificationBlockedError, AIRouter } from "../platform/ai/routing.js";
import { AssistantOrchestrator } from "../platform/assistant/orchestrator.js";
import { InMemoryAssistantStore } from "../platform/assistant/store.js";
import { AllowAllToolAccessPolicy } from "../platform/permissions/tool-access.js";
import { createToolRegistry } from "../platform/tool-registry.js";
import { createAssistantToolResultClassifier } from "./assistant-tool-classification.js";

const actor: Actor = {
  id: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000002",
  type: "user",
  scopes: ["chat.read", "mail.read", "drive.read"],
};
const roomId = "00000000-0000-4000-8000-000000000003";
const fileId = "00000000-0000-4000-8000-000000000004";
const messageId = "00000000-0000-4000-8000-000000000005";
const at = "2026-09-10T12:00:00.000Z";
const room = {
  id: roomId,
  orgId: actor.orgId,
  kind: "chat_room",
  subject: "Launch plans",
  createdByActorId: actor.id,
  metadata: {},
  members: [],
  createdAt: at,
  updatedAt: at,
};
const file = {
  id: fileId,
  type: "file",
  name: "Plan.md",
  folderId: null,
  ownerActorId: actor.id,
  metadata: {},
  deletedAt: null,
  createdAt: at,
  updatedAt: at,
};
const message = {
  id: messageId,
  orgId: actor.orgId,
  roomId,
  actorId: actor.id,
  body: "Review the launch plan",
  bodyFormat: "plain",
  metadata: {},
  sentAt: at,
  editedAt: null,
  deletedAt: null,
  createdAt: at,
  updatedAt: at,
};
function setup() {
  const get = vi.fn<ResourceClassificationService["get"]>().mockResolvedValue(null);
  return { get, classify: createAssistantToolResultClassifier({ get }) };
}

it("derives known room lists from returned metadata/content and rejects unknown or malformed shapes", async () => {
  const { classify, get } = setup();
  await expect(
    classify({ actor, toolId: "chat.room.list", output: { rooms: [room] } }),
  ).resolves.toBe("standard");
  await expect(classify({ actor, toolId: "chat.room.list", output: { rooms: [] } })).resolves.toBe(
    "standard",
  );
  await expect(
    classify({ actor, toolId: "unknown.read", output: { classification: "public" } }),
  ).resolves.toBe("restricted");
  await expect(
    classify({ actor, toolId: "chat.room.list", output: { rooms: [{}] } }),
  ).resolves.toBe("restricted");
  await expect(
    classify({
      actor,
      toolId: "chat.room.list",
      output: { rooms: [{ ...room, orgId: actor.id }] },
    }),
  ).resolves.toBe("restricted");
  expect(get.mock.calls.every(([ref]) => ref.orgId === actor.orgId)).toBe(true);
});

it("keeps the maximum across resource metadata, label derivation, and actual content", async () => {
  const { classify } = setup();
  await expect(
    classify({
      actor,
      toolId: "chat.room.list",
      output: {
        rooms: [{ ...room, metadata: { classification: "public" }, subject: "SSN 123-45-6789" }],
      },
    }),
  ).resolves.toBe("confidential");
  await expect(
    classify({
      actor,
      toolId: "drive.list",
      output: {
        entries: [file, { ...file, metadata: { sensitivityLabel: { key: "restricted" } } }],
        nextCursor: null,
      },
    }),
  ).resolves.toBe("restricted");
  await expect(
    classify({
      actor,
      toolId: "mail.thread.get",
      output: {
        thread: {
          id: roomId,
          subject: "Budget",
          preview: "Plan",
          labels: ["legal"],
          messages: [{ id: messageId, body: "Review", attachments: [] }],
        },
      },
    }),
  ).resolves.toBe("confidential");
});

it("scans additional returned fields even when resource schemas do not select them", async () => {
  const { classify } = setup();
  await expect(
    classify({
      actor,
      toolId: "chat.room.list",
      output: {
        rooms: [{ ...room, extra: "Export controlled document" }],
      },
    }),
  ).resolves.toBe("restricted");
  await expect(
    classify({
      actor,
      toolId: "chat.room.list",
      output: {
        rooms: [],
        metadata: { classification: "restricted" },
      },
    }),
  ).resolves.toBe("restricted");
});

it("distinguishes Chat access privacy from sensitive content and durable classification", async () => {
  const { classify, get } = setup();
  const settings = {
    threadId: roomId,
    orgId: actor.orgId,
    name: "Launch plans",
    topic: null,
    privacy: "restricted",
    readReceiptsEnabled: true,
    metadata: {},
    createdAt: at,
    updatedAt: at,
  };
  const output = { rooms: [{ ...room, settings }] };
  await expect(classify({ actor, toolId: "chat.room.list", output })).resolves.toBe("standard");
  await expect(classify({ actor, toolId: "chat.room.discover", output })).resolves.toBe("standard");
  await expect(
    classify({
      actor,
      toolId: "chat.room.list",
      output: {
        rooms: [{ ...room, settings: { ...settings, topic: "Restricted project details" } }],
      },
    }),
  ).resolves.toBe("restricted");
  await expect(
    classify({
      actor,
      toolId: "chat.room.list",
      output: {
        rooms: [{ ...room, settings, metadata: { privacy: "restricted" } }],
      },
    }),
  ).resolves.toBe("restricted");
  get.mockImplementation(async (ref) =>
    ref.resourceId === roomId
      ? {
          ...ref,
          classification: "restricted",
          source: "explicit",
          reason: "operator label",
          updatedAt: at,
        }
      : null,
  );
  await expect(classify({ actor, toolId: "chat.room.list", output })).resolves.toBe("restricted");
});

it.each([
  [
    "chat.search",
    {
      hits: [
        { roomId, messageId, actorId: actor.id, subject: "Launch", preview: "Plan", sentAt: at },
      ],
    },
    "chat.room",
    roomId,
  ],
  [
    "drive.search",
    {
      hits: [
        {
          objectId: fileId,
          name: "Plan.md",
          mimeType: "text/markdown",
          byteSize: 10,
          sha256: null,
          folderId: null,
          preview: "Plan",
          updatedAt: at,
        },
      ],
    },
    "drive.file",
    fileId,
  ],
  [
    "chat.message.list",
    { messages: [{ ...message, attachmentObjectIds: [fileId] }] },
    "drive.file",
    fileId,
  ],
  [
    "mail.search",
    { hits: [{ threadId: roomId, messageId, subject: "Launch", snippet: "Plan", sentAt: at }] },
    "mail.message",
    messageId,
  ],
] as const)(
  "does not lower durable source labels through sibling projection %s",
  async (toolId, output, resourceType, resourceId) => {
    const { classify, get } = setup();
    get.mockImplementation(async (ref) =>
      ref.resourceType === resourceType && ref.resourceId === resourceId
        ? {
            ...ref,
            classification: "restricted",
            source: "explicit",
            reason: "operator label",
            updatedAt: at,
          }
        : null,
    );
    await expect(classify({ actor, toolId, output })).resolves.toBe("restricted");
  },
);

it.each([
  ["chat.room.discover", { rooms: [room] }],
  ["chat.thread.list", { messages: [message] }],
  ["drive.list", { entries: [file], nextCursor: null }],
  ["mail.thread.get", { thread: null }],
  [
    "mail.threads.list",
    {
      threads: [
        {
          threadId: roomId,
          messageId,
          subject: "Launch",
          from: "Samara",
          fromEmail: "samara@example.test",
          preview: "Plan",
          time: at,
          unread: true,
          starred: false,
          hasAttachment: false,
          messageCount: 1,
          labels: [],
          category: "primary",
          folder: "inbox",
          snoozedUntil: null,
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    },
  ],
] as const)("classifies the supported read shape %s", async (toolId, output) => {
  await expect(setup().classify({ actor, toolId, output })).resolves.toBe("standard");
});

function assistantSetup(restricted: boolean) {
  const { classify, get } = setup();
  if (restricted)
    get.mockImplementation(async (ref) =>
      ref.resourceId === roomId
        ? {
            ...ref,
            classification: "restricted",
            source: "explicit",
            reason: "operator label",
            updatedAt: at,
          }
        : null,
    );
  const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
  const schema = {
    parse: (value: unknown) => value,
    toJsonSchema: () => ({ type: "object" as const }),
  };
  tools.register({
    id: "chat.room.list",
    description: "List visible rooms",
    permission: "chat.read",
    sideEffects: "read",
    inputSchema: schema,
    outputSchema: schema,
    handler: async () => ({ rooms: [room] }),
  } satisfies ToolDefinition);
  const chat = vi
    .fn<LLMProviderCapability["chat"]>()
    .mockResolvedValueOnce({
      message: "",
      providerId: "external",
      model: "test",
      toolCalls: [{ id: "chat.room.list", callId: "native-call", input: {} }],
    })
    .mockResolvedValue({
      message: "Launch plans is available.",
      providerId: "external",
      model: "test",
    });
  const provider: LLMProviderCapability = {
    id: "external",
    protocol: "openai-compatible",
    tags: ["external", "admin-allowlisted"],
    chat,
    models: async () => [{ id: "test" }],
    countTokens: async () => 1,
  };
  const store = new InMemoryAssistantStore();
  const assistant = new AssistantOrchestrator({
    store,
    tools,
    classifyToolResult: classify,
    listModels: async () => ({
      models: [{ id: "external/test", label: "Test", providerId: "external", model: "test" }],
      defaultModelId: "external/test",
    }),
    ai: new AIRouter({ providers: [provider], policy: { defaultProviderId: "external" } }),
  });
  return { assistant, store, chat, get };
}

it("completes a native read turn and records server classification in result and tool history", async () => {
  const { assistant, chat } = assistantSetup(false);
  const turn = await assistant.sendMessage({ actor, content: "List rooms" });
  expect(chat).toHaveBeenCalledTimes(2);
  expect(turn.toolCalls[0]).toMatchObject({
    toolCallId: "native-call",
    classification: "standard",
  });
  expect(turn.messages.find((entry) => entry.role === "tool")?.metadata).toMatchObject({
    effectiveClassification: "standard",
  });
  await expect(
    assistant.sendMessage({ actor, conversationId: turn.conversation.id, content: "Continue" }),
  ).resolves.toMatchObject({ effectiveClassification: "standard" });
});

it("blocks restricted data before a second provider call and retains that maximum in later history", async () => {
  const { assistant, store, chat, get } = assistantSetup(true);
  await expect(assistant.sendMessage({ actor, content: "List rooms" })).rejects.toBeInstanceOf(
    AIClassificationBlockedError,
  );
  expect(chat).toHaveBeenCalledTimes(1);
  const {
    items: [conversation],
  } = await store.listConversations({ actorId: actor.id, orgId: actor.orgId, limit: 10 });
  expect(conversation).toBeDefined();
  const messages = await store.listMessages({
    orgId: actor.orgId,
    conversationId: conversation?.id ?? "",
  });
  expect(messages.find((entry) => entry.role === "tool")?.metadata).toMatchObject({
    effectiveClassification: "restricted",
  });
  get.mockResolvedValue(null);
  await expect(
    assistant.sendMessage({
      actor,
      conversationId: conversation?.id ?? "",
      content: "Try again",
      classification: "public",
    }),
  ).rejects.toBeInstanceOf(AIClassificationBlockedError);
  expect(chat).toHaveBeenCalledTimes(1);
});
